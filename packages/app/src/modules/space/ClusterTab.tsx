import { useState } from 'react';
import { useEveresto } from './api';
import { Entity } from '@backstage/catalog-model';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Grid, Typography } from '@material-ui/core';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import { STATUS, StatTile } from '../tools/charts';
import { insightsTarget, nsOf } from './insights';
import { StatusChain } from './StatusChain';

/**
 * Deployment → CD tab: live cluster view of dev + prod (ArgoCD status, deployment, pods, warnings, logs).
 * Served by the everesto backend: only the app's namespaces, only for members of the project.
 */
type Argo = { exists: boolean; sync?: string; health?: string; lastSyncAt?: string; lastSyncPhase?: string; lastSyncMessage?: string } | undefined;
type K8s = {
  readable: boolean; namespace: string;
  deployments?: { name: string; replicas: number; ready: number; image?: string }[];
  pods?: { name: string; phase?: string; ready: boolean; restarts: number; lastTermination?: string; ageSec?: number; node?: string }[];
  events?: { reason: string; message: string; object: string; count: number; ageSec?: number }[];
} | undefined;
type Data = { clusterAccess: boolean; envs: { env: 'dev' | 'prod'; argo: Argo; k8s: K8s }[] };

const dur = (s?: number) => {
  if (s === undefined) return '—';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
};
const color = (good: boolean, bad: boolean) => {
  if (good) return STATUS.good;
  return bad ? STATUS.critical : STATUS.warning;
};
const box = { p: 2, borderRadius: 12, style: { border: '1px solid rgba(128,128,128,0.25)' } } as const;
const row = { display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0', borderTop: '1px solid rgba(128,128,128,0.15)', fontSize: 14 } as const;

export const ClusterTab = ({ entity }: { entity: Entity }) => {
  const repo = insightsTarget(entity).repo;

  const [logs, setLogs] = useState<{ env: string; pod: string; previous: boolean; text?: string; error?: string } | undefined>();

  const api = useEveresto();
  const get = (path: string) => api('GET', `/apps/${encodeURIComponent(repo)}${path}`);
  const data = useAsyncRetry(async (): Promise<Data> => get('/k8s'), [repo]);
  const openLogs = async (env: string, pod: string, previous = false) => {
    setLogs({ env, pod, previous });
    try {
      const r = await get(`/k8s/logs?env=${env}&pod=${encodeURIComponent(pod)}&tail=300${previous ? '&previous=1' : ''}`);
      setLogs({ env, pod, previous, text: r.log || '(empty)' });
    } catch (e: any) { setLogs({ env, pod, previous, error: e.message }); }
  };

  if (data.loading && !data.value) return <Typography color="textSecondary">Loading cluster…</Typography>;
  if (data.error) return <Typography style={{ color: STATUS.critical }}>{data.error.message}</Typography>;
  const d = data.value!;
  if (!d.clusterAccess) return <Typography color="textSecondary">No cluster access from this Backstage (local dev) — available in prod.</Typography>;

  return (
    <Box>
      <Typography variant="h5" style={{ marginBottom: 8 }}>Status</Typography>
      <StatusChain entity={entity} />
      <Typography variant="h5" style={{ margin: '24px 0 8px' }}>Cluster details</Typography>
      <Box display="flex" alignItems="center" mb={1}>
        <Typography variant="body2" color="textSecondary">Live, read-only · only {nsOf(entity, 'dev')} / {nsOf(entity, 'prod')} · refreshed when you open the tab</Typography>
        <Box ml="auto"><Button size="small" onClick={data.retry}>Refresh</Button></Box>
      </Box>
      <Grid container spacing={2}>
        {d.envs.map(({ env, argo, k8s }) => {
          const dep = k8s?.deployments?.[0];
          const synced = argo?.sync === 'Synced';
          const healthy = argo?.health === 'Healthy';
          return (
            <Grid item xs={12} key={env}>
              <Box {...box}>
                <Typography variant="h6">{env} · ns {nsOf(entity, env)}</Typography>
                {!argo?.exists ? (
                  <Typography variant="body2" color="textSecondary">
                    ArgoCD app {env}-{repo} not created yet{env === 'prod' ? ' — first Promote to prod, then the setup commands (Secrets tab)' : ''}.
                  </Typography>
                ) : (
                  <>
                    <Grid container spacing={2} style={{ marginTop: 4 }}>
                      <Grid item xs={12} md={3}>
                        <StatTile label={`ArgoCD ${env}-${repo}`} value={<span style={{ fontSize: 18, color: color(synced && healthy, argo.health === 'Degraded' || argo.lastSyncPhase === 'Failed') }}>{argo.sync ?? '?'} · {argo.health ?? '?'}</span>}
                          delta={argo.lastSyncAt ? `last sync ${dur(Math.round((Date.now() - Date.parse(argo.lastSyncAt)) / 1000))} ago${argo.lastSyncPhase ? ` · ${argo.lastSyncPhase}` : ''}` : 'never synced'} />
                      </Grid>
                      <Grid item xs={12} md={3}>
                        <StatTile label="Replicas ready" value={dep ? <span style={{ color: color(dep.ready === dep.replicas && dep.replicas > 0, dep.ready === 0) }}>{dep.ready} / {dep.replicas}</span> : '—'}
                          delta={k8s?.readable === false ? 'namespace not readable yet — the platform creates its read permission with the app (~3 min)' : undefined} />
                      </Grid>
                      <Grid item xs={12} md={6}>
                        <StatTile label="Image running" value={<span style={{ fontSize: 14, wordBreak: 'break-all' }}>{dep?.image ?? '—'}</span>} />
                      </Grid>
                    </Grid>
                    {argo.lastSyncMessage && argo.lastSyncPhase !== 'Succeeded' && (
                      <Typography variant="body2" style={{ color: STATUS.critical, marginTop: 8 }}>{argo.lastSyncMessage}</Typography>
                    )}

                    <Typography variant="subtitle2" style={{ marginTop: 16 }}>Pods</Typography>
                    {(k8s?.pods ?? []).length === 0 && <Typography variant="body2" color="textSecondary">no pods — not synced yet?</Typography>}
                    {k8s?.pods?.map(p => {
                      const ok = p.ready && p.phase === 'Running';
                      return (
                        <div key={p.name} style={row}>
                          <span style={{ width: 10, height: 10, borderRadius: 5, background: color(ok, !p.ready && p.phase !== 'Pending') }} />
                          <code style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</code>
                          <span style={{ fontWeight: 600 }}>{p.phase}</span>
                          <span>restarts {p.restarts}{p.lastTermination ? ` (${p.lastTermination})` : ''}</span>
                          <Typography variant="caption" color="textSecondary">{dur(p.ageSec)} · {p.node}</Typography>
                          <Button size="small" variant="outlined" onClick={() => openLogs(env, p.name)}>Logs</Button>
                          {p.restarts > 0 && <Button size="small" onClick={() => openLogs(env, p.name, true)}>Previous logs</Button>}
                        </div>
                      );
                    })}

                    {(k8s?.events ?? []).length > 0 && (
                      <>
                        <Typography variant="subtitle2" style={{ marginTop: 16, color: STATUS.warning }}>Warnings</Typography>
                        {k8s!.events!.map((e, i) => (
                          <div key={i} style={row}>
                            <b style={{ width: 150 }}>{e.reason}{e.count > 1 ? ` ×${e.count}` : ''}</b>
                            <span style={{ flex: 1 }}>{e.message}</span>
                            <Typography variant="caption" color="textSecondary">{e.object} · {dur(e.ageSec)} ago</Typography>
                          </div>
                        ))}
                      </>
                    )}
                  </>
                )}
              </Box>
            </Grid>
          );
        })}
      </Grid>

      <Dialog open={!!logs} onClose={() => setLogs(undefined)} maxWidth="lg" fullWidth>
        <DialogTitle>{logs?.previous ? 'Previous logs' : 'Logs'} · {logs?.pod} · {logs?.env} (last 300 lines)</DialogTitle>
        <DialogContent>
          {logs?.error && <Typography style={{ color: STATUS.critical }}>{logs.error}</Typography>}
          {!logs?.text && !logs?.error && <Typography color="textSecondary">Loading…</Typography>}
          {logs?.text && (
            <Box component="pre" m={0} p={1.5} style={{ background: 'rgba(128,128,128,0.12)', borderRadius: 8, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '65vh', overflow: 'auto' }}>
              {logs.text}
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          {logs && <Button onClick={() => openLogs(logs.env, logs.pod, logs.previous)}>Reload</Button>}
          <Button onClick={() => setLogs(undefined)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};
