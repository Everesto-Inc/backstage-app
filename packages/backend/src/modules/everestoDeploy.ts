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
import { ROLE } from './everestoRoles';
import { argoApp } from './everestoK8s';
import { OWNER, PROTECTED_SYSTEMS, allowed, isProtected, appInfo, commit, readFile } from './everestoManage';

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
  publicUrl?: boolean; // dev: ingress <repo>.dev.everesto.live (via alb wildcard → in-cluster Traefik)
};

// ---------- manifests ----------

const kustomization = (image: string, tag: string, project: string, env: Env, ingress = false) => `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: ${ns(project, env)}
resources: [namespace.yaml, deployment.yaml, service.yaml, externalsecret.yaml, rolebinding-backstage.yaml${ingress ? ', ingress.yaml' : ''}]
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

// Backstage may READ this app's namespace (Kubernetes tab) — ClusterRole backstage-read bound HERE only
const roleBinding = (repo: string) => `apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: backstage-read-${repo}
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: backstage-read }
subjects:
  - { kind: ServiceAccount, name: backstage, namespace: prod-backstage }
`;

/** dev URL: https://<repo>.dev.everesto.live (app names are unique in the org → one wildcard cert covers all). */
export const devHost = (repo: string) => `${repo}.dev.everesto.live`;
const ingress = (repo: string) => `# https://${devHost(repo)} — alb (TLS *.dev.everesto.live) → in-cluster Traefik → this Ingress → Service ${repo}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${repo}
spec:
  ingressClassName: traefik
  rules:
    - host: ${devHost(repo)}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend: { service: { name: ${repo}, port: { number: 80 } } }
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
  let orgId = config.getOptionalString('infisical.organizationId')?.trim(); // tolerate a pasted trailing '/'
  while (orgId?.endsWith('/')) orgId = orgId.slice(0, -1);
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

export type SetupStep = {
  n: number;
  env: 'once' | 'dev' | 'prod';
  title: string;
  cmd: string;
  creates: string[]; // "Kind name (where)"
  explain: string;
};

