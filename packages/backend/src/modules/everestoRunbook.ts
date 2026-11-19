/** Setup commands + the TechDocs runbook of <repo>-gitops — never secret values. */
import { Env, ns } from './everestoManifests';
import { OWNER } from './everestoManage';
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
export const setupCommands = (repo: string, project: string, hasProd: boolean, nsKey = project): SetupStep[] => {
  const gitops = `${repo}-gitops`;
  const dev = ns(nsKey, 'dev');
  const prod = ns(nsKey, 'prod');
  const sync = (e: Env) => `sudo kubectl -n argocd patch application ${e}-${repo} --type merge -p '{"operation":{"sync":{}}}'`;
  const check = (e: Env) => `sudo kubectl -n argocd get application ${e}-${repo}\nsudo kubectl -n ${ns(nsKey, e)} get pods,externalsecret,secret`;
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
      n: 4, env: 'dev', title: `ArgoCD project ${project} + application dev-${repo}`,
      cmd: `# AUTOMATIC — same tenant file; the app appears in ArgoCD ~3 min after Create deployment.\nsudo kubectl -n argocd get application dev-${repo}`,
      creates: [`AppProject ${project} (ns argocd)`, `Application dev-${repo} (ns argocd)`],
      explain: `AppProject ${project} = guard rails: only *-gitops repos, only namespaces ${dev} / ${prod}. Application dev-${repo} = an instruction to ArgoCD: "take folder apps/dev of ${gitops} and put it into ${dev}, sync manually". It creates no pods yet — it appears as a tile in ArgoCD.`,
    },
    {
      n: 5, env: 'dev', title: `Sync dev-${repo} (or ArgoCD UI → Sync)`,
      cmd: sync('dev'),
      creates: [`Namespace ${dev}`, `Deployment + pod ${repo} (ns ${dev})`, `Service ${repo} (ns ${dev})`, `ExternalSecret ${repo} (ns ${dev})`, `Secret ${repo} (ns ${dev}, created by ESO)`, `RoleBinding backstage-read-${repo} (ns ${dev}: Backstage may READ this namespace — CD tab)`],
      explain: `ArgoCD applies everything in apps/dev: the namespace first, then Deployment (image + tag, port, /health probes, memory), Service (port 80 → container port) and ExternalSecret. ESO sees the ExternalSecret and creates Secret ${repo} from Infisical dev; the pod gets every key as an environment variable. Run again after every "Deploy to dev".`,
    },
    { n: 6, env: 'dev', title: 'Check dev', cmd: check('dev'), creates: [], explain: 'Application Synced/Healthy, pod Running, ExternalSecret SecretSynced, Secret present.' },
    {
      n: 7, env: 'prod', title: `Prod secret store + application prod-${repo} — only after the first "Promote to prod" PR is merged${hasProd ? '' : ' (not done yet)'}`,
      cmd: `# AUTOMATIC on the first Promote — the prod store + app join the tenant file.\nsudo kubectl -n argocd get application prod-${repo}`,
      creates: [`ClusterSecretStore infisical-${repo}-prod (cluster-wide)`, `Application prod-${repo} (ns argocd)`],
      explain: `Same as steps 3 + 4 for prod: the store reads Infisical environment prod and only namespace ${prod} may use it; the Application takes apps/prod into ${prod}. The file exists only after the first promote PR is merged (404 before). Set the real prod secrets in the Secrets tab before syncing.`,
    },
    {
      n: 8, env: 'prod', title: `Sync prod-${repo} (or ArgoCD UI → Sync)`,
      cmd: sync('prod'),
      creates: [`Namespace ${prod}`, `Deployment + pod ${repo} (ns ${prod})`, `Service ${repo} (ns ${prod})`, `ExternalSecret ${repo} (ns ${prod})`, `Secret ${repo} (ns ${prod}, created by ESO)`, `RoleBinding backstage-read-${repo} (ns ${prod}: Backstage may READ this namespace — CD tab)`],
      explain: `Like step 5, for prod. Run again after every merged "Promote to prod" PR.`,
    },
    { n: 9, env: 'prod', title: 'Check prod', cmd: check('prod'), creates: [], explain: 'Application Synced/Healthy, pod Running, ExternalSecret SecretSynced, Secret present.' },
  ];
};

/** After a secret changed (only when the app already runs in that namespace). */
export const applySecretsCmd = (repo: string, nsKey: string, env: Env) =>
  `sudo kubectl -n ${ns(nsKey, env)} annotate externalsecret ${repo} force-sync=$(date +%s) --overwrite\n` +
  `sudo kubectl -n ${ns(nsKey, env)} rollout restart deployment ${repo}`;


export const runbook = (repo: string, project: string, hasProd: boolean, nsKey = project) => {
  const gitops = `${repo}-gitops`;
  const dev = ns(nsKey, 'dev');
  const prod = ns(nsKey, 'prod');
  const steps = setupCommands(repo, project, hasProd, nsKey);
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
    AD[Application dev-${repo}]
    AP[Application prod-${repo}]
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
| \`dev-${repo}\` / \`prod-${repo}\` | Application | argocd | you — steps 4 / 7 |
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
${applySecretsCmd(repo, nsKey, 'dev')}
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
export const mkdocs = (repo: string) => `site_name: ${repo}-gitops\nnav: [{ Runbook: index.md }]\nplugins: [techdocs-core]\n`;

