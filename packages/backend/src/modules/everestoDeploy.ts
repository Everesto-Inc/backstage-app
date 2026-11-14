/**
 * everesto deploy — CD for an existing CI application (maintainers / owners only).
 *
 *   createDeployment(repo)  → public repo <repo>-gitops:
 *        apps/dev/   kustomization (image + tag), deployment, service, [externalsecret]
 *        apps/prod/  same — own namespace, own tag
 *        argocd/     AppProject <project> + Applications <repo>-dev (auto-sync) / <repo>-prod (MANUAL sync)
 *                    [+ secret-stores.yaml: ClusterSecretStores for Infisical]
 *     + Deploy stage (Loop deploy-argocd → apps/dev) and deploy key in the CI repo
 *     + catalog Resource <repo>-gitops (dependsOn the CI component)
 *     + Infisical (optional): project <project>, folder /<repo> in dev + prod, machine identity
 *       eso-<project> (viewer) — its client secret is returned ONCE, never stored.
 *     Backstage has NO cluster access: it returns the kubectl commands an admin runs once.
 *
 *   promote(repo) → PR in <repo>-gitops: apps/prod tag := apps/dev tag. After merge, Sync in ArgoCD.
 */
import { Config } from '@backstage/config';
import { gh, githubToken, setRepoSecret, sshKeyPair } from './everestoActions';
import { OWNER, allowed, appInfo, commit, readFile } from './everestoManage';

const ENVS = ['dev', 'prod'] as const;
type Env = (typeof ENVS)[number];
const ns = (project: string, env: Env) => `${project}-${env}`;
const err = (status: number, message: string) => Object.assign(new Error(message), { status });

// ---------- manifests ----------

const kustomization = (image: string, tag: string, project: string, env: Env, secrets: boolean) => `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: ${ns(project, env)}
resources: [deployment.yaml, service.yaml${secrets ? ', externalsecret.yaml' : ''}]
images:
  - name: ${image}
    newTag: ${tag}   # ${env === 'dev' ? 'CI bumps this after every build on main' : 'changed only by "Promote to prod" (PR)'}
`;

const deployment = (repo: string, image: string, project: string, env: Env, port: number, secrets: boolean) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${repo}
  labels: { app: ${repo}, everesto.live/project: ${project}, everesto.live/env: ${env} }
spec:
  replicas: 1
  selector: { matchLabels: { app: ${repo} } }
  template:
    metadata:
      labels: { app: ${repo}, everesto.live/project: ${project}, everesto.live/env: ${env} }
    spec:
      nodeSelector: { everesto.live/pool: tenants }
      securityContext: { runAsNonRoot: true, seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: app
          image: ${image}
          ports: [{ containerPort: ${port} }]${secrets ? `
          envFrom:
            - secretRef: { name: ${repo}, optional: true }   # all keys of Infisical folder /${repo} (${env})` : ''}
          resources:
            requests: { cpu: 25m, memory: 96Mi }
            limits: { memory: 192Mi }
          readinessProbe: { tcpSocket: { port: ${port} }, periodSeconds: 10 }
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: [ALL] } }
`;

const service = (repo: string, port: number) => `apiVersion: v1
kind: Service
metadata:
  name: ${repo}
spec:
  selector: { app: ${repo} }
  ports: [{ port: 80, targetPort: ${port} }]
`;

const externalSecret = (repo: string, project: string, env: Env) => `# Every secret in Infisical project "${project}", env ${env}, folder /${repo} → Secret "${repo}"
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: ${repo}
spec:
  refreshInterval: 5m
  secretStoreRef: { kind: ClusterSecretStore, name: infisical-${repo}-${env} }
  target: { name: ${repo} }
  dataFrom:
    - find: { name: { regexp: ".*" } }
`;

const argocd = (repo: string, project: string, gitopsRepos: string[]) => `# Apply ONCE on the control plane (Backstage has no cluster access):
#   sudo kubectl apply -f https://raw.githubusercontent.com/${OWNER}/${repo}-gitops/main/argocd/argocd.yaml
# AppProject "${project}": only namespaces ${ns(project, 'dev')} / ${ns(project, 'prod')}, only this project's gitops repos.
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: ${project}
  namespace: argocd