/** Every control-plane command of a deployment, in order, explained. Source for: Secrets tab, Edit deployment, Tech Docs. */
export const setupCommands = (repo: string, project: string, hasProd: boolean): SetupStep[] => {
  const gitops = `${repo}-gitops`;
  const dev = ns(project, 'dev');
  const prod = ns(project, 'prod');
  const sync = (e: Env) => `sudo kubectl -n argocd patch application ${repo}-${e} --type merge -p '{"operation":{"sync":{}}}'`;
  const check = (e: Env) => `sudo kubectl -n argocd get application ${repo}-${e}\nsudo kubectl -n ${ns(project, e)} get pods,externalsecret,secret`;
  return [
    {
      n: 1, env: 'once', title: 'Tenant node label (once per cluster)',
      cmd: 'sudo kubectl label node dev-k3s-argocd everesto.live/pool=tenants --overwrite',
      creates: ['label everesto.live/pool=tenants (node dev-k3s-argocd)'],
      explain: 'Every tenant Deployment has nodeSelector everesto.live/pool=tenants. Without this label the pods stay Pending. Already done if any other app runs.',
    },
    {
      n: 2, env: 'once', title: `Infisical login for ESO (identity eso-${repo})`,
      cmd: `# AUTOMATIC — Backstage stores the login in Infisical (platform-eso); ESO creates Secret infisical-${repo}-auth.\n# Rotate: Secrets tab → "New ESO login". Check:\nsudo kubectl -n external-secrets get externalsecret infisical-${repo}-auth`,
      creates: [`Secret infisical-${repo}-auth (ns external-secrets)`],
      explain: `The login ESO uses to READ the Infisical project ${gitops} (dev and prod). Real values are never stored: Backstage → ${gitops} → Secrets → "New ESO login" shows this command with them, once. Lives in external-secrets, which tenants cannot read.`,
    },
    {
      n: 3, env: 'dev', title: 'Secret store for dev',
      cmd: `# AUTOMATIC — committed to gitops-backstage/platform/tenants/${project}/${repo}.yaml, created by ArgoCD (root app platform-tenants).\nsudo kubectl get clustersecretstore infisical-${repo}-dev`,
      creates: [`ClusterSecretStore infisical-${repo}-dev (cluster-wide)`],
      explain: `Tells ESO where dev secrets come from: Infisical project ${gitops}, environment dev, path /, using the login of step 2. Its condition allows ONLY namespace ${dev} to use it.`,
    },
    {
      n: 4, env: 'dev', title: `ArgoCD project ${project} + application ${repo}-dev`,
      cmd: `# AUTOMATIC — same tenant file; the app appears in ArgoCD ~3 min after Create deployment.\nsudo kubectl -n argocd get application ${repo}-dev`,
      creates: [`AppProject ${project} (ns argocd)`, `Application ${repo}-dev (ns argocd)`],
      explain: `AppProject ${project} = guard rails: only *-gitops repos, only namespaces ${dev} / ${prod}. Application ${repo}-dev = an instruction to ArgoCD: "take folder apps/dev of ${gitops} and put it into ${dev}, sync manually". It creates no pods yet — it appears as a tile in ArgoCD.`,
    },
    {
      n: 5, env: 'dev', title: `Sync ${repo}-dev (or ArgoCD UI → Sync)`,
      cmd: sync('dev'),
      creates: [`Namespace ${dev}`, `Deployment + pod ${repo} (ns ${dev})`, `Service ${repo} (ns ${dev})`, `ExternalSecret ${repo} (ns ${dev})`, `Secret ${repo} (ns ${dev}, created by ESO)`, `RoleBinding backstage-read-${repo} (ns ${dev}: Backstage may READ this namespace — CD tab)`],
      explain: `ArgoCD applies everything in apps/dev: the namespace first, then Deployment (image + tag, port, /health probes, memory), Service (port 80 → container port) and ExternalSecret. ESO sees the ExternalSecret and creates Secret ${repo} from Infisical dev; the pod gets every key as an environment variable. Run again after every "Deploy to dev".`,
    },
    { n: 6, env: 'dev', title: 'Check dev', cmd: check('dev'), creates: [], explain: 'Application Synced/Healthy, pod Running, ExternalSecret SecretSynced, Secret present.' },
    {
      n: 7, env: 'prod', title: `Prod secret store + application ${repo}-prod — only after the first "Promote to prod" PR is merged${hasProd ? '' : ' (not done yet)'}`,
      cmd: `# AUTOMATIC on the first Promote — the prod store + app join the tenant file.\nsudo kubectl -n argocd get application ${repo}-prod`,
      creates: [`ClusterSecretStore infisical-${repo}-prod (cluster-wide)`, `Application ${repo}-prod (ns argocd)`],
      explain: `Same as steps 3 + 4 for prod: the store reads Infisical environment prod and only namespace ${prod} may use it; the Application takes apps/prod into ${prod}. The file exists only after the first promote PR is merged (404 before). Set the real prod secrets in the Secrets tab before syncing.`,
    },
    {
      n: 8, env: 'prod', title: `Sync ${repo}-prod (or ArgoCD UI → Sync)`,
      cmd: sync('prod'),
      creates: [`Namespace ${prod}`, `Deployment + pod ${repo} (ns ${prod})`, `Service ${repo} (ns ${prod})`, `ExternalSecret ${repo} (ns ${prod})`, `Secret ${repo} (ns ${prod}, created by ESO)`, `RoleBinding backstage-read-${repo} (ns ${prod}: Backstage may READ this namespace — CD tab)`],
      explain: `Like step 5, for prod. Run again after every merged "Promote to prod" PR.`,
    },
    { n: 9, env: 'prod', title: 'Check prod', cmd: check('prod'), creates: [], explain: 'Application Synced/Healthy, pod Running, ExternalSecret SecretSynced, Secret present.' },
  ];
};

