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
 * Every ArgoCD sync is MANUAL. Backstage has NO cluster access: it returns kubectl commands.
 */
import { Config } from '@backstage/config';
import { gh, githubToken } from './everestoActions';
import { OWNER, allowed, appInfo, commit, readFile } from './everestoManage';

type Env = 'dev' | 'prod';
const ns = (project: string, env: Env) => `${project}-${env}`;
const err = (status: number, message: string) => Object.assign(new Error(message), { status });
const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

export type DeploymentInput = {
  secrets: { name: string; value?: string }[];
  config: { name: string; value: string }[];
  port: number;
  memoryMi: number;
  replicas: number;
  healthPath?: string; // e.g. /health → HTTP probes; empty → TCP port check
};

// ---------- manifests ----------

const kustomization = (image: string, tag: string, project: string, env: Env) => `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: ${ns(project, env)}
resources: [namespace.yaml, deployment.yaml, service.yaml, externalsecret.yaml]
images:
  - name: ${image}
    newTag: ${tag}   # ${env === 'dev' ? 'changed by "Deploy" in Backstage' : 'changed by "Promote to prod" (PR)'} — then Sync in ArgoCD
`;

const probes = (d: DeploymentInput) => (d.healthPath
  ? `          readinessProbe: { httpGet: { path: ${d.healthPath}, port: ${d.port} }, periodSeconds: 10 }
          livenessProbe: { httpGet: { path: ${d.healthPath}, port: ${d.port} }, initialDelaySeconds: 20, periodSeconds: 20, failureThreshold: 3 }`
  : `          readinessProbe: { tcpSocket: { port: ${d.port} }, periodSeconds: 10 }`);

const deployment = (repo: string, image: string, project: string, env: Env, d: DeploymentInput) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${repo}
  labels: { app: ${repo}, everesto.live/project: ${project}, everesto.live/env: ${env} }
spec:
  replicas: ${d.replicas}
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
          ports: [{ containerPort: ${d.port} }]${d.config.length ? `
          env:   # config (not secret)
${d.config.map(c => `            - { name: ${c.name}, value: ${JSON.stringify(c.value)} }`).join('\n')}` : ''}
          envFrom:
            - secretRef: { name: ${repo} }   # secrets: Infisical ${repo}-gitops / ${env} (via ESO)
          resources:
            requests: { cpu: 25m, memory: ${Math.max(32, Math.round(d.memoryMi / 2))}Mi }
            limits: { memory: ${d.memoryMi}Mi }
${probes(d)}
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: [ALL] } }
`;

// own manifest (not only CreateNamespace=true): ArgoCD skips CreateNamespace on partial syncs
const namespace = (project: string, env: Env) => `apiVersion: v1
kind: Namespace
metadata:
  name: ${ns(project, env)}
  labels: { everesto.live/project: ${project}, everesto.live/env: ${env} }
  annotations:
    # shared by every app of ${project}: deleting ONE app must never delete the namespace
    argocd.argoproj.io/sync-options: Delete=false
`;

const service = (repo: string, port: number) => `apiVersion: v1
kind: Service
metadata:
  name: ${repo}
spec:
  selector: { app: ${repo} }
  ports: [{ port: 80, targetPort: ${port} }]
`;

const externalSecret = (repo: string, _project: string, env: Env) => `# All secrets of Infisical project "${repo}-gitops", env ${env} → Secret "${repo}"
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

const appProject = (project: string) => `apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: ${project}
  namespace: argocd
spec:
  description: DevOps space ${project}
  sourceRepos:
    - https://github.com/${OWNER}/*-gitops.git
  destinations:
    - { server: https://kubernetes.default.svc, namespace: ${ns(project, 'dev')} }
    - { server: https://kubernetes.default.svc, namespace: ${ns(project, 'prod')} }
  clusterResourceWhitelist:
    - { group: '', kind: Namespace }
  namespaceResourceWhitelist:
    - { group: '*', kind: '*' }
`;

