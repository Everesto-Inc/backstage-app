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
  cronJobs?: CronJob[];
  oneOffJobs?: Run[];
} | undefined;
type Run = { name: string; status: 'running' | 'succeeded' | 'failed'; startAgeSec?: number; durationSec?: number; pod?: string };
type CronJob = {
  name: string; schedule: string; scheduleText: string; suspended: boolean; active: number;
  lastScheduleAgeSec?: number; lastSuccessAgeSec?: number; nextRunInSec?: number; runs: Run[];
};
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
const secs = (s?: number) => {
  if (s === undefined) return '—';
  return s < 90 ? `${s} s` : dur(s);
};
const RUN_COLOR = { failed: STATUS.critical, running: STATUS.warning, succeeded: STATUS.good };
const runColor = (r?: Run) => (r ? RUN_COLOR[r.status] : 'rgba(128,128,128,0.4)');
const nextRun = (c: CronJob) => (c.suspended || c.nextRunInSec === undefined ? '—' : `in ${secs(c.nextRunInSec)}`);
const th = { textAlign: 'left', padding: '6px 8px', fontSize: 12, opacity: 0.7, fontWeight: 600 } as const;
const td = { padding: '8px', borderTop: '1px solid rgba(128,128,128,0.15)', fontSize: 14, verticalAlign: 'middle' } as const;
const box = { p: 2, borderRadius: 12, style: { border: '1px solid rgba(128,128,128,0.25)' } } as const;
const row = { display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0', borderTop: '1px solid rgba(128,128,128,0.15)', fontSize: 14 } as const;

/** CronJobs of the app (+ one-off jobs like migrations): when they run, how the last runs went, their logs. */
const ScheduledJobs = ({ env, k8s, openLogs }: { env: string; k8s: K8s; openLogs: (env: string, pod: string) => void }) => {
  const crons = k8s?.cronJobs ?? [];
  const oneOff = k8s?.oneOffJobs ?? [];
  if (!crons.length && !oneOff.length) return null;
  const running = crons.reduce((n, c) => n + c.active, 0);
  const failing = crons.filter(c => c.runs[0]?.status === 'failed');
  const Dot = ({ r, onClick }: { r?: Run; onClick?: () => void }) => {
    const label = r ? `${r.name} · ${r.status} · ${secs(r.durationSec)} · ${dur(r.startAgeSec)} ago` : 'no run yet';
    const style = { display: 'inline-block', width: 12, height: 12, borderRadius: 6, margin: '0 2px', padding: 0, border: 0, background: runColor(r) };
    return onClick
      ? <button type="button" title={`${label} — logs`} aria-label={`${label}, open logs`} onClick={onClick} style={{ ...style, cursor: 'pointer' }} />
      : <span title={label} style={style} />;
  };
  return (
    <>
      <Box display="flex" alignItems="baseline" style={{ marginTop: 16, gap: 12 }}>
        <Typography variant="subtitle2">Scheduled jobs</Typography>
        <Typography variant="caption" color="textSecondary">
          {crons.length} CronJob{crons.length === 1 ? '' : 's'} · {running} running now ·{' '}
          <span style={{ color: failing.length ? STATUS.critical : undefined }}>{failing.length} failed last time</span> · times in UTC
        </Typography>
      </Box>
      {crons.length > 0 && (
        <Box style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
            <thead><tr>
              <th style={th}>Job</th><th style={th}>Runs</th><th style={th}>Last run</th><th style={th}>Next run</th>
              <th style={th}>Last 8 (newest left · click = logs)</th><th style={th} />
            </tr></thead>
            <tbody>
              {crons.map(c => {
                const last = c.runs[0];
                return (
                  <tr key={c.name}>
                    <td style={td}><code>{c.name}</code>{c.suspended && <span style={{ marginLeft: 6, color: STATUS.warning, fontSize: 12 }}>paused</span>}</td>
                    <td style={td} title={c.schedule}>{c.scheduleText}</td>
                    <td style={td}>
                      {last ? (
                        <span><Dot r={last} /> <b style={{ color: runColor(last) }}>{last.status}</b>{' '}
                          <Typography variant="caption" color="textSecondary">{dur(last.startAgeSec)} ago · took {secs(last.durationSec)}</Typography></span>
                      ) : <Typography variant="caption" color="textSecondary">never</Typography>}
                    </td>
                    <td style={td}>{nextRun(c)}</td>
                    <td style={td}>
                      {c.runs.map(r => <Dot key={r.name} r={r} onClick={r.pod ? () => openLogs(env, r.pod!) : undefined} />)}
                      {!c.runs.length && <Typography variant="caption" color="textSecondary">no runs kept</Typography>}
                    </td>
                    <td style={td}>{last?.pod && <Button size="small" variant="outlined" onClick={() => openLogs(env, last.pod!)}>Logs</Button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Box>
      )}
      {oneOff.length > 0 && (
        <>
          <Typography variant="caption" color="textSecondary" component="div" style={{ marginTop: 10 }}>One-off jobs (e.g. database migrations on Sync)</Typography>
          {oneOff.map(j => (
            <div key={j.name} style={row}>
              <Dot r={j} />
              <code style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{j.name}</code>
              <span style={{ fontWeight: 600, color: runColor(j) }}>{j.status}</span>
              <Typography variant="caption" color="textSecondary">{dur(j.startAgeSec)} ago · took {secs(j.durationSec)}</Typography>
              {j.pod && <Button size="small" variant="outlined" onClick={() => openLogs(env, j.pod!)}>Logs</Button>}
            </div>
          ))}
        </>
      )}
      <Typography variant="caption" color="textSecondary" component="div" style={{ marginTop: 4 }}>
        Kubernetes keeps the last runs only (successful 1, failed 2 per job by default) — older logs are in Grafana → Loki.
      </Typography>
    </>
  );
};

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

                    <ScheduledJobs env={env} k8s={k8s} openLogs={openLogs} />

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