spec:
  description: DevOps space ${project}
  sourceRepos:
${gitopsRepos.map(r => `    - https://github.com/${OWNER}/${r}.git`).join('\n')}
  destinations:
${ENVS.map(e => `    - { server: https://kubernetes.default.svc, namespace: ${ns(project, e)} }`).join('\n')}
  clusterResourceWhitelist:
    - { group: '', kind: Namespace }
  namespaceResourceWhitelist:
    - { group: '*', kind: '*' }
${ENVS.map(e => `---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ${repo}-${e}
  namespace: argocd
  labels: { everesto.live/project: ${project}, everesto.live/env: ${e} }
  finalizers: [resources-finalizer.argocd.argoproj.io]   # deleting the app removes its pods too
spec:
  project: ${project}
  source:
    repoURL: https://github.com/${OWNER}/${repo}-gitops.git
    targetRevision: main
    path: apps/${e}
  destination: { server: https://kubernetes.default.svc, namespace: ${ns(project, e)} }
  syncPolicy:${e === 'dev' ? `
    automated: { prune: true, selfHeal: true }   # dev: every new tag deploys by itself` : `
    # prod: NO automated sync — after "Promote to prod" is merged, click Sync in ArgoCD`}
    syncOptions: [CreateNamespace=true]
`).join('')}`;

const secretStores = (repo: string, project: string, projectSlug: string, url: string) => `# Apply ONCE (after the secret infisical-${project}-auth exists in namespace external-secrets):
#   sudo kubectl apply -f https://raw.githubusercontent.com/${OWNER}/${repo}-gitops/main/argocd/secret-stores.yaml
${ENVS.map(e => `---
apiVersion: external-secrets.io/v1
kind: ClusterSecretStore
metadata:
  name: infisical-${repo}-${e}
spec:
  conditions:
    - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: ${ns(project, e)} } }
  provider:
    infisical:
      hostAPI: ${url}
      auth:
        universalAuthCredentials:
          clientId: { name: infisical-${project}-auth, namespace: external-secrets, key: clientId }
          clientSecret: { name: infisical-${project}-auth, namespace: external-secrets, key: clientSecret }
      secretsScope: { projectSlug: ${projectSlug}, environmentSlug: ${e}, secretsPath: /${repo} }
`).join('')}`;

// ---------- Infisical ----------

type InfisicalResult = {
  connected: boolean;
  projectSlug?: string;
  projectUrl?: string;
  identity?: string;
  clientId?: string;
  clientSecret?: string; // only when newly created — shown once
  note?: string;
};

