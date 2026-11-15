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