const application = (repo: string, project: string, env: Env) => `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ${repo}-${env}
  namespace: argocd
  labels: { everesto.live/project: ${project}, everesto.live/env: ${env} }
  finalizers: [resources-finalizer.argocd.argoproj.io]   # deleting the app removes its pods too
spec:
  project: ${project}
  source:
    repoURL: https://github.com/${OWNER}/${repo}-gitops.git
    targetRevision: main
    path: apps/${env}
  destination: { server: https://kubernetes.default.svc, namespace: ${ns(project, env)} }
  syncPolicy:
    # MANUAL sync: after "Deploy" / "Promote" click Sync in ArgoCD
    syncOptions: [CreateNamespace=true]
`;

const secretStore = (repo: string, project: string, env: Env, projectSlug: string, url: string) => `apiVersion: external-secrets.io/v1
kind: ClusterSecretStore
metadata:
  name: infisical-${repo}-${env}
spec:
  conditions:
    - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: ${ns(project, env)} } }
  provider:
    infisical:
      hostAPI: ${url}
      auth:
        universalAuthCredentials:
          clientId: { name: infisical-${repo}-auth, namespace: external-secrets, key: clientId }
          clientSecret: { name: infisical-${repo}-auth, namespace: external-secrets, key: clientSecret }
      secretsScope: { projectSlug: ${projectSlug}, environmentSlug: ${env}, secretsPath: / }
`;

const header = (file: string, gitops: string, extra = '') =>
  `# Apply on the control plane (Backstage has no cluster access):\n#   sudo kubectl apply -f https://raw.githubusercontent.com/${OWNER}/${gitops}/main/argocd/${file}\n${extra}`;

// ---------- Infisical ----------