async function infisicalSetup(config: Config, project: string, repo: string): Promise<InfisicalResult> {
  const url = config.getOptionalString('infisical.url');
  const clientId = config.getOptionalString('infisical.clientId');
  const clientSecret = config.getOptionalString('infisical.clientSecret');
  const orgId = config.getOptionalString('infisical.organizationId');
  if (!url || !clientId || !clientSecret || !orgId) {
    return { connected: false, note: 'Backstage is not connected to Infisical yet (machine identity backstage-platform) — secrets part skipped' };
  }
  const login = await (await fetch(`${url}/api/v1/auth/universal-auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId, clientSecret }),
  })).json() as any;
  if (!login.accessToken) throw new Error('Infisical: login failed');
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${login.accessToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
    return { ok: res.ok, status: res.status, json };
  };

  // project
  const list = await api('GET', '/api/v1/workspace');
  let ws = (list.json?.workspaces ?? []).find((w: any) => w.name === project);
  if (!ws) {
    const created = await api('POST', '/api/v2/workspace', { projectName: project, organizationId: orgId });
    if (!created.ok) throw new Error(`Infisical: cannot create project ${project} (${created.status})`);
    ws = created.json.project ?? created.json.workspace;
  }
  // folder /<repo> in dev + prod
  for (const env of ENVS) {
    await api('POST', '/api/v1/folders', { workspaceId: ws.id, environment: env, name: repo, path: '/' });
  }
  // machine identity eso-<project> (viewer on this project only)
  const name = `eso-${project}`;
  const ids = await api('GET', `/api/v2/organizations/${orgId}/identity-memberships`);
  const existing = (ids.json?.identityMemberships ?? []).find((m: any) => m.identity?.name === name);
  const base = { connected: true, projectSlug: ws.slug, projectUrl: `${url}/project/${ws.id}/secrets/overview`, identity: name };
  if (existing) return { ...base, note: `identity ${name} already exists — its secret infisical-${project}-auth should already be on the cluster` };

  const idRes = await api('POST', '/api/v1/identities', { name, organizationId: orgId, role: 'no-access' });
  if (!idRes.ok) throw new Error(`Infisical: cannot create identity ${name} (${idRes.status})`);
  const identityId = idRes.json.identity.id;
  const ua = await api('POST', `/api/v1/auth/universal-auth/identities/${identityId}`, {});
  if (!ua.ok) throw new Error(`Infisical: cannot enable universal auth (${ua.status})`);
  const cs = await api('POST', `/api/v1/auth/universal-auth/identities/${identityId}/client-secrets`, { description: 'ESO (created by Backstage)' });
  if (!cs.ok) throw new Error(`Infisical: cannot create client secret (${cs.status})`);
  const mem = await api('POST', `/api/v2/workspace/${ws.id}/identity-memberships/${identityId}`, { role: 'viewer' });
  if (!mem.ok) throw new Error(`Infisical: cannot add ${name} to project ${project} (${mem.status})`);
  return { ...base, clientId: ua.json.identityUniversalAuth?.clientId, clientSecret: cs.json.clientSecret };
}

// ---------- create deployment ----------

export async function createDeployment(
  config: Config, repo: string, opts: { infisical: boolean }, refs: string[], who: string,
  projectGitopsRepos: (project: string) => Promise<string[]>,
) {
  const token = await githubToken(config, OWNER);
  const { info, project } = await appInfo(token, repo);
  if (!allowed(refs, project, ['owners', 'maintainers'])) throw err(403, `only owners/maintainers of ${project} can create deployments`);
  const image = info.match(/everesto\.live\/image:\s*(\S+)/)?.[1];
  if (!image) throw err(409, `${repo} builds no image — CD needs a CI application with an image`);
  let ci = await readFile(token, repo, '.github/workflows/ci.yml');
  const loop = ci?.match(/Everesto-Inc\/loop\/stages\/install@([0-9a-f]{40}) # (\S+)/);
  if (!ci || !loop) throw err(409, 'pipeline is not built on Loop');
  if (/stages\/deploy-argocd@/.test(ci)) throw err(409, `${repo} already has a deployment`);
  const gitops = `${repo}-gitops`;
  // resumable: a gitops repo created by an earlier, interrupted run is reused
  const existing = await gh(token, 'GET', `/repos/${OWNER}/${gitops}`);
  const resume = existing.ok && (await readFile(token, gitops, 'argocd/argocd.yaml')) !== undefined;
  if (existing.ok && !resume) throw err(409, `repo ${gitops} already exists and was not created by Backstage`);

  // newest image = last successful CI run on main
  const runs = await gh(token, 'GET', `/repos/${OWNER}/${repo}/actions/runs?branch=main&status=success&per_page=10`);
  const last = ((runs.json?.workflow_runs ?? []) as any[]).find(r => r.name === 'CI' && r.event !== 'pull_request');
  if (!last) throw err(409, `${repo} has no successful CI run on main yet — no image to deploy`);
  const tag = `sha-${String(last.head_sha).slice(0, 7)}`;
  const port = 8080;
  const done: string[] = [];

  const inf: InfisicalResult = opts.infisical ? await infisicalSetup(config, project, repo) : { connected: false };
  const secrets = opts.infisical && inf.connected;
  if (secrets) done.push(`Infisical project ${project}: folder /${repo} in dev + prod`);

  // 1. gitops repo (public: no secrets inside)
  if (!resume) {
  const created = await gh(token, 'POST', `/orgs/${OWNER}/repos`, {
    name: gitops, visibility: 'public', auto_init: true, has_wiki: false,
    description: `CD (ArgoCD) of ${repo} — apps/dev, apps/prod`,
  });
  if (!created.ok) throw new Error(`GitHub: cannot create ${gitops} (${created.status})`);
  await gh(token, 'PUT', `/repos/${OWNER}/${gitops}/topics`, { names: [project, 'everesto', 'gitops'] });
  await gh(token, 'PATCH', `/repos/${OWNER}/${gitops}`, {
    security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } },
  });
  const others = (await projectGitopsRepos(project)).filter(r => r !== gitops);
  const files = [
    ...ENVS.flatMap(e => [
      { path: `apps/${e}/kustomization.yaml`, content: kustomization(image, tag, project, e, secrets) },
      { path: `apps/${e}/deployment.yaml`, content: deployment(repo, image, project, e, port, secrets) },
      { path: `apps/${e}/service.yaml`, content: service(repo, port) },
      ...(secrets ? [{ path: `apps/${e}/externalsecret.yaml`, content: externalSecret(repo, project, e) }] : []),
    ]),
    { path: 'argocd/argocd.yaml', content: argocd(repo, project, [...others, gitops].sort()) },
    ...(secrets ? [{ path: 'argocd/secret-stores.yaml', content: secretStores(repo, project, inf.projectSlug!, config.getString('infisical.url')) }] : []),
    { path: 'README.md', content: `# ${gitops}\n\nCD of [${repo}](https://github.com/${OWNER}/${repo}) (project **${project}**), managed by Backstage.\n\n| env | path | namespace | sync |\n|---|---|---|---|\n| dev | apps/dev | ${ns(project, 'dev')} | automatic — CI bumps the tag |\n| prod | apps/prod | ${ns(project, 'prod')} | manual — "Promote to prod" PR, then Sync in ArgoCD |\n` },
  ];
  await commit(token, gitops, `CD for ${repo}: apps/dev + apps/prod (Backstage, by ${who})`, files);
  done.push(`repo ${OWNER}/${gitops} (apps/dev, apps/prod, argocd/) — first image ${tag}`);
  } else {
    done.push(`repo ${OWNER}/${gitops} already there — reused`);
  }

  // 2. deploy key: CI of <repo> may write ONLY to <repo>-gitops
  const title = `CI of ${repo} (tag bump)`;
  const old = await gh(token, 'GET', `/repos/${OWNER}/${gitops}/keys`);
  for (const k of (old.json ?? []) as any[]) if (k.title === title) await gh(token, 'DELETE', `/repos/${OWNER}/${gitops}/keys/${k.id}`);
  const keys = sshKeyPair(`ci-${repo}`);
  const dk = await gh(token, 'POST', `/repos/${OWNER}/${gitops}/keys`, { title, key: keys.publicOpenSsh, read_only: false });
  if (!dk.ok) {
    const why = JSON.stringify(dk.json?.errors ?? dk.json?.message ?? '');
    if (why.includes('disabled')) throw err(409, 'Deploy keys are disabled in the GitHub org — Everesto-Inc → Settings → Repository → Deploy keys: Allow, then click Create deployment again (it resumes)');
    throw new Error(`GitHub: cannot add deploy key (${dk.status} ${why})`);
  }
  await setRepoSecret(token, OWNER, repo, 'GITOPS_DEPLOY_KEY', keys.privatePem);

  // 3. CI repo: Deploy stage + catalog Resource
  const [, sha, version] = loop;
  ci = `${ci.trimEnd()}

      - name: Deploy dev (ArgoCD)
        if: github.ref == 'refs/heads/main' && github.event_name != 'pull_request'
        uses: Everesto-Inc/loop/stages/deploy-argocd@${sha} # ${version}
        with:
          deploy-key: '\${{ secrets.GITOPS_DEPLOY_KEY }}'
          gitops-repo: ${OWNER}/${gitops}
          path: apps/dev
          tag: '\${{ steps.image.outputs.tag }}'
`;
  const resource = `---
apiVersion: backstage.io/v1alpha1
kind: Resource
metadata:
  name: ${gitops}
  description: CD of ${repo} — ArgoCD ${repo}-dev (auto) / ${repo}-prod (manual)
  annotations:
    github.com/project-slug: ${OWNER}/${gitops}
    argocd/app-name: ${repo}-dev
    everesto.live/environments: dev,prod
spec:
  type: gitops
  owner: ${project}
  system: ${project}
  dependsOn: [component:default/${repo}]
`;
  await commit(token, repo, `cd: deploy to ${gitops} (Backstage, by ${who})`, [
    { path: '.github/workflows/ci.yml', content: ci },
    { path: 'catalog-info.yaml', content: `${info.trimEnd()}\n${resource}` },
  ]);
  done.push(`${repo}: Deploy stage (→ apps/dev after every build on main) + deploy key`);

  const raw = `https://raw.githubusercontent.com/${OWNER}/${gitops}/main/argocd`;
  const commands: { title: string; cmd: string; secret?: boolean }[] = [];
  if (secrets && inf.clientSecret) {
    commands.push({
      title: `Infisical login for ESO (identity ${inf.identity}) — shown ONCE, not stored anywhere`,
      secret: true,
      cmd: `sudo kubectl -n external-secrets create secret generic infisical-${project}-auth \\\n  --from-literal=clientId='${inf.clientId}' --from-literal=clientSecret='${inf.clientSecret}'`,
    });
  }
  if (secrets) commands.push({ title: 'Secret stores (dev + prod)', cmd: `sudo kubectl apply -f ${raw}/secret-stores.yaml` });
  commands.push({ title: `ArgoCD project ${project} + apps ${repo}-dev / ${repo}-prod`, cmd: `sudo kubectl apply -f ${raw}/argocd.yaml` });
  return { done, commands, infisical: inf, tag };
}