/** After a secret changed (only when the app already runs in that namespace). */
export const applySecretsCmd = (repo: string, project: string, env: Env) =>
  `sudo kubectl -n ${ns(project, env)} annotate externalsecret ${repo} force-sync=$(date +%s) --overwrite\n` +
  `sudo kubectl -n ${ns(project, env)} rollout restart deployment ${repo}`;


const runbook = (repo: string, project: string, hasProd: boolean) => {
  const gitops = `${repo}-gitops`;
  const dev = ns(project, 'dev');
  const prod = ns(project, 'prod');
  const steps = setupCommands(repo, project, hasProd);
  const section = (env: SetupStep['env']) => steps.filter(x => x.env === env).map(x => `### ${x.n}. ${x.title}

\`\`\`bash
${x.cmd}
\`\`\`

${x.explain}
${x.creates.length ? `\n**Creates:**\n\n${x.creates.map(c => `- ${c}`).join('\n')}\n` : ''}`).join('\n');
  return `# ${gitops}

Deployment (CD) of [${repo}](https://github.com/${OWNER}/${repo}), DevOps space **${project}**, managed by Backstage.
Backstage has **no cluster access**: it writes git and Infisical; an admin runs the commands below on the control plane
(\`ssho control-plane\`). Every command is safe to run again.

## What runs where

\`\`\`mermaid
flowchart TB
  subgraph git[GitHub ${gitops}]
    D[apps/dev]
    P[apps/prod]
    A[argocd/*.yaml]
  end
  subgraph inf[Infisical project ${gitops}]
    ID[(env dev)]
    IP[(env prod)]
  end
  subgraph argo[ns argocd]
    AD[Application ${repo}-dev]
    AP[Application ${repo}-prod]
  end
  subgraph es[ns external-secrets]
    L[Secret infisical-${repo}-auth]
  end
  SD{{ClusterSecretStore ${repo}-dev}}
  SP{{ClusterSecretStore ${repo}-prod}}
  subgraph nd[ns ${dev}]
    PD[pod ${repo}]
  end
  subgraph np[ns ${prod}]
    PP[pod ${repo}]
  end
  A -. kubectl apply .-> AD & AP & SD & SP
  D -->|Sync| AD --> nd
  P -->|Sync| AP --> np
  L --> SD & SP
  ID --> SD -->|ESO: Secret ${repo}| nd
  IP --> SP -->|ESO: Secret ${repo}| np
\`\`\`

| Object | Kind | Namespace | Created by |
|---|---|---|---|
| \`infisical-${repo}-auth\` | Secret (Infisical login) | external-secrets | you — step 2 |
| \`infisical-${repo}-dev\` / \`-prod\` | ClusterSecretStore | — (cluster-wide) | you — steps 3 / 7 |
| \`${project}\` | AppProject | argocd | you — step 4 |
| \`${repo}-dev\` / \`${repo}-prod\` | Application | argocd | you — steps 4 / 7 |
| \`${dev}\` / \`${prod}\` | Namespace | — | ArgoCD on Sync |
| \`${repo}\` | Deployment, Service, ExternalSecret | ${dev} / ${prod} | ArgoCD on Sync |
| \`${repo}\` | Secret (the app's secrets) | ${dev} / ${prod} | ESO, from Infisical |

Why the files have no \`namespace:\` line: it is set once per folder in \`apps/<env>/kustomization.yaml\`
(\`namespace: ${dev}\` / \`${prod}\`) and in each Application's \`destination\`.

## Once (per cluster / per app)

${section('once')}
## Dev

${section('dev')}
## Prod

${section('prod')}
## Day to day

| I want to… | Do |
|---|---|
| deploy a new build to dev | Backstage → CD card → **Deploy to dev** → pick a build → step 5 (Sync) |
| put dev's version into prod | Backstage → **Promote to prod** → merge the PR → step 8 (Sync) |
| roll back | **Deploy to dev** with an older build (the last 5 images are kept) → Sync; then promote |
| change a secret | Backstage → ${gitops} → **Secrets** → dev/prod (prod: maintainers/owners) → then: |

\`\`\`bash
# apply a changed secret now (dev; use ${prod} for prod) — only when the app already runs there
${applySecretsCmd(repo, project, 'dev')}
\`\`\`

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| \`namespaces "${prod}" not found\` | prod not synced yet | steps 7 + 8 |
| \`argocd-prod.yaml\` → 404 | first promote PR not merged yet (or GitHub cache, ~5 min) | merge the PR, wait |
| pod \`Pending\` | node label missing | step 1 |
| ExternalSecret \`SecretSyncedError\` | login secret missing/wrong, or store missing | step 2 ("New ESO login"), steps 3 / 7 |
| pod \`ImagePullBackOff\` | image package is private | GitHub → Packages → ${repo} → make public |
| pod \`CrashLoopBackOff\` | app fails at start — often a \`CHANGE_ME\` secret | Secrets tab → set the value → apply |
| Application \`OutOfSync\` | expected: sync is manual | Sync (steps 5 / 8) |

`;
};
const mkdocs = (repo: string) => `site_name: ${repo}-gitops\nnav: [{ Runbook: index.md }]\nplugins: [techdocs-core]\n`;