async function infisical(config: Config) {
  const url = config.getOptionalString('infisical.url');
  const clientId = config.getOptionalString('infisical.clientId');
  const clientSecret = config.getOptionalString('infisical.clientSecret');
  const orgId = config.getOptionalString('infisical.organizationId')?.trim().replace(/\/+$/, ''); // tolerate a pasted trailing '/'
  if (!url || !clientId || !clientSecret || !orgId) {
    throw err(409, 'Backstage is not connected to Infisical yet (identity backstage-platform) — nothing was created. Secrets are required for a deployment.');
  }
  const login = await (await fetch(`${url}/api/v1/auth/universal-auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId, clientSecret }),
  })).json() as any;
  if (!login.accessToken) throw err(502, 'Infisical: login of backstage-platform failed — nothing was created');
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
  return { url, orgId, api };
}

/** Infisical project <repo>-gitops (one per application) + its secrets in <env>. Returns slug and (only when new) the ESO identity login. */
async function infisicalSetup(config: Config, repo: string, env: Env, secrets: { name: string; value?: string }[]) {
  const { url, orgId, api } = await infisical(config);
  const project = `${repo}-gitops`;
  const list = await api('GET', '/api/v1/workspace');
  let ws = (list.json?.workspaces ?? []).find((w: any) => w.name === project);
  if (!ws) {
    const created = await api('POST', '/api/v2/workspace', { projectName: project, organizationId: orgId });
    if (!created.ok) throw err(502, `Infisical: cannot create project ${project} (${created.status})`);
    ws = created.json.project ?? created.json.workspace;
  }
  for (const s of secrets) {
    const r = await api('POST', `/api/v3/secrets/raw/${encodeURIComponent(s.name)}`, {
      workspaceId: ws.id, environment: env, secretPath: '/', secretValue: s.value || 'CHANGE_ME', type: 'shared',
    });
    if (!r.ok && !JSON.stringify(r.json ?? '').toLowerCase().includes('already exist')) throw err(502, `Infisical: cannot create secret ${s.name} (${r.status} ${JSON.stringify(r.json?.message ?? '')})`);
  }

  // ESO identity eso-<repo>: viewer on this Infisical project only
  const name = `eso-${repo}`;
  const ids = await api('GET', `/api/v2/organizations/${orgId}/identity-memberships`);
  const exists = (ids.json?.identityMemberships ?? []).some((m: any) => m.identity?.name === name);
  const base = { url, projectSlug: ws.slug as string, projectUrl: `${url}/project/${ws.id}/secrets/overview`, identity: name, project };
  if (exists) return base;
  const idRes = await api('POST', '/api/v1/identities', { name, organizationId: orgId, role: 'no-access' });
  if (!idRes.ok) throw err(502, `Infisical: cannot create identity ${name} (${idRes.status})`);
  const identityId = idRes.json.identity.id;
  const ua = await api('POST', `/api/v1/auth/universal-auth/identities/${identityId}`, {});
  const cs = await api('POST', `/api/v1/auth/universal-auth/identities/${identityId}/client-secrets`, { description: 'ESO (created by Backstage)' });
  const mem = await api('POST', `/api/v2/workspace/${ws.id}/identity-memberships/${identityId}`, { role: 'viewer' });
  if (!ua.ok || !cs.ok || !mem.ok) throw err(502, `Infisical: identity ${name} setup failed (${ua.status}/${cs.status}/${mem.status})`);
  return { ...base, clientId: ua.json.identityUniversalAuth?.clientId as string, clientSecret: cs.json.clientSecret as string };
}

/** Delete Infisical project <repo>-gitops + identity eso-<repo> (part of deleting the deployment). */
export async function infisicalDelete(config: Config, repo: string): Promise<{ done: string[]; warn: string[] }> {
  const done: string[] = [];
  const warn: string[] = [];
  let conn;
  try { conn = await infisical(config); } catch (e: any) { return { done, warn: [`Infisical not reachable — delete project ${repo}-gitops by hand (${e.message})`] }; }
  const { orgId, api } = conn;
  const ws = ((await api('GET', '/api/v1/workspace')).json?.workspaces ?? []).find((w: any) => w.name === `${repo}-gitops`);
  if (ws) {
    const d = await api('DELETE', `/api/v1/workspace/${ws.id}`);
    if (d.ok) done.push(`Infisical project ${repo}-gitops (all its secrets)`); else warn.push(`could not delete Infisical project ${repo}-gitops (${d.status})`);
  }
  const ids = await api('GET', `/api/v2/organizations/${orgId}/identity-memberships`);
  const id = (ids.json?.identityMemberships ?? []).find((m: any) => m.identity?.name === `eso-${repo}`)?.identity?.id;
  if (id) {
    const d = await api('DELETE', `/api/v1/identities/${id}`);
    if (d.ok) done.push(`Infisical identity eso-${repo}`); else warn.push(`could not delete identity eso-${repo} (${d.status})`);
  }
  return { done, warn };
}

// ---------- helpers ----------

async function requireDeployment(token: string, repo: string) {
  const gitops = `${repo}-gitops`;
  const dev = await readFile(token, gitops, 'apps/dev/kustomization.yaml');
  if (!dev) throw err(404, `${repo} has no deployment (${gitops})`);
  return { gitops, dev, prod: await readFile(token, gitops, 'apps/prod/kustomization.yaml') };
}
const tagOf = (k?: string) => k?.match(/newTag:\s*(\S+)/)?.[1];

/** Last successful main builds = images that exist in ghcr.io (CI keeps the last 5). */
export async function builds(config: Config, repo: string) {
  const token = await githubToken(config, OWNER);
  const runs = await gh(token, 'GET', `/repos/${OWNER}/${repo}/actions/runs?branch=main&status=success&per_page=20`);
  return ((runs.json?.workflow_runs ?? []) as any[])
    .filter(r => r.name === 'CI' && r.event !== 'pull_request')
    .slice(0, 5)
    .map(r => ({ tag: `sha-${String(r.head_sha).slice(0, 7)}`, at: r.created_at as string, title: r.display_title as string, url: r.html_url as string }));
}

// ---------- runbook (TechDocs page of <repo>-gitops + "Setup commands" in Backstage) — NO secret values ----------

export const setupCommands = (repo: string, project: string, hasProd: boolean) => {
  const gitops = `${repo}-gitops`;
  const raw = `https://raw.githubusercontent.com/${OWNER}/${gitops}/main/argocd`;
  const c: { title: string; cmd: string }[] = [
    { title: '1. Tenant node label (once per cluster)', cmd: 'sudo kubectl label node dev-k3s-argocd everesto.live/pool=tenants --overwrite' },
    {
      title: `2. Infisical login for ESO (identity eso-${repo}) — the secret is shown only in Backstage: Edit deployment → "New ESO login"`,
      cmd: `sudo kubectl -n external-secrets create secret generic infisical-${repo}-auth \\\n  --from-literal=clientId='<CLIENT_ID>' --from-literal=clientSecret='<CLIENT_SECRET>'`,
    },
    { title: '3. Secret store (dev)', cmd: `sudo kubectl apply -f ${raw}/secret-stores.yaml` },
    { title: `4. ArgoCD project ${project} + app ${repo}-dev`, cmd: `sudo kubectl apply -f ${raw}/argocd.yaml` },
    { title: `5. Deploy: ArgoCD → ${repo}-dev → Sync`, cmd: `# or: sudo kubectl -n argocd patch application ${repo}-dev --type merge -p '{"operation":{"sync":{}}}'` },
  ];
  if (hasProd) c.push({ title: `6. Prod (after the first promote PR is merged): secret store + app ${repo}-prod`, cmd: `sudo kubectl apply -f ${raw}/argocd-prod.yaml` });
  c.push({ title: 'Check', cmd: `sudo kubectl -n argocd get applications | grep ${repo}\nsudo kubectl -n ${ns(project, 'dev')} get pods,externalsecret,secret` });
  return c;
};

const runbook = (repo: string, project: string, hasProd: boolean) => `# ${repo}-gitops — runbook

CD of [${repo}](https://github.com/${OWNER}/${repo}), DevOps space **${project}**. Managed by Backstage.

| env | folder | namespace | ArgoCD app | how a new image arrives |
|---|---|---|---|---|
| dev | \`apps/dev\` | \`${ns(project, 'dev')}\` | \`${repo}-dev\` | Backstage → **Deploy to dev** (pick a build) → **Sync** |
| prod | \`apps/prod\` | \`${ns(project, 'prod')}\` | \`${repo}-prod\` | Backstage → **Promote to prod** (PR) → merge → **Sync** |

Secrets: Infisical project **${repo}-gitops** (env dev / prod) → ESO → Kubernetes Secret \`${repo}\`. Never in this repo.

## Setup on the control plane (\`ssho control-plane\`)

Backstage has no cluster access — an admin runs these once. Re-running them is safe.

${setupCommands(repo, project, hasProd).map(c => `### ${c.title}\n\n\`\`\`bash\n${c.cmd.replace(/\\n/g, '\n')}\n\`\`\`\n`).join('\n')}
## Flow

\`\`\`mermaid
flowchart LR
  CI[${repo} CI: build on main] --> IMG[(ghcr.io image sha-…)]
  IMG -->|Deploy to dev| DEV[apps/dev] -->|Sync| NSD[${ns(project, 'dev')}]
  DEV -->|Promote PR| PROD[apps/prod] -->|Sync| NSP[${ns(project, 'prod')}]
  INF[(Infisical ${repo}-gitops)] -->|ESO| NSD
  INF -->|ESO| NSP
\`\`\`
`;
const mkdocs = (repo: string) => `site_name: ${repo}-gitops\nnav: [{ Runbook: index.md }]\nplugins: [techdocs-core]\n`;

// ---------- create ----------

export async function createDeployment(config: Config, repo: string, d: DeploymentInput, refs: string[], who: string) {
  const token = await githubToken(config, OWNER);
  const { info, project } = await appInfo(token, repo);
  if (!allowed(refs, project, ['owners', 'maintainers'])) throw err(403, `only owners/maintainers of ${project} can create deployments`);
  const image = info.match(/everesto\.live\/image:\s*(\S+)/)?.[1];
  if (!image) throw err(409, `${repo} builds no image — CD needs a CI application with an image`);
  for (const x of [...d.secrets, ...d.config]) if (!NAME.test(x.name)) throw err(400, `invalid variable name ${x.name} (A-Z 0-9 _)`);
  if (!(d.port > 0 && d.port < 65536) || !(d.memoryMi >= 64 && d.memoryMi <= 1024) || !(d.replicas >= 1 && d.replicas <= 3)) {
    throw err(400, 'port 1-65535, memory 64-1024 Mi, replicas 1-3');
  }
  if (d.healthPath && !/^\/[A-Za-z0-9/_.-]{0,100}$/.test(d.healthPath)) throw err(400, 'health path must look like /health');
  const gitops = `${repo}-gitops`;
  if ((await gh(token, 'GET', `/repos/${OWNER}/${gitops}`)).status !== 404) throw err(409, `${gitops} already exists — delete the deployment first`);
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
    { path: 'apps/dev/kustomization.yaml', content: kustomization(image, last.tag, project, 'dev') },
    { path: 'apps/dev/namespace.yaml', content: namespace(project, 'dev') },
    { path: 'apps/dev/deployment.yaml', content: deployment(repo, image, project, 'dev', d) },
    { path: 'apps/dev/service.yaml', content: service(repo, d.port) },
    { path: 'apps/dev/externalsecret.yaml', content: externalSecret(repo, project, 'dev') },
    { path: 'argocd/argocd.yaml', content: `${header('argocd.yaml', gitops)}${appProject(project)}---\n${application(repo, project, 'dev')}` },
    { path: 'argocd/secret-stores.yaml', content: `${header('secret-stores.yaml', gitops, `# needs secret infisical-${repo}-auth in namespace external-secrets\n`)}${secretStore(repo, project, 'dev', inf.projectSlug, inf.url)}` },
    { path: 'deployment.json', content: `${JSON.stringify({ port: d.port, memoryMi: d.memoryMi, replicas: d.replicas, healthPath: d.healthPath, config: d.config, secrets: d.secrets.map(s => s.name) }, null, 2)}\n` },
    { path: 'docs/index.md', content: runbook(repo, project, false) },
    { path: 'mkdocs.yml', content: mkdocs(repo) },
    { path: 'README.md', content: `# ${gitops}\n\nRunbook: docs/index.md (Tech Docs tab in Backstage).\n\nCD of [${repo}](https://github.com/${OWNER}/${repo}) (project **${project}**), managed by Backstage.\n\n- **dev** (\`apps/dev\`, ns \`${ns(project, 'dev')}\`): Backstage "Deploy" sets the image tag → Sync in ArgoCD.\n- **prod** (\`apps/prod\`, ns \`${ns(project, 'prod')}\`): created by the first "Promote to prod" (PR) → Sync in ArgoCD.\n- Secrets: Infisical project \`${gitops}\` (dev / prod), via ESO. Never in this repo.\n` },
  ]);
  done.push(`repo ${OWNER}/${gitops} (apps/dev, image ${last.tag})`);

  // 3. catalog: Resource <repo>-gitops next to the CI component
  await commit(token, repo, `cd: ${gitops} (Backstage, by ${who})`, [{
    path: 'catalog-info.yaml',
    content: `${info.trimEnd()}\n---\napiVersion: backstage.io/v1alpha1\nkind: Resource\nmetadata:\n  name: ${gitops}\n  description: CD of ${repo} — ArgoCD ${repo}-dev (manual sync), prod via Promote\n  annotations:\n    github.com/project-slug: ${OWNER}/${gitops}\n    argocd/app-name: ${repo}-dev\n    backstage.io/techdocs-ref: dir:.\nspec:\n  type: gitops\n  owner: ${project}\n  system: ${project}\n  dependsOn: [component:default/${repo}]\n`,
  }]);
  done.push('catalog entry (CD card on the Pipelines page)');

  const raw = `https://raw.githubusercontent.com/${OWNER}/${gitops}/main/argocd`;
  const commands: { title: string; cmd: string; secret?: boolean }[] = [];
  if ('clientSecret' in inf && inf.clientSecret) {
    commands.push({
      title: `Infisical login for ESO (identity ${inf.identity}) — shown ONCE, stored nowhere`,
      secret: true,
      cmd: `sudo kubectl -n external-secrets create secret generic infisical-${repo}-auth \\\n  --from-literal=clientId='${inf.clientId}' --from-literal=clientSecret='${inf.clientSecret}'`,
    });
  }
  commands.push({ title: 'Secret store (dev)', cmd: `sudo kubectl apply -f ${raw}/secret-stores.yaml` });
  commands.push({ title: `ArgoCD project ${project} + app ${repo}-dev — then click Sync in ArgoCD`, cmd: `sudo kubectl apply -f ${raw}/argocd.yaml` });
  return { done, commands, tag: last.tag, infisicalUrl: inf.projectUrl };
}

// ---------- deploy (dev) ----------

export async function deploy(config: Config, repo: string, tag: string, refs: string[], who: string) {
  const token = await githubToken(config, OWNER);
  const { project } = await appInfo(token, repo);
  if (!allowed(refs, project, ['owners', 'maintainers'])) throw err(403, `only owners/maintainers of ${project} can deploy`);
  if (!(await builds(config, repo)).some(b => b.tag === tag)) throw err(400, `${tag} is not one of the last successful builds`);
  const { gitops, dev } = await requireDeployment(token, repo);
  if (tagOf(dev) === tag) throw err(409, `dev already has ${tag} — click Sync in ArgoCD if it isn't running yet`);
  const sha = await commit(token, gitops, `dev: image → ${tag} (Backstage, by ${who})`,
    [{ path: 'apps/dev/kustomization.yaml', content: dev.replace(/(newTag:\s*)\S+/, `$1${tag}`) }]);
  return { from: tagOf(dev), to: tag, commit: sha, argocdApp: `${repo}-dev` };
}

// ---------- promote ----------

export async function promote(config: Config, repo: string, refs: string[], who: string) {
  const token = await githubToken(config, OWNER);
  const { project } = await appInfo(token, repo);
  if (!allowed(refs, project, ['owners', 'maintainers'])) throw err(403, `only owners/maintainers of ${project} can promote`);
  const { gitops, dev, prod } = await requireDeployment(token, repo);
  const devTag = tagOf(dev)!;
  if (prod && tagOf(prod) === devTag) throw err(409, `prod already runs ${devTag}`);

  const files: { path: string; content: string }[] = [];
  const commands: { title: string; cmd: string }[] = [];
  if (prod) {
    files.push({ path: 'apps/prod/kustomization.yaml', content: prod.replace(/(newTag:\s*)\S+/, `$1${devTag}`) });
  } else {
    // first promote: create prod from dev (own namespace, own secrets in Infisical prod)
    const meta = JSON.parse((await readFile(token, gitops, 'deployment.json')) ?? '{}');
    const devDep = (await readFile(token, gitops, 'apps/dev/deployment.yaml')) ?? '';
    const devSvc = (await readFile(token, gitops, 'apps/dev/service.yaml')) ?? '';
    const stores = (await readFile(token, gitops, 'argocd/secret-stores.yaml')) ?? '';
    const slug = stores.match(/projectSlug:\s*([^,\s}]+)/)?.[1];
    const url = stores.match(/hostAPI:\s*(\S+)/)?.[1];
    if (!slug || !url) throw err(409, 'argocd/secret-stores.yaml is missing — cannot create prod');
    await infisicalSetup(config, repo, 'prod', ((meta.secrets ?? []) as string[]).map(n => ({ name: n })));
    files.push(
      {
        path: 'apps/prod/kustomization.yaml',
        content: dev.replace(`namespace: ${ns(project, 'dev')}`, `namespace: ${ns(project, 'prod')}`)
          .replace(/#.*$/m, '# changed by "Promote to prod" (PR) — then Sync in ArgoCD'),
      },
      { path: 'apps/prod/deployment.yaml', content: devDep.replace(/everesto\.live\/env: dev/g, 'everesto.live/env: prod').replace(`${repo}-gitops / dev`, `${repo}-gitops / prod`) },
      { path: 'apps/prod/service.yaml', content: devSvc },
      { path: 'apps/prod/namespace.yaml', content: namespace(project, 'prod') },
      { path: 'apps/prod/externalsecret.yaml', content: externalSecret(repo, project, 'prod') },
      { path: 'argocd/argocd-prod.yaml', content: `${header('argocd-prod.yaml', gitops, '# AFTER the first promote PR is merged\n')}${secretStore(repo, project, 'prod', slug, url)}---\n${application(repo, project, 'prod')}` },
    );
    files.push({ path: 'docs/index.md', content: runbook(repo, project, true) });
    commands.push({
      title: `After merging the PR: secret store + ArgoCD app ${repo}-prod. Set the prod secrets in Infisical (${repo}-gitops / prod), then Sync`,
      cmd: `sudo kubectl apply -f https://raw.githubusercontent.com/${OWNER}/${gitops}/main/argocd/argocd-prod.yaml`,
    });
  }

  const branch = `promote-${devTag}`;
  const head = (await gh(token, 'GET', `/repos/${OWNER}/${gitops}/git/ref/heads/main`)).json.object.sha;
  const br = await gh(token, 'POST', `/repos/${OWNER}/${gitops}/git/refs`, { ref: `refs/heads/${branch}`, sha: head });
  if (!br.ok && br.status !== 422) throw new Error(`GitHub: cannot create branch (${br.status})`);
  await commit(token, gitops, `prod: image → ${devTag} (promoted by ${who})`, files, branch);
  const pr = await gh(token, 'POST', `/repos/${OWNER}/${gitops}/pulls`, {
    title: `Promote ${repo} to prod: ${tagOf(prod) ?? '(new)'} → ${devTag}`, head: branch, base: 'main',
    body: `Requested in Backstage by **${who}**.\n\nAfter merge: ArgoCD → \`${repo}-prod\` → **Sync** (manual).${prod ? '' : `\n\nFirst promote — after merge run once:\n\`\`\`\n${commands[0].cmd}\n\`\`\``}`,
  });
  if (!pr.ok && pr.status !== 422) throw new Error(`GitHub: cannot open PR (${pr.status})`);
  return { url: pr.json?.html_url ?? `https://github.com/${OWNER}/${gitops}/pulls`, from: tagOf(prod), to: devTag, commands };
}

// ---------- delete deployment ----------

export async function deleteDeployment(config: Config, repo: string, refs: string[], who: string, unregister: (name: string) => Promise<void>) {
  const token = await githubToken(config, OWNER);
  const { info, project } = await appInfo(token, repo);
  if (!allowed(refs, project, ['owners', 'maintainers'])) throw err(403, `only owners/maintainers of ${project} can delete deployments`);
  const gitops = `${repo}-gitops`;
  const done: string[] = [];
  const docs = info.split(/\n---\n/);
  const kept = docs.filter(doc => !(/kind: Resource/.test(doc) && doc.includes(`name: ${gitops}`)));
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
  const inf = await infisicalDelete(config, repo);
  done.push(...inf.done);
  return {
    done,
    warn: [
      `remove the running apps (Backstage has no cluster access): sudo kubectl -n argocd delete application ${repo}-dev ${repo}-prod --ignore-not-found`,
      ...inf.warn,
      `kept: images in ghcr.io and the cluster secret infisical-${repo}-auth (namespace external-secrets)`,
    ],
  };
}

// ---------- new ESO login (lost / rotated) ----------

export async function newEsoLogin(config: Config, repo: string, refs: string[], who: string) {
  const token = await githubToken(config, OWNER);
  const { project } = await appInfo(token, repo);
  if (!allowed(refs, project, ['owners', 'maintainers'])) throw err(403, `only owners/maintainers of ${project} can create ESO logins`);
  await requireDeployment(token, repo);
  const { orgId, api } = await infisical(config);
  const name = `eso-${repo}`;
  const ids = await api('GET', `/api/v2/organizations/${orgId}/identity-memberships`);
  const id = (ids.json?.identityMemberships ?? []).find((m: any) => m.identity?.name === name)?.identity?.id;
  if (!id) throw err(404, `Infisical identity ${name} not found`);
  const ua = await api('GET', `/api/v1/auth/universal-auth/identities/${id}`);
  const cs = await api('POST', `/api/v1/auth/universal-auth/identities/${id}/client-secrets`, { description: `ESO — new login by ${who} (Backstage)` });
  if (!ua.ok || !cs.ok) throw err(502, `Infisical: cannot create a client secret for ${name} (${ua.status}/${cs.status})`);
  const clientId = ua.json.identityUniversalAuth?.clientId;
  return {
    identity: name,
    cmd: `sudo kubectl -n external-secrets delete secret infisical-${repo}-auth --ignore-not-found\nsudo kubectl -n external-secrets create secret generic infisical-${repo}-auth \\\n  --from-literal=clientId='${clientId}' --from-literal=clientSecret='${cs.json.clientSecret}'`,
  };
}
