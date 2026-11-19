/**
 * everesto status chain — "why is my deployment not running yet?" answered in plain words, per environment.
 *
 *   1 Deployment in git      <repo>-gitops apps/<env>
 *   2 ArgoCD app             <env>-<repo> created by the root app platform-tenants (~3 min after a change)
 *   3 Cluster access         login of identity eso-<repo> in the cluster (ExternalSecret infisical-<repo>-auth)
 *   4 Secret source          ClusterSecretStore infisical-<repo>-<env> valid
 *   5 Synced                 ArgoCD sync is MANUAL by design → "click Sync"
 *   6 App secrets            ExternalSecret <repo> in <env>-<key> → Kubernetes Secret
 *   7 Running                pods ready (crash / OOM / image / capacity explained)
 *   8 Reachable (dev URL)    https://<repo>.dev.everesto.live answers
 *
 * collect() reads (read-only, never secret values); explainStatus() is pure and unit-tested.
 */
import { ArgoStatus, k8sGet } from './everestoK8s';

export type StepState = 'ok' | 'wait' | 'fail' | 'off' | 'unknown';
export type FixAction = 'renew-access' | 'argocd-sync' | 'logs' | 'edit-deployment' | 'secrets' | 'promote';
export type Step = {
  id: string;
  title: string;
  state: StepState;
  detail: string;
  fix?: { text: string; action?: FixAction; url?: string };
  etaSec?: number; // expected seconds until it moves on by itself
};

type Cond = { ready?: boolean; reason?: string; message?: string; refreshedAt?: string };
export type Raw = {
  env: 'dev' | 'prod';
  repo: string;
  namespace: string;
  clusterReadable: boolean;
  gitConfigured: boolean;                 // apps/<env> exists in <repo>-gitops
  argo?: ArgoStatus;
  access?: Cond | null;                   // null = not found
  store?: Cond | null;
  appSecret?: Cond | null;
  pods?: { phase?: string; ready: boolean; restarts: number; lastTermination?: string }[];
  replicas?: number;
  events?: string[];                      // recent warning messages of the app
  url?: { host: string; status?: number; error?: string };
  now?: number;
};

const ARGO_POLL = 180;   // ArgoCD checks git every 3 min
const ESO_REFRESH = 300; // ExternalSecrets refresh every 5 min
const argoUrl = (app: string) => `https://argocd.everesto.live/applications/argocd/${app}`;

const etaFrom = (iso: string | undefined, every: number, now: number) => {
  if (!iso) return every;
  const left = every - Math.round((now - Date.parse(iso)) / 1000);
  return Math.max(15, Math.min(every, left));
};