// ---------- tenants (app-of-apps): Backstage writes the ArgoCD objects to git, ArgoCD creates them ----------
// gitops-backstage/platform/tenants/<space>/<app>.yaml  → watched by the root Application "platform-tenants"
// (applied ONCE by the owner). The ESO login of each app lives in Infisical project "platform-eso" (written by
// Backstage, read by ESO via store infisical-platform-eso, only into namespace external-secrets) — no human sees it.

const PLATFORM_REPO = 'gitops-backstage';
const PLATFORM_ESO = 'platform-eso';
const loginKey = (repo: string, part: 'CLIENT_ID' | 'CLIENT_SECRET') => `${repo.toUpperCase().replaceAll('-', '_')}_${part}`;

/** Infisical project platform-eso (created by backstage-platform) + read access for the cluster's ESO identity. */
async function ensurePlatformEso(config: Config) {
  const { orgId, api } = await infisical(config);
  let ws = ((await api('GET', '/api/v1/workspace')).json?.workspaces ?? []).find((w: any) => w.name === PLATFORM_ESO);
  if (!ws) {
    const c = await api('POST', '/api/v2/workspace', { projectName: PLATFORM_ESO, slug: PLATFORM_ESO, organizationId: orgId });
    if (!c.ok) throw err(502, `Infisical: cannot create project ${PLATFORM_ESO} (${c.status})`);
    ws = c.json.project ?? c.json.workspace;
  }
  const esoName = config.getOptionalString('infisical.esoIdentity') ?? 'k8s-eso';
  const ids = await api('GET', `/api/v2/organizations/${orgId}/identity-memberships`);
  const esoId = (ids.json?.identityMemberships ?? []).find((m: any) => m.identity?.name === esoName)?.identity?.id;
  if (esoId) await api('POST', `/api/v2/workspace/${ws.id}/identity-memberships/${esoId}`, { role: 'viewer' }); // 400 if already member
  return { api, orgId, wsId: ws.id as string, slug: ws.slug as string };
}

