/**
 * everesto deploy — CD for an existing CI application (maintainers / owners; delete = owners).
 *
 * Flow (decided 2026-11-14):
 *   createDeployment → 1. Infisical FIRST: project <repo>-gitops (one per application) with the app's secrets
 *                         in dev, identity eso-<repo> (viewer). Not connected / fails → nothing is created.
 *                      2. public repo <repo>-gitops: apps/dev (+ argocd/argocd.yaml, argocd/secret-stores.yaml)
 *                      3. catalog Resource <repo>-gitops in the app's catalog-info.yaml
 *   deploy(tag)       → commit the chosen image tag into apps/dev. CI NEVER deploys.
 *   promote           → PR in <repo>-gitops: prod tag := dev tag. First promote also creates apps/prod,
 *                       the prod secrets in Infisical <repo>-gitops (same names, CHANGE_ME values) and
 *                       argocd/argocd-prod.yaml.
 *   deleteDeployment  → deletes <repo>-gitops, catalog Resource, Infisical project <repo>-gitops + identity eso-<repo>.
 *                       Kept: ghcr.io images, cluster secret infisical-<repo>-auth.
 * Every ArgoCD sync is MANUAL. Backstage writes git only; ArgoCD creates the cluster objects (app-of-apps).
 *
 * Split: everestoManifests (pure YAML) · everestoInfisical · everestoRunbook · everestoTenants · this file = the flows.
 */
import { DeploymentInput, NS_KEY, Env, NAME, appProject, application, deployment, devHost, err, externalSecret, header, ingress, kustomization, namespace, ns, roleBinding, secretStore, service } from './everestoManifests';
import { infisical, infisicalDelete, infisicalSetup } from './everestoInfisical';
import { applySecretsCmd, mkdocs, runbook } from './everestoRunbook';
import { PLATFORM_FILES, PLATFORM_REPO, nsKeyFree, nsKeyOf, platformStore, rotateEsoLogin, tenantYaml, writeTenant } from './everestoTenants';
import { Config } from '@backstage/config';
import { component, findDoc, infisicalStore, kustomizeTag, setKustomizeTag } from './everestoYaml';
import { gh, githubToken } from './everestoActions';
import { ROLE } from './everestoRoles';
import { argoApp } from './everestoK8s';
import { OWNER, PROTECTED_SYSTEMS, allowed, isProtected, appInfo, commit, readFile } from './everestoManage';

// public API of the deployment modules (callers import from here)
export { NS_KEY, devHost, ns } from './everestoManifests';
export type { DeploymentInput } from './everestoManifests';
export { applySecretsCmd, setupCommands } from './everestoRunbook';
export type { SetupStep } from './everestoRunbook';
export { nsKeyOf, removeTenant } from './everestoTenants';
export { infisicalDelete } from './everestoInfisical';

// ---------- helpers ----------

async function requireDeployment(token: string, repo: string) {
  const gitops = `${repo}-gitops`;
  const dev = await readFile(token, gitops, 'apps/dev/kustomization.yaml');
  if (!dev) throw err(404, `${repo} has no deployment (${gitops})`);
  return { gitops, dev, prod: await readFile(token, gitops, 'apps/prod/kustomization.yaml') };
}
const tagOf = kustomizeTag;

/** Last successful main builds = images that exist in ghcr.io (CI keeps the last 5). */
export async function builds(config: Config, repo: string) {
  const token = await githubToken(config, OWNER);
  const runs = await gh(token, 'GET', `/repos/${OWNER}/${repo}/actions/runs?branch=main&status=success&per_page=20`);
  return ((runs.json?.workflow_runs ?? []) as any[])
    .filter(r => r.name === 'CI' && r.event !== 'pull_request')
    .slice(0, 5)
    .map(r => ({ tag: `sha-${String(r.head_sha).slice(0, 7)}`, at: r.created_at as string, title: r.display_title as string, url: r.html_url as string }));
}

// ---------- create ----------

