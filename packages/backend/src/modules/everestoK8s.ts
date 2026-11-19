/**
 * Read-only cluster access for everesto (Backstage runs in the cluster, ServiceAccount prod-backstage/backstage,
 * ClusterRole backstage-read). Used for the ArgoCD Sync/Health of deployments. Never writes.
 * Outside the cluster (local dev) everything returns undefined.
 */
import { KubeConfig } from '@kubernetes/client-node';
import https from 'node:https';

let kc: KubeConfig | undefined | null;
const config = () => {
  if (kc === undefined) {
    try {
      const k = new KubeConfig();
      k.loadFromCluster();
      kc = process.env.KUBERNETES_SERVICE_HOST ? k : null;
    } catch {
      kc = null;
    }
  }
  return kc;
};

async function get(path: string): Promise<any | undefined> {
  const k = config();
  if (!k) return undefined;
  const server = k.getCurrentCluster()!.server;
  const opts: https.RequestOptions = {};
  await k.applyToHTTPSOptions(opts);
  return new Promise(resolve => {
    const req = https.request(`${server}${path}`, { ...opts, method: 'GET', timeout: 5000 }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(undefined);
        try { return resolve(JSON.parse(body)); } catch { return resolve(undefined); }
      });
    });
    req.on('error', () => resolve(undefined));
    req.on('timeout', () => { req.destroy(); resolve(undefined); });
    req.end();
  });
}

/** GET with the HTTP status (0 = no cluster / network error) — lets callers tell 'forbidden' from 'not found'. */
export async function k8sGet(path: string): Promise<{ status: number; json?: any }> {
  const k = config();
  if (!k) return { status: 0 };
  const server = k.getCurrentCluster()!.server;
  const opts: https.RequestOptions = {};
  await k.applyToHTTPSOptions(opts);
  return new Promise(resolve => {
    const req = https.request(`${server}${path}`, { ...opts, method: 'GET', timeout: 5000 }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, json: res.statusCode === 200 ? JSON.parse(body) : undefined }); } catch { resolve({ status: 0 }); }
      });
    });
    req.on('error', () => resolve({ status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0 }); });
    req.end();
  });
}

export type ArgoStatus = {
  exists: boolean;
  sync?: string;        // Synced | OutOfSync | Unknown
  health?: string;      // Healthy | Progressing | Degraded | Missing | Suspended | Unknown
  revision?: string;
  lastSyncAt?: string;
  lastSyncPhase?: string; // Succeeded | Failed | Error | Running
  lastSyncMessage?: string;
  images?: string[];
};

/** ArgoCD Application <name> in ns argocd — undefined when Backstage can't read the cluster. */
export async function argoApp(name: string): Promise<ArgoStatus | undefined> {
  if (!config()) return undefined;
  const a = await get(`/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/${encodeURIComponent(name)}`);
  if (!a) return { exists: false };
  const op = a.status?.operationState;
  return {
    exists: true,
    sync: a.status?.sync?.status,
    health: a.status?.health?.status,
    revision: String(a.status?.sync?.revision ?? '').slice(0, 7),
    lastSyncAt: op?.finishedAt ?? a.status?.reconciledAt,
    lastSyncPhase: op?.phase,
    lastSyncMessage: op?.message ? String(op.message).slice(0, 200) : undefined,
    images: a.status?.summary?.images,
  };
}

async function getText(path: string): Promise<string | undefined> {
  const k = config();
  if (!k) return undefined;
  const server = k.getCurrentCluster()!.server;
  const opts: https.RequestOptions = {};
  await k.applyToHTTPSOptions(opts);
  return new Promise(resolve => {
    const req = https.request(`${server}${path}`, { ...opts, method: 'GET', timeout: 8000 }, res => {
      let body = '';
      res.on('data', c => { body += c; if (body.length > 400_000) req.destroy(); });
      res.on('end', () => resolve(res.statusCode === 200 ? body : undefined));
    });
    req.on('error', () => resolve(undefined));
    req.on('timeout', () => { req.destroy(); resolve(undefined); });
    req.end();
  });
}

const age = (iso?: string) => (iso ? Math.round((Date.now() - Date.parse(iso)) / 1000) : undefined);

/** Workloads of app <repo> in ONE namespace (only works where the namespace has bound backstage-read). */
export async function workloads(namespace: string, repo: string) {
  if (!config()) return undefined;
  const sel = encodeURIComponent(`app=${repo}`);
  const [deps, pods, events] = await Promise.all([
    get(`/apis/apps/v1/namespaces/${namespace}/deployments?labelSelector=${sel}`),
    get(`/api/v1/namespaces/${namespace}/pods?labelSelector=${sel}`),
    get(`/api/v1/namespaces/${namespace}/events?limit=200`),
  ]);
  if (!deps && !pods) return { readable: false, namespace };
  const podNames = new Set(((pods?.items ?? []) as any[]).map(p => p.metadata.name));
  return {
    readable: true,
    namespace,
    deployments: ((deps?.items ?? []) as any[]).map(d => ({
      name: d.metadata.name,
      replicas: d.spec?.replicas ?? 0,
      ready: d.status?.readyReplicas ?? 0,
      image: d.spec?.template?.spec?.containers?.[0]?.image,
      updatedAgeSec: age(d.status?.conditions?.find((c: any) => c.type === 'Progressing')?.lastUpdateTime),
    })),
    pods: ((pods?.items ?? []) as any[]).map(p => {
      const cs = p.status?.containerStatuses?.[0];
      const waiting = cs?.state?.waiting?.reason;
      const terminated = cs?.lastState?.terminated?.reason;
      return {
        name: p.metadata.name,
        phase: waiting ?? p.status?.phase,           // e.g. CrashLoopBackOff, ImagePullBackOff, Running, Pending
        ready: !!cs?.ready,
        restarts: cs?.restartCount ?? 0,
        lastTermination: terminated,                  // e.g. OOMKilled, Error
        ageSec: age(p.metadata.creationTimestamp),
        node: p.spec?.nodeName,
        image: cs?.image,
      };
    }),
    // warnings about this app's objects (pods, deployment, replicasets, externalsecret)
    events: ((events?.items ?? []) as any[])
      .filter(e => e.type === 'Warning' && (podNames.has(e.involvedObject?.name) || String(e.involvedObject?.name ?? '').startsWith(repo)))
      .sort((a, b) => Date.parse(b.lastTimestamp ?? b.eventTime ?? 0) - Date.parse(a.lastTimestamp ?? a.eventTime ?? 0))
      .slice(0, 15)
      .map(e => ({ reason: e.reason, message: String(e.message ?? '').slice(0, 300), object: `${e.involvedObject?.kind}/${e.involvedObject?.name}`, count: e.count ?? 1, ageSec: age(e.lastTimestamp ?? e.eventTime) })),
  };
}

/** Last lines of a pod's log (pod must belong to app <repo>: checked by the caller via label). */
export async function podLogs(namespace: string, repo: string, pod: string, tail = 200, previous = false) {
  const p = await get(`/api/v1/namespaces/${namespace}/pods/${encodeURIComponent(pod)}`);
  if (!p || p.metadata?.labels?.app !== repo) return undefined; // only this app's pods
  return getText(`/api/v1/namespaces/${namespace}/pods/${encodeURIComponent(pod)}/log?tailLines=${Math.min(Math.max(tail, 10), 1000)}&timestamps=true${previous ? '&previous=true' : ''}`);
}