/** Fresh client secret for eso-<repo>, written into platform-eso (prod, /). Returns nothing secret. */
async function rotateEsoLogin(config: Config, repo: string, who: string): Promise<string> {
  const p = await ensurePlatformEso(config);
  const ids = await p.api('GET', `/api/v2/organizations/${p.orgId}/identity-memberships`);
  const id = (ids.json?.identityMemberships ?? []).find((m: any) => m.identity?.name === `eso-${repo}`)?.identity?.id;
  if (!id) throw err(404, `Infisical identity eso-${repo} not found`);
  const ua = await p.api('GET', `/api/v1/auth/universal-auth/identities/${id}`);
  const cs = await p.api('POST', `/api/v1/auth/universal-auth/identities/${id}/client-secrets`, { description: `ESO (Backstage, by ${who})` });
  if (!ua.ok || !cs.ok) throw err(502, `Infisical: cannot create a login for eso-${repo} (${ua.status}/${cs.status})`);
  for (const [part, value] of [['CLIENT_ID', ua.json.identityUniversalAuth?.clientId], ['CLIENT_SECRET', cs.json.clientSecret]] as const) {
    const body = { workspaceId: p.wsId, environment: 'prod', secretPath: '/', secretValue: String(value), type: 'shared' };
    const key = encodeURIComponent(loginKey(repo, part));
    let r = await p.api('PATCH', `/api/v3/secrets/raw/${key}`, body);
    if (!r.ok) r = await p.api('POST', `/api/v3/secrets/raw/${key}`, body);
    if (!r.ok) throw err(502, `Infisical: cannot store the login of eso-${repo} (${r.status})`);
  }
  return p.slug; // real slug of platform-eso (for the platform store)
}

const tenantYaml = (repo: string, project: string, envs: Env[], appSlug: string, url: string) => [
  `# GENERATED by Backstage — DevOps Space ${project} · app ${repo}. Do not edit; Create deployment / Promote / Delete manage it.`,
  `apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: infisical-${repo}-auth
  namespace: external-secrets
spec:
  refreshInterval: 5m
  secretStoreRef: { kind: ClusterSecretStore, name: infisical-platform-eso }
  target: { name: infisical-${repo}-auth }
  data:
    - { secretKey: clientId, remoteRef: { key: ${loginKey(repo, 'CLIENT_ID')} } }
    - { secretKey: clientSecret, remoteRef: { key: ${loginKey(repo, 'CLIENT_SECRET')} } }
`,
  ...envs.map(e => secretStore(repo, project, e, appSlug, url)),
  ...envs.map(e => application(repo, project, e)),
].join('---\n');

const PLATFORM_FILES = {
  store: 'platform/tenants/_platform/store-platform-eso.yaml',
};
const platformStore = (url: string, esoSlug: string) => `# ESO reads the per-app logins from Infisical project platform-eso — only into namespace external-secrets.
apiVersion: external-secrets.io/v1
kind: ClusterSecretStore
metadata:
  name: infisical-platform-eso
spec:
  conditions:
    - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: external-secrets } }
  provider:
    infisical:
      hostAPI: ${url}
      auth:
        universalAuthCredentials:
          clientId: { name: infisical-backstage-auth, namespace: external-secrets, key: clientId }
          clientSecret: { name: infisical-backstage-auth, namespace: external-secrets, key: clientSecret }
      secretsScope: { projectSlug: ${esoSlug}, environmentSlug: prod, secretsPath: / }
`;

/** Write (content) or remove (null) the tenant file of an app in gitops-backstage. One commit, retried once on a race. */
async function writeTenant(token: string, project: string, repo: string, content: string | null, message: string, url: string, esoSlug = '') {
  const files: { path: string; content: string | null }[] = [{ path: `platform/tenants/${project}/${repo}.yaml`, content }];
  if (content !== null) {
    if (!(await readFile(token, PLATFORM_REPO, `platform/tenants/${project}/appproject.yaml`))) {
      files.push({ path: `platform/tenants/${project}/appproject.yaml`, content: `# GENERATED by Backstage — ArgoCD project of DevOps Space ${project}.\n${appProject(project)}` });
    }
    if (esoSlug && !(await readFile(token, PLATFORM_REPO, PLATFORM_FILES.store))) files.push({ path: PLATFORM_FILES.store, content: platformStore(url, esoSlug) });
  }
  try { await commit(token, PLATFORM_REPO, message, files); } catch { await commit(token, PLATFORM_REPO, message, files); }
}