/** Pure: raw cluster/git state → ordered steps. Everything after the first blocking step is 'off' (not reached yet). */
export function explainStatus(r: Raw): Step[] {
  const now = r.now ?? Date.now();
  const app = `${r.env}-${r.repo}`;
  const steps: Step[] = [];

  steps.push(r.gitConfigured
    ? { id: 'git', title: 'Deployment in git', state: 'ok', detail: `${r.repo}-gitops/apps/${r.env}` }
    : r.env === 'prod'
      ? { id: 'git', title: 'Deployment in git', state: 'off', detail: 'No prod yet.', fix: { text: 'Promote to prod creates it (managers).', action: 'promote' } }
      : { id: 'git', title: 'Deployment in git', state: 'fail', detail: `${r.repo}-gitops has no apps/dev.`, fix: { text: 'Delete the deployment and create it again.', action: 'edit-deployment' } });

  if (!r.clusterReadable) {
    steps.push({ id: 'cluster', title: 'Cluster status', state: 'unknown', detail: 'Backstage cannot read the cluster here (local dev) — available in prod.' });
    return steps;
  }

  // 2 ArgoCD app
  if (!r.argo?.exists) {
    steps.push({ id: 'argo', title: 'ArgoCD app', state: 'wait', detail: `ArgoCD app ${app} is not created yet. The platform creates it automatically from git.`,
      etaSec: ARGO_POLL, fix: { text: 'Still missing after 5 minutes? Tell the platform team (root app platform-tenants).' } });
  } else steps.push({ id: 'argo', title: 'ArgoCD app', state: 'ok', detail: app });

  // 3 cluster access (the app's Infisical login)
  if (r.access === undefined) steps.push({ id: 'access', title: 'Cluster access to secrets', state: 'unknown', detail: 'Not readable — platform must apply backstage-k8s-readonly.yaml once.' });
  else if (r.access === null) steps.push({ id: 'access', title: 'Cluster access to secrets', state: 'wait', etaSec: ARGO_POLL,
    detail: 'The login object is not in the cluster yet — ArgoCD adds it with the app.' });
  else if (r.access.ready) steps.push({ id: 'access', title: 'Cluster access to secrets', state: 'ok', detail: `identity eso-${r.repo}` });
  else steps.push({ id: 'access', title: 'Cluster access to secrets', state: 'fail',
    detail: 'The cluster has no working login for this app (never created, or rotated and not picked up yet).',
    fix: { text: 'Click "Renew cluster access" — the cluster picks it up within 5 minutes, nothing to run.', action: 'renew-access' },
    etaSec: etaFrom(r.access.refreshedAt, ESO_REFRESH, now) });

  // 4 secret source
  if (r.store === undefined) steps.push({ id: 'store', title: 'Secret source', state: 'unknown', detail: 'Not readable yet (see above).' });
  else if (r.store === null) steps.push({ id: 'store', title: 'Secret source', state: 'wait', etaSec: ARGO_POLL, detail: 'Created by ArgoCD together with the app.' });
  else if (r.store.ready) steps.push({ id: 'store', title: 'Secret source', state: 'ok', detail: `Infisical ${r.repo}-gitops · ${r.env}` });
  else steps.push({ id: 'store', title: 'Secret source', state: r.access?.ready ? 'wait' : 'fail', etaSec: ESO_REFRESH,
    detail: r.access?.ready ? 'Login is there — the source re-checks itself within 5 minutes.' : 'Waits for cluster access (step above).' });

  // 5 sync (manual)
  if (r.argo?.exists) {
    if (r.argo.lastSyncPhase === 'Failed' || r.argo.lastSyncPhase === 'Error') {
      steps.push({ id: 'sync', title: 'Synced to the cluster', state: 'fail', detail: `Last sync failed: ${r.argo.lastSyncMessage ?? 'no message'}`,
        fix: { text: 'Fix the cause above, then Sync again in ArgoCD.', action: 'argocd-sync', url: argoUrl(app) } });
    } else if (r.argo.sync !== 'Synced') {
      steps.push({ id: 'sync', title: 'Synced to the cluster', state: 'wait', detail: 'Changes are waiting in git. Every sync is manual (on purpose).',
        fix: { text: `Open ${app} in ArgoCD → Sync.`, action: 'argocd-sync', url: argoUrl(app) } });
    } else steps.push({ id: 'sync', title: 'Synced to the cluster', state: 'ok', detail: `revision ${r.argo.revision ?? '?'}` });
  } else steps.push({ id: 'sync', title: 'Synced to the cluster', state: 'off', detail: 'After the ArgoCD app exists.' });

  // 6 app secrets
  if (r.appSecret === undefined) steps.push({ id: 'secrets', title: 'App secrets', state: 'unknown', detail: 'Not readable (sync once — it creates the read permission).' });
  else if (r.appSecret === null) steps.push({ id: 'secrets', title: 'App secrets', state: 'off', detail: 'Created by the first Sync.' });
  else if (r.appSecret.ready) steps.push({ id: 'secrets', title: 'App secrets', state: 'ok', detail: 'loaded from Infisical' });
  else {
    const blocked = !(r.access?.ready && r.store?.ready);
    steps.push({ id: 'secrets', title: 'App secrets', state: blocked ? 'wait' : 'fail', etaSec: etaFrom(r.appSecret.refreshedAt, ESO_REFRESH, now),
      detail: blocked ? 'Waits for cluster access + secret source (above), then loads by itself.' : `Could not load: ${r.appSecret.message ?? r.appSecret.reason ?? 'unknown'}`,
      fix: blocked ? undefined : { text: 'Check the names in the Secrets tab (values set, not CHANGE_ME).', action: 'secrets' } });
  }

  // 7 running
  const pods = r.pods ?? [];
  const ready = pods.filter(p => p.ready).length;
  if (!r.argo?.exists || r.argo.sync === undefined || pods.length === 0) {
    steps.push({ id: 'run', title: 'Running', state: r.argo?.sync === 'Synced' ? 'wait' : 'off', detail: r.argo?.sync === 'Synced' ? 'Starting…' : 'After Sync.' });
  } else if (r.replicas !== undefined && ready >= r.replicas && ready > 0) {
    steps.push({ id: 'run', title: 'Running', state: 'ok', detail: `${ready}/${r.replicas} ready` });
  } else {
    const bad = pods.find(p => !p.ready) ?? pods[0];
    const ev = (r.events ?? []).join(' ');
    steps.push({ id: 'run', title: 'Running', ...explainPod(bad, ev, ready, r.replicas ?? pods.length) });
  }

  // 8 reachable
  if (r.url) {
    const up = r.url.status !== undefined && r.url.status < 500;
    const running = steps[steps.length - 1].state === 'ok';
    steps.push(up
      ? { id: 'url', title: 'Reachable', state: 'ok', detail: `https://${r.url.host} → HTTP ${r.url.status}` }
      : { id: 'url', title: 'Reachable', state: running ? 'fail' : 'off', detail: running ? `https://${r.url.host} does not answer (${r.url.error ?? `HTTP ${r.url.status}`}).` : 'After the app runs.',
        fix: running ? { text: 'Check the port in Edit deployment = the port your app listens on.', action: 'edit-deployment' } : undefined });
  }

  // after the first blocking step, later steps are "not reached yet"
  const firstBlock = steps.findIndex(s => s.state === 'fail' || s.state === 'wait');
  return steps.map((s, i) => (firstBlock >= 0 && i > firstBlock && s.state !== 'ok' && s.state !== 'unknown' ? { ...s, state: 'off', fix: undefined, etaSec: undefined } : s));
}