// ---------- promote ----------

export async function promote(config: Config, repo: string, refs: string[], who: string) {
  const token = await githubToken(config, OWNER);
  const { project } = await appInfo(token, repo);
  if (!allowed(refs, project, ['owners', 'maintainers'])) throw err(403, `only owners/maintainers of ${project} can promote`);
  const gitops = `${repo}-gitops`;
  const dev = await readFile(token, gitops, 'apps/dev/kustomization.yaml');
  const prod = await readFile(token, gitops, 'apps/prod/kustomization.yaml');
  if (!dev || !prod) throw err(409, `${gitops} has no apps/dev + apps/prod`);
  const tagOf = (k: string) => k.match(/newTag:\s*(\S+)/)?.[1];
  const devTag = tagOf(dev);
  if (!devTag || devTag === tagOf(prod)) throw err(409, `prod already runs ${devTag}`);
  const branch = `promote-${devTag}`;
  const head = (await gh(token, 'GET', `/repos/${OWNER}/${gitops}/git/ref/heads/main`)).json.object.sha;
  const br = await gh(token, 'POST', `/repos/${OWNER}/${gitops}/git/refs`, { ref: `refs/heads/${branch}`, sha: head });
  if (!br.ok && br.status !== 422) throw new Error(`GitHub: cannot create branch (${br.status})`);
  await commit(token, gitops, `prod: image → ${devTag} (promoted by ${who})`,
    [{ path: 'apps/prod/kustomization.yaml', content: prod.replace(/(newTag:\s*)\S+/, `$1${devTag}`) }], branch);
  const pr = await gh(token, 'POST', `/repos/${OWNER}/${gitops}/pulls`, {
    title: `Promote ${repo} to prod: ${tagOf(prod)} → ${devTag}`, head: branch, base: 'main',
    body: `Requested in Backstage by **${who}**.\n\nAfter merge: open ArgoCD → \`${repo}-prod\` → **Sync** (prod has no auto-sync).`,
  });
  if (!pr.ok && pr.status !== 422) throw new Error(`GitHub: cannot open PR (${pr.status})`);
  return { url: pr.json?.html_url ?? `https://github.com/${OWNER}/${gitops}/pulls`, from: tagOf(prod), to: devTag };
}