// ---------- create ----------

export async function createDeployment(config: Config, repo: string, d: DeploymentInput, refs: string[], who: string) {
  const token = await githubToken(config, OWNER);
  const { info, project } = await appInfo(token, repo);
  if (!allowed(refs, project, [...ROLE.CREATE])) throw err(403, `only maintainers/managers of ${project} can create deployments`);
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
    { path: 'apps/dev/kustomization.yaml', content: kustomization(image, last.tag, project, 'dev', d.publicUrl !== false) },
    ...(d.publicUrl !== false ? [{ path: 'apps/dev/ingress.yaml', content: ingress(repo) }] : []),
    { path: 'apps/dev/namespace.yaml', content: namespace(project, 'dev') },
    { path: 'apps/dev/rolebinding-backstage.yaml', content: roleBinding(repo) },
    { path: 'apps/dev/deployment.yaml', content: deployment(repo, image, project, 'dev', d) },
    { path: 'apps/dev/service.yaml', content: service(repo, d.port) },
    { path: 'apps/dev/externalsecret.yaml', content: externalSecret(repo, project, 'dev') },
    { path: 'argocd/argocd.yaml', content: `${header('argocd.yaml', gitops)}${appProject(project)}---\n${application(repo, project, 'dev')}` },
    { path: 'argocd/secret-stores.yaml', content: `${header('secret-stores.yaml', gitops, `# needs secret infisical-${repo}-auth in namespace external-secrets\n`)}${secretStore(repo, project, 'dev', inf.projectSlug, inf.url)}` },
    { path: 'deployment.json', content: `${JSON.stringify({ port: d.port, memoryMi: d.memoryMi, replicas: d.replicas, healthPath: d.healthPath, publicUrl: d.publicUrl !== false, config: d.config, secrets: d.secrets.map(s => s.name) }, null, 2)}\n` },
    { path: 'docs/index.md', content: runbook(repo, project, false) },
    { path: 'mkdocs.yml', content: mkdocs(repo) },
    { path: 'README.md', content: `# ${gitops}\n\nRunbook: docs/index.md (Tech Docs tab in Backstage).\n\nCD of [${repo}](https://github.com/${OWNER}/${repo}) (project **${project}**), managed by Backstage.\n\n- **dev** (\`apps/dev\`, ns \`${ns(project, 'dev')}\`): Backstage "Deploy" sets the image tag → Sync in ArgoCD.\n- **prod** (\`apps/prod\`, ns \`${ns(project, 'prod')}\`): created by the first "Promote to prod" (PR) → Sync in ArgoCD.\n- Secrets: Infisical project \`${gitops}\` (dev / prod), via ESO. Never in this repo.\n` },
  ]);
  done.push(`repo ${OWNER}/${gitops} (apps/dev, image ${last.tag})${d.publicUrl !== false ? ` — URL https://${devHost(repo)} after Sync` : ''}`);

  // 3. catalog: Resource <repo>-gitops next to the CI component
  await commit(token, repo, `cd: ${gitops} (Backstage, by ${who})`, [{
    path: 'catalog-info.yaml',
    content: `${info.trimEnd()}\n---\napiVersion: backstage.io/v1alpha1\nkind: Resource\nmetadata:\n  name: ${gitops}\n  description: CD of ${repo} — ArgoCD ${repo}-dev (manual sync), prod via Promote\n  annotations:\n    github.com/project-slug: ${OWNER}/${gitops}\n    argocd/app-name: ${repo}-dev\n    everesto.live/url-dev: https://${devHost(repo)}\n    backstage.io/techdocs-ref: url:https://github.com/${OWNER}/${gitops}/tree/main\nspec:\n  type: gitops\n  owner: ${project}\n  system: ${project}\n  dependsOn: [component:default/${repo}]\n`,
  }]);
  done.push('catalog entry (CD card on the Pipelines page)');

  // 4. ArgoCD objects via git (app-of-apps): login (ESO), secret store, Application <repo>-dev — no kubectl per app
  const esoSlug = await rotateEsoLogin(config, repo, who);
  await writeTenant(token, project, repo, tenantYaml(repo, project, ['dev'], inf.projectSlug, inf.url), `tenants: ${project}/${repo} dev (Backstage, by ${who})`, inf.url, esoSlug);
  done.push(`ArgoCD app ${repo}-dev + its secret store + login: committed to ${PLATFORM_REPO}/platform/tenants — ArgoCD creates them within ~3 min, then click Sync`);
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
  if (tagOf(dev) === tag) throw err(409, `dev already has ${tag} — click Sync in ArgoCD if it isn't running yet`);
  const sha = await commit(token, gitops, `dev: image → ${tag} (Backstage, by ${who})`,
    [{ path: 'apps/dev/kustomization.yaml', content: dev.replace(/(newTag:\s*)\S+/, `$1${tag}`) }]);
  return {
    from: tagOf(dev), to: tag, commit: sha, argocdApp: `${repo}-dev`,
    commands: [
      { title: `1. Sync ${repo}-dev (or ArgoCD UI → Sync)`, cmd: `sudo kubectl -n argocd patch application ${repo}-dev --type merge -p '{"operation":{"sync":{}}}'` },
      { title: '2. Check (after ~30 s)', cmd: `sudo kubectl -n ${ns(project, 'dev')} get pods,externalsecret,secret` },
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
        content: dev.replace(`namespace: ${ns(project, 'dev')}`, `namespace: ${ns(project, 'prod')}`).replace(', ingress.yaml', '') // prod URL: later
          .split('\n').map(l => (l.includes('newTag:') ? `${l.split('#')[0].trimEnd()}   # changed by "Promote to prod" (PR) — then Sync in ArgoCD` : l)).join('\n'),
      },
      { path: 'apps/prod/deployment.yaml', content: devDep.replaceAll('everesto.live/env: dev', 'everesto.live/env: prod').replace(`${repo}-gitops / dev`, `${repo}-gitops / prod`) },
      { path: 'apps/prod/service.yaml', content: devSvc },
      { path: 'apps/prod/namespace.yaml', content: namespace(project, 'prod') },
      { path: 'apps/prod/rolebinding-backstage.yaml', content: roleBinding(repo) },
      { path: 'apps/prod/externalsecret.yaml', content: externalSecret(repo, project, 'prod') },
      { path: 'argocd/argocd-prod.yaml', content: `${header('argocd-prod.yaml', gitops, '# AFTER the first promote PR is merged\n')}${secretStore(repo, project, 'prod', slug, url)}---\n${application(repo, project, 'prod')}` },
    );
    files.push({ path: 'docs/index.md', content: runbook(repo, project, true) });
  }

  const sync = `sudo kubectl -n argocd patch application ${repo}-prod --type merge -p '{"operation":{"sync":{}}}'`;
  const check = `sudo kubectl -n ${ns(project, 'prod')} get pods,externalsecret,secret`;
  if (!prod) {
    commands.push(
      { title: '1. Merge the pull request on GitHub (link above)', cmd: '# GitHub → Merge pull request' },
      { title: `2. Set the real prod secrets: Backstage → ${gitops} → Secrets → prod (they are CHANGE_ME)`, cmd: '# Backstage → Secrets tab → prod' },
      { title: `3. ArgoCD app ${repo}-prod appears by itself (~3 min after this promote) → Sync — creates namespace ${ns(project, 'prod')}, Deployment, Service, ExternalSecret`, cmd: sync },
      { title: '4. Check (after ~30 s)', cmd: check },
    );
  } else {
    commands.push(
      { title: '1. Merge the pull request on GitHub (link above)', cmd: '# GitHub → Merge pull request' },
      { title: `2. Sync ${repo}-prod (or ArgoCD UI → Sync)`, cmd: sync },
      { title: '3. Check (after ~30 s)', cmd: check },
    );
  }

  if (!prod) {
    // first promote: the prod store + Application <repo>-prod join the tenant file (ArgoCD creates them)
    const st = (await readFile(token, gitops, 'argocd/secret-stores.yaml')) ?? '';
    const slug = st.match(/projectSlug:\s*([^,\s}]+)/)?.[1] ?? '';
    const url = st.match(/hostAPI:\s*(\S+)/)?.[1] ?? '';
    if (slug && url) await writeTenant(token, project, repo, tenantYaml(repo, project, ['dev', 'prod'], slug, url), `tenants: ${project}/${repo} prod (Backstage, by ${who})`, url);
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
  return { project, api, ws };
}