function explainPod(p: { phase?: string; ready: boolean; restarts: number; lastTermination?: string }, ev: string, ready: number, want: number): Omit<Step, 'id' | 'title'> {
  const head = `${ready}/${want} ready`;
  const phase = p.phase ?? '';
  if (phase === 'CreateContainerConfigError' && /secret .* not found/i.test(ev)) {
    return { state: 'wait', detail: `${head} — waiting for the app secrets (step above).` };
  }
  if (phase === 'CreateContainerConfigError') return { state: 'fail', detail: `${head} — the container config is invalid: ${ev.slice(0, 200) || phase}`, fix: { text: 'Open Logs / Warnings in the CD tab.', action: 'logs' } };
  if (phase === 'ImagePullBackOff' || phase === 'ErrImagePull') {
    return { state: 'fail', detail: `${head} — the image cannot be downloaded (deleted, private, or wrong tag).`, fix: { text: 'Deploy a build that exists (Deploy → pick a build).', action: 'edit-deployment' } };
  }
  if (p.lastTermination === 'OOMKilled') {
    return { state: 'fail', detail: `${head} — killed: out of memory.`, fix: { text: 'Raise memory in Edit deployment (or fix a memory leak).', action: 'edit-deployment' } };
  }
  if (phase === 'CrashLoopBackOff' || p.restarts > 2) {
    return { state: 'fail', detail: `${head} — the app crashes on start (${p.restarts} restarts).`, fix: { text: 'Open the logs (Previous logs = the crash).', action: 'logs' } };
  }
  if (phase === 'Pending') {
    const capacity = /Insufficient|didn't match|untolerated|node\(s\)/i.test(ev);
    return capacity
      ? { state: 'fail', detail: `${head} — no node has room (or the tenant node label is missing).`, fix: { text: 'Lower memory/replicas, or ask the platform team for capacity.', action: 'edit-deployment' } }
      : { state: 'wait', detail: `${head} — being scheduled…`, etaSec: 60 };
  }
  if (phase === 'Running' && !p.ready) {
    return { state: 'wait', detail: `${head} — started, health check not passing yet.`, etaSec: 60, fix: { text: 'Stays like this? Health path / port in Edit deployment must match the app.', action: 'edit-deployment' } };
  }
  return { state: 'wait', detail: `${head} — ${phase || 'starting'}…`, etaSec: 60 };
}

const cond = (o: any): Cond | null => {
  if (!o) return null;
  const c = (o.status?.conditions ?? []).find((x: any) => x.type === 'Ready') ?? o.status?.conditions?.[0];
  return { ready: c?.status === 'True', reason: c?.reason, message: c?.message ? String(c.message).slice(0, 200) : undefined, refreshedAt: o.status?.refreshTime ?? c?.lastTransitionTime };
};

/** Read one ESO object: undefined = not allowed to read, null = does not exist. */
async function esoGet(path: string): Promise<Cond | null | undefined> {
  const r = await k8sGet(path);
  if (r.status === 403 || r.status === 0) return undefined;
  if (r.status === 404) return null;
  return cond(r.json);
}

/** Collect the raw state for one environment (read-only). */
export async function collectEsoState(repo: string, env: 'dev' | 'prod', namespace: string) {
  const [access, store, appSecret] = await Promise.all([
    esoGet(`/apis/external-secrets.io/v1/namespaces/external-secrets/externalsecrets/infisical-${repo}-auth`),
    esoGet(`/apis/external-secrets.io/v1/clustersecretstores/infisical-${repo}-${env}`),
    esoGet(`/apis/external-secrets.io/v1/namespaces/${namespace}/externalsecrets/${repo}`),
  ]);
  return { access, store, appSecret };
}

/** Does the public dev URL answer? (5 s, any status < 500 counts as reachable) */
export async function probeUrl(host: string) {
  try {
    const res = await fetch(`https://${host}/`, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(5000) });
    return { host, status: res.status };
  } catch (e: any) {
    return { host, error: String(e?.cause?.code ?? e?.name ?? e).slice(0, 60) };
  }
}