export async function createDeployment(config: Config, repo: string, d: DeploymentInput, refs: string[], who: string) {
  const token = await githubToken(config, OWNER);
  const { info, project } = await appInfo(token, repo);
  if (!allowed(refs, project, [...ROLE.CREATE])) throw err(403, `only maintainers/managers of ${project} can create deployments`);
  const image = component(info)?.annotations['everesto.live/image'];
  if (!image) throw err(409, `${repo} builds no image — CD needs a CI application with an image`);
  for (const x of [...d.secrets, ...d.config]) if (!NAME.test(x.name)) throw err(400, `invalid variable name ${x.name} (A-Z 0-9 _)`);
  if (!(d.port > 0 && d.port < 65536) || !(d.memoryMi >= 64 && d.memoryMi <= 1024) || !(d.replicas >= 1 && d.replicas <= 3)) {
    throw err(400, 'port 1-65535, memory 64-1024 Mi, replicas 1-3');
  }
  if (d.healthPath && !/^\/[A-Za-z0-9/_.-]{0,100}$/.test(d.healthPath)) throw err(400, 'health path must look like /health');
  const nsKey = (d.nsKey || repo.split('-')[0]).toLowerCase();
  if (!NS_KEY.test(nsKey)) throw err(400, 'namespace name: a-z 0-9 - (max 42), e.g. python');
  const gitops = `${repo}-gitops`;
  if ((await gh(token, 'GET', `/repos/${OWNER}/${gitops}`)).status !== 404) throw err(409, `${gitops} already exists — delete the deployment first`);
  if (!(await nsKeyFree(token, nsKey, repo))) throw err(409, `namespace dev-${nsKey} / prod-${nsKey} is already used or reserved — choose another short name`);
  const [last] = await builds(config, repo);
  if (!last) throw err(409, `${repo} has no successful build on main yet — no image to deploy`);

  // 1. Infisical FIRST — if this fails nothing else is created
  const inf = await infisicalSetup(config, repo, 'dev', d.secrets);
  const done = [`Infisical project ${inf.project} / dev: ${d.secrets.length} secret(s)${d.secrets.some(s => !s.value) ? ' (empty ones = CHANGE_ME, set them in Infisical)' : ''}`];

  // 2. gitops repo (public: no secret values inside)
  const created = await gh(token, 'POST', `/orgs/${OWNER}/repos`, {
    name: gitops, visibility: 'public', auto_init: true, has_wiki: false, description: `CD (ArgoCD) of ${repo} — apps/dev, apps/prod`,
  });
  if (!created.ok) throw new Error(`GitHub: cannot create ${gitops} (${created.status})`);
  await gh(token, 'PUT', `/repos/${OWNER}/${gitops}/topics`, { names: [project, 'everesto', 'gitops'] });
  await gh(token, 'PATCH', `/repos/${OWNER}/${gitops}`, {
    security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } },
  });
  await commit(token, gitops, `CD for ${repo}: apps/dev (Backstage, by ${who})`, [
    { path: 'apps/dev/kustomization.yaml', content: kustomization(image, last.tag, nsKey, 'dev', d.publicUrl !== false) },
    ...(d.publicUrl !== false ? [{ path: 'apps/dev/ingress.yaml', content: ingress(repo) }] : []),
    { path: 'apps/dev/namespace.yaml', content: namespace(project, nsKey, 'dev') },
    { path: 'apps/dev/rolebinding-backstage.yaml', content: roleBinding(repo) },
    { path: 'apps/dev/deployment.yaml', content: deployment(repo, image, project, 'dev', d) },
    { path: 'apps/dev/service.yaml', content: service(repo, d.port) },
    { path: 'apps/dev/externalsecret.yaml', content: externalSecret(repo, project, 'dev') },
    { path: 'argocd/argocd.yaml', content: `${header('argocd.yaml', gitops)}${appProject(project, [ns(nsKey, 'dev'), ns(nsKey, 'prod')])}---\n${application(repo, project, 'dev', nsKey)}` },
    { path: 'argocd/secret-stores.yaml', content: `${header('secret-stores.yaml', gitops, `# needs secret infisical-${repo}-auth in namespace external-secrets\n`)}${secretStore(repo, project, 'dev', inf.projectSlug, inf.url, nsKey)}` },
    { path: 'deployment.json', content: `${JSON.stringify({ nsKey, port: d.port, memoryMi: d.memoryMi, replicas: d.replicas, healthPath: d.healthPath, publicUrl: d.publicUrl !== false, config: d.config, secrets: d.secrets.map(s => s.name) }, null, 2)}\n` },
    { path: 'docs/index.md', content: runbook(repo, project, false, nsKey) },
    { path: 'mkdocs.yml', content: mkdocs(repo) },
    { path: 'README.md', content: `# ${gitops}\n\nRunbook: docs/index.md (Tech Docs tab in Backstage).\n\nCD of [${repo}](https://github.com/${OWNER}/${repo}) (project **${project}**), managed by Backstage.\n\n- **dev** (\`apps/dev\`, ns \`${ns(project, 'dev')}\`): Backstage "Deploy" sets the image tag → Sync in ArgoCD.\n- **prod** (\`apps/prod\`, ns \`${ns(project, 'prod')}\`): created by the first "Promote to prod" (PR) → Sync in ArgoCD.\n- Secrets: Infisical project \`${gitops}\` (dev / prod), via ESO. Never in this repo.\n` },
  ]);
  done.push(`repo ${OWNER}/${gitops} (apps/dev, image ${last.tag})${d.publicUrl !== false ? ` — URL https://${devHost(repo)} after Sync` : ''}`);

  // 3. catalog: Resource <repo>-gitops next to the CI component
  await commit(token, repo, `cd: ${gitops} (Backstage, by ${who})`, [{
    path: 'catalog-info.yaml',
    content: `${info.trimEnd()}\n---\napiVersion: backstage.io/v1alpha1\nkind: Resource\nmetadata:\n  name: ${gitops}\n  description: CD of ${repo} — ArgoCD dev-${repo} (manual sync), prod via Promote\n  annotations:\n    github.com/project-slug: ${OWNER}/${gitops}\n    argocd/app-name: dev-${repo}\n    everesto.live/namespace: ${nsKey}\n    everesto.live/url-dev: https://${devHost(repo)}\n    backstage.io/techdocs-ref: url:https://github.com/${OWNER}/${gitops}/tree/main\nspec:\n  type: gitops\n  owner: ${project}\n  system: ${project}\n  dependsOn: [component:default/${repo}]\n`,
  }]);
  done.push('catalog entry (CD card on the Pipelines page)');

  // 4. ArgoCD objects via git (app-of-apps): login (ESO), secret store, Application <repo>-dev — no kubectl per app
  const esoSlug = await rotateEsoLogin(config, repo, who);
  await writeTenant(token, project, repo, tenantYaml(repo, project, ['dev'], inf.projectSlug, inf.url, nsKey), `tenants: ${project}/${repo} dev (Backstage, by ${who})`, inf.url, esoSlug);
  done.push(`ArgoCD app dev-${repo} + its secret store + login: committed to ${PLATFORM_REPO}/platform/tenants — ArgoCD creates them within ~3 min, then click Sync`);
  const commands: { title: string; cmd: string; secret?: boolean }[] = [];
  if (!(await argoApp('platform-tenants'))?.exists) {
    commands.push({
      title: 'ONE-TIME platform bootstrap (owner): the root app that creates every tenant app from git — not needed again',
      cmd: `sudo kubectl apply -n argocd -f https://raw.githubusercontent.com/${OWNER}/${PLATFORM_REPO}/main/platform/tenants-root.yaml`,
    });
  }
  return { done, commands, tag: last.tag, infisicalUrl: inf.projectUrl };
}

// ---------- deploy (dev) ----------

export async function deploy(config: Config, repo: string, tag: string, refs: string[], who: string) {
  const token = await githubToken(config, OWNER);
  const { project } = await appInfo(token, repo);
  if (!allowed(refs, project, [...ROLE.CREATE])) throw err(403, `only maintainers/managers of ${project} can deploy to dev`);
  if (!(await builds(config, repo)).some(b => b.tag === tag)) throw err(400, `${tag} is not one of the last successful builds`);
  const { gitops, dev } = await requireDeployment(token, repo);
  const nsKey = await nsKeyOf(token, repo, project);
  if (tagOf(dev) === tag) throw err(409, `dev already has ${tag} — click Sync in ArgoCD if it isn't running yet`);
  const sha = await commit(token, gitops, `dev: image → ${tag} (Backstage, by ${who})`,
    [{ path: 'apps/dev/kustomization.yaml', content: setKustomizeTag(dev, tag) }]);
  return {
    from: tagOf(dev), to: tag, commit: sha, argocdApp: `dev-${repo}`,
    commands: [
      { title: `1. Sync dev-${repo} (or ArgoCD UI → Sync)`, cmd: `sudo kubectl -n argocd patch application dev-${repo} --type merge -p '{"operation":{"sync":{}}}'` },
      { title: '2. Check (after ~30 s)', cmd: `sudo kubectl -n ${ns(nsKey, 'dev')} get pods,externalsecret,secret` },
    ],
  };
}

// ---------- promote ----------

export async function promote(config: Config, repo: string, refs: string[], who: string) {
  const token = await githubToken(config, OWNER);
  const { project } = await appInfo(token, repo);
  if (!allowed(refs, project, [...ROLE.PROD])) throw err(403, `only managers of ${project} can promote to prod`);
  const { gitops, dev, prod } = await requireDeployment(token, repo);
  const devTag = tagOf(dev)!;
  const nsKey = await nsKeyOf(token, repo, project);
  if (prod && tagOf(prod) === devTag) throw err(409, `prod already runs ${devTag}`);

  const files: { path: string; content: string }[] = [];
  const commands: { title: string; cmd: string }[] = [];
  if (prod) {
    files.push({ path: 'apps/prod/kustomization.yaml', content: setKustomizeTag(prod, devTag) });
  } else {
    // first promote: create prod from dev (own namespace, own secrets in Infisical prod)
    const meta = JSON.parse((await readFile(token, gitops, 'deployment.json')) ?? '{}');
    const devDep = (await readFile(token, gitops, 'apps/dev/deployment.yaml')) ?? '';
    const devSvc = (await readFile(token, gitops, 'apps/dev/service.yaml')) ?? '';
    const stores = (await readFile(token, gitops, 'argocd/secret-stores.yaml')) ?? '';
    const { slug, url } = infisicalStore(stores);
    if (!slug || !url) throw err(409, 'argocd/secret-stores.yaml is missing — cannot create prod');
    await infisicalSetup(config, repo, 'prod', ((meta.secrets ?? []) as string[]).map(n => ({ name: n })));
    files.push(
      {
        path: 'apps/prod/kustomization.yaml',
        content: dev.replace(`namespace: ${ns(nsKey, 'dev')}`, `namespace: ${ns(nsKey, 'prod')}`).replace(', ingress.yaml', '') // prod URL: later
          .split('\n').map(l => (l.includes('newTag:') ? `${l.split('#')[0].trimEnd()}   # changed by "Promote to prod" (PR) — then Sync in ArgoCD` : l)).join('\n'),
      },
      { path: 'apps/prod/deployment.yaml', content: devDep.replaceAll('everesto.live/env: dev', 'everesto.live/env: prod').replace(`${repo}-gitops / dev`, `${repo}-gitops / prod`) },
      { path: 'apps/prod/service.yaml', content: devSvc },
      { path: 'apps/prod/namespace.yaml', content: namespace(project, nsKey, 'prod') },
      { path: 'apps/prod/rolebinding-backstage.yaml', content: roleBinding(repo) },
      { path: 'apps/prod/externalsecret.yaml', content: externalSecret(repo, project, 'prod') },
      { path: 'argocd/argocd-prod.yaml', content: `${header('argocd-prod.yaml', gitops, '# AFTER the first promote PR is merged\n')}${secretStore(repo, project, 'prod', slug, url, nsKey)}---\n${application(repo, project, 'prod', nsKey)}` },
    );
    files.push({ path: 'docs/index.md', content: runbook(repo, project, true, nsKey) });
  }

  const sync = `sudo kubectl -n argocd patch application prod-${repo} --type merge -p '{"operation":{"sync":{}}}'`;
  const check = `sudo kubectl -n ${ns(nsKey, 'prod')} get pods,externalsecret,secret`;
  if (!prod) {
    commands.push(
      { title: '1. Merge the pull request on GitHub (link above)', cmd: '# GitHub → Merge pull request' },
      { title: `2. Set the real prod secrets: Backstage → ${gitops} → Secrets → prod (they are CHANGE_ME)`, cmd: '# Backstage → Secrets tab → prod' },
      { title: `3. ArgoCD app prod-${repo} appears by itself (~3 min after this promote) → Sync — creates namespace ${ns(nsKey, 'prod')}, Deployment, Service, ExternalSecret`, cmd: sync },
      { title: '4. Check (after ~30 s)', cmd: check },
    );
  } else {
    commands.push(
      { title: '1. Merge the pull request on GitHub (link above)', cmd: '# GitHub → Merge pull request' },
      { title: `2. Sync prod-${repo} (or ArgoCD UI → Sync)`, cmd: sync },
      { title: '3. Check (after ~30 s)', cmd: check },
    );
  }

  if (!prod) {
    // first promote: the prod store + Application <repo>-prod join the tenant file (ArgoCD creates them)
    const st = (await readFile(token, gitops, 'argocd/secret-stores.yaml')) ?? '';
    const { slug = '', url = '' } = infisicalStore(st);
    if (slug && url) await writeTenant(token, project, repo, tenantYaml(repo, project, ['dev', 'prod'], slug, url, nsKey), `tenants: ${project}/${repo} prod (Backstage, by ${who})`, url);
  }

  const branch = `promote-${devTag}`;
  const head = (await gh(token, 'GET', `/repos/${OWNER}/${gitops}/git/ref/heads/main`)).json.object.sha;
  // branch from CURRENT main — an old promote branch with the same name is reset (force), never reused stale
  let br = await gh(token, 'POST', `/repos/${OWNER}/${gitops}/git/refs`, { ref: `refs/heads/${branch}`, sha: head });
  if (br.status === 422) br = await gh(token, 'PATCH', `/repos/${OWNER}/${gitops}/git/refs/heads/${branch}`, { sha: head, force: true });
  if (!br.ok) throw new Error(`GitHub: cannot create branch ${branch} (${br.status})`);
  await commit(token, gitops, `prod: image → ${devTag} (promoted by ${who})`, files, branch);
  const pr = await gh(token, 'POST', `/repos/${OWNER}/${gitops}/pulls`, {
    title: `Promote ${repo} to prod: ${tagOf(prod) ?? '(new)'} → ${devTag}`, head: branch, base: 'main',
    body: `Requested in Backstage by **${who}**.\n\n${commands.map(c => `**${c.title}**\n\`\`\`\n${c.cmd}\n\`\`\``).join('\n\n')}`,
  });
  if (!pr.ok && pr.status !== 422) throw new Error(`GitHub: cannot open PR (${pr.status})`);
  return { url: pr.json?.html_url ?? `https://github.com/${OWNER}/${gitops}/pulls`, from: tagOf(prod), to: devTag, commands };
}

// ---------- delete deployment ----------

export async function deleteDeployment(config: Config, repo: string, refs: string[], who: string, unregister: (name: string) => Promise<void>) {
  const token = await githubToken(config, OWNER);
  const { info, project } = await appInfo(token, repo);
  if (PROTECTED_SYSTEMS.includes(project) || isProtected(info)) throw err(403, `${repo} is part of the platform (${project}) — it cannot be deleted from Backstage`);
  if (!allowed(refs, project, [...ROLE.CREATE])) throw err(403, `only maintainers/managers of ${project} can delete deployments`);
  const gitops = `${repo}-gitops`;
  const done: string[] = [];
  const docs = info.split(/\n---\n/);
  const kept = docs.filter(doc => !findDoc(doc, 'Resource', gitops)); // parsed — a comment mentioning it doesn't count
  const files: { path: string; content: string }[] = [];
  if (kept.length !== docs.length) files.push({ path: 'catalog-info.yaml', content: `${kept.join('\n---\n').trimEnd()}\n` });
  // legacy (before 2026-11-14 evening): CI had a "Deploy dev (ArgoCD)" stage + GITOPS_DEPLOY_KEY
  const ci = await readFile(token, repo, '.github/workflows/ci.yml');
  const legacy = /\n? {6}- name: Deploy dev \(ArgoCD\)\n(?: {8}.*\n?)*/;
  if (ci && legacy.test(ci)) files.push({ path: '.github/workflows/ci.yml', content: `${ci.replace(legacy, '').trimEnd()}\n` });
  if (files.length) {
    await commit(token, repo, `cd: ${gitops} removed (Backstage, by ${who})`, files);
    done.push(`${repo}: ${files.map(f => f.path).join(' + ')} updated`);
  }
  const sec = await gh(token, 'DELETE', `/repos/${OWNER}/${repo}/actions/secrets/GITOPS_DEPLOY_KEY`);
  if (sec.ok) done.push('secret GITOPS_DEPLOY_KEY');
  await unregister(gitops).then(() => done.push('catalog entry'), () => undefined);
  const del = await gh(token, 'DELETE', `/repos/${OWNER}/${gitops}`);
  if (del.ok) done.push(`GitHub repo ${OWNER}/${gitops}`);
  else if (del.status !== 404) throw new Error(`GitHub: cannot delete ${gitops} (${del.status})`);
  // ArgoCD objects: remove the tenant file → ArgoCD deletes the apps (pods), stores and login by itself
  await writeTenant(token, project, repo, null, `tenants: ${project}/${repo} removed (Backstage, by ${who})`, '')
    .then(() => done.push('ArgoCD apps, secret stores and ESO login: removed from git — ArgoCD deletes them within ~3 min'), () => undefined);
  const inf = await infisicalDelete(config, repo);
  done.push(...inf.done);
  return { done, warn: [...inf.warn, 'kept: the images in ghcr.io'] };
}

// ---------- new ESO login (lost / rotated) ----------

export async function newEsoLogin(config: Config, repo: string, refs: string[], who: string) {
  const token = await githubToken(config, OWNER);
  const { project } = await appInfo(token, repo);
  if (!allowed(refs, project, [...ROLE.CREATE])) throw err(403, `only maintainers/managers of ${project} can rotate ESO logins`);
  await requireDeployment(token, repo);
  const esoSlug = await rotateEsoLogin(config, repo, who);
  if (!(await readFile(token, PLATFORM_REPO, PLATFORM_FILES.store))) {
    const url = config.getString('infisical.url');
    await commit(token, PLATFORM_REPO, 'tenants: platform store for ESO logins (Backstage)', [{ path: PLATFORM_FILES.store, content: platformStore(url, esoSlug) }]);
  }
  return {
    identity: `eso-${repo}`,
    cmd: `# Rotated automatically — no command needed.
# New login stored in Infisical (platform-eso); ESO refreshes Secret infisical-${repo}-auth within 5 minutes.
# Force it now (optional): sudo kubectl -n external-secrets annotate externalsecret infisical-${repo}-auth force-sync=$(date +%s) --overwrite`,
  };
}

// ---------- secrets of a deployment (Infisical <repo>-gitops) — values are write-only ----------
// dev: developers / maintainers / owners · prod: maintainers / owners. Listing (names only): any member.

const SECRET_ROLES: Record<Env, string[]> = { dev: [...ROLE.DEV], prod: [...ROLE.PROD] }; // prod secrets: managers

async function secretsCtx(config: Config, repo: string) {
  const token = await githubToken(config, OWNER);
  const { project } = await appInfo(token, repo);
  const { api } = await infisical(config);
  const ws = ((await api('GET', '/api/v1/workspace')).json?.workspaces ?? []).find((w: any) => w.name === `${repo}-gitops`);
  if (!ws) throw err(404, `Infisical project ${repo}-gitops not found — create the deployment first`);
  return { project, api, ws, nsKey: await nsKeyOf(token, repo, project) };
}

const refresh = applySecretsCmd;

export async function secretsList(config: Config, repo: string, env: Env, refs: string[]) {
  const { project, api, ws, nsKey } = await secretsCtx(config, repo);
  if (!allowed(refs, project, [...ROLE.MEMBER])) throw err(403, `only members of ${project} can see secret names`);
  const r = await api('GET', `/api/v3/secrets/raw?workspaceId=${ws.id}&environment=${env}&secretPath=/`);
  if (!r.ok) throw err(502, `Infisical: cannot list secrets (${r.status})`);
  return {
    env,
    canEdit: allowed(refs, project, SECRET_ROLES[env]),
    // names + dates only — values never leave the backend
    secrets: ((r.json?.secrets ?? []) as any[]).map(s => ({ name: s.secretKey as string, updatedAt: (s.updatedAt ?? s.createdAt) as string, placeholder: s.secretValue === 'CHANGE_ME' }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    applyCmd: refresh(repo, nsKey, env),
    infisicalUrl: `${config.getString('infisical.url')}/project/${ws.id}/secrets/overview`,
  };
}

export async function secretSet(config: Config, repo: string, env: Env, name: string, value: string, refs: string[]) {
  if (!NAME.test(name)) throw err(400, `invalid name ${name} (A-Z 0-9 _)`);
  if (!value) throw err(400, 'value is empty');
  const { project, api, ws, nsKey } = await secretsCtx(config, repo);
  if (!allowed(refs, project, SECRET_ROLES[env])) throw err(403, `only ${SECRET_ROLES[env].join('/')} of ${project} can change ${env} secrets`);
  const body = { workspaceId: ws.id, environment: env, secretPath: '/', secretValue: value, type: 'shared' };
  let r = await api('PATCH', `/api/v3/secrets/raw/${encodeURIComponent(name)}`, body);
  if (!r.ok) r = await api('POST', `/api/v3/secrets/raw/${encodeURIComponent(name)}`, body); // new secret
  if (!r.ok) throw err(502, `Infisical: cannot save ${name} (${r.status})`);
  return { saved: name, env, applyCmd: refresh(repo, nsKey, env) };
}

export async function secretDelete(config: Config, repo: string, env: Env, name: string, refs: string[]) {
  if (!NAME.test(name)) throw err(400, `invalid name ${name}`);
  const { project, api, ws, nsKey } = await secretsCtx(config, repo);
  if (!allowed(refs, project, SECRET_ROLES[env])) throw err(403, `only ${SECRET_ROLES[env].join('/')} of ${project} can delete ${env} secrets`);
  const r = await api('DELETE', `/api/v3/secrets/raw/${encodeURIComponent(name)}`, { workspaceId: ws.id, environment: env, secretPath: '/', type: 'shared' });
  if (!r.ok) throw err(502, `Infisical: cannot delete ${name} (${r.status})`);
  return { deleted: name, env, applyCmd: refresh(repo, nsKey, env) };
}