const refresh = applySecretsCmd;

export async function secretsList(config: Config, repo: string, env: Env, refs: string[]) {
  const { project, api, ws } = await secretsCtx(config, repo);
  if (!allowed(refs, project, [...ROLE.MEMBER])) throw err(403, `only members of ${project} can see secret names`);
  const r = await api('GET', `/api/v3/secrets/raw?workspaceId=${ws.id}&environment=${env}&secretPath=/`);
  if (!r.ok) throw err(502, `Infisical: cannot list secrets (${r.status})`);
  return {
    env,
    canEdit: allowed(refs, project, SECRET_ROLES[env]),
    // names + dates only — values never leave the backend
    secrets: ((r.json?.secrets ?? []) as any[]).map(s => ({ name: s.secretKey as string, updatedAt: (s.updatedAt ?? s.createdAt) as string, placeholder: s.secretValue === 'CHANGE_ME' }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    applyCmd: refresh(repo, project, env),
    infisicalUrl: `${config.getString('infisical.url')}/project/${ws.id}/secrets/overview`,
  };
}

export async function secretSet(config: Config, repo: string, env: Env, name: string, value: string, refs: string[]) {
  if (!NAME.test(name)) throw err(400, `invalid name ${name} (A-Z 0-9 _)`);
  if (!value) throw err(400, 'value is empty');
  const { project, api, ws } = await secretsCtx(config, repo);
  if (!allowed(refs, project, SECRET_ROLES[env])) throw err(403, `only ${SECRET_ROLES[env].join('/')} of ${project} can change ${env} secrets`);
  const body = { workspaceId: ws.id, environment: env, secretPath: '/', secretValue: value, type: 'shared' };
  let r = await api('PATCH', `/api/v3/secrets/raw/${encodeURIComponent(name)}`, body);
  if (!r.ok) r = await api('POST', `/api/v3/secrets/raw/${encodeURIComponent(name)}`, body); // new secret
  if (!r.ok) throw err(502, `Infisical: cannot save ${name} (${r.status})`);
  return { saved: name, env, applyCmd: refresh(repo, project, env) };
}

export async function secretDelete(config: Config, repo: string, env: Env, name: string, refs: string[]) {
  if (!NAME.test(name)) throw err(400, `invalid name ${name}`);
  const { project, api, ws } = await secretsCtx(config, repo);
  if (!allowed(refs, project, SECRET_ROLES[env])) throw err(403, `only ${SECRET_ROLES[env].join('/')} of ${project} can delete ${env} secrets`);
  const r = await api('DELETE', `/api/v3/secrets/raw/${encodeURIComponent(name)}`, { workspaceId: ws.id, environment: env, secretPath: '/', type: 'shared' });
  if (!r.ok) throw err(502, `Infisical: cannot delete ${name} (${r.status})`);
  return { deleted: name, env, applyCmd: refresh(repo, project, env) };
}

/** Used by Delete application: remove the tenant file (ArgoCD then deletes apps, stores, login). */
export async function removeTenant(token: string, project: string, repo: string, who: string) {
  await writeTenant(token, project, repo, null, `tenants: ${project}/${repo} removed with the application (Backstage, by ${who})`, '');
}
