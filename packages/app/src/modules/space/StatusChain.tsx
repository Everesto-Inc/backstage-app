import { useEffect, useState } from 'react';
import { Entity } from '@backstage/catalog-model';
import { alertApiRef, useApi, useRouteRef } from '@backstage/core-plugin-api';
import { entityRouteRef } from '@backstage/plugin-catalog-react';
import { Box, Button, CircularProgress, Link, Typography } from '@material-ui/core';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import { STATUS } from '../tools/charts';
import { useEveresto } from './api';
import { useSpaceRole } from './data';
import { insightsTarget } from './insights';

/**
 * "Where is my deployment?" — the status chain from the backend (GET /apps/:repo/status), in plain words:
 * done ✓ · waiting ⏳ (with time left, refreshes itself) · needs you ✕ (with the button) · not reached yet ○.
 */
type StepState = 'ok' | 'wait' | 'fail' | 'off' | 'unknown';
type Step = { id: string; title: string; state: StepState; detail: string; etaSec?: number;
  fix?: { text: string; action?: string; url?: string } };
export type EnvStatus = { env: 'dev' | 'prod'; namespace: string; steps: Step[] };

const ICON: Record<StepState, string> = { ok: '✓', wait: '⏳', fail: '✕', off: '○', unknown: '?' };
const colorOf = (s: StepState) => ({ ok: STATUS.good, wait: STATUS.warning, fail: STATUS.critical, off: 'inherit', unknown: 'inherit' }[s]);
const mins = (sec: number) => (sec < 60 ? `${sec} s` : `~${Math.ceil(sec / 60)} min`);

/** Status of both environments; refreshes every 20 s while something is pending. */
export const useStatusOf = (repo: string) => {
  const api = useEveresto();
  const data = useAsyncRetry(async (): Promise<EnvStatus[]> => (await api('GET', `/apps/${encodeURIComponent(repo)}/status`)).envs, [repo]);
  const pending = data.value?.some(e => e.steps.some(s => s.state === 'wait'));
  const [loadedAt, setLoadedAt] = useState(Date.now());
  useEffect(() => { if (data.value) setLoadedAt(Date.now()); }, [data.value]);
  const { retry } = data;
  useEffect(() => {
    if (!pending) return undefined;
    const t = setTimeout(retry, 20_000);
    return () => clearTimeout(t);
  }, [pending, retry, loadedAt]);
  return { ...data, loadedAt };
};

export const useStatus = (entity: Entity) => useStatusOf(insightsTarget(entity).repo);

/** One-line summary for a card: "Running" / "⏳ Cluster access to secrets · ~2 min" / "✕ Needs you: …". */
export const summarize = (e?: EnvStatus) => {
  if (!e) return undefined;
  const next = e.steps.find(s => s.state === 'fail' || s.state === 'wait');
  if (!next) {
    const offOnly = e.steps.every(s => s.state === 'off' || s.state === 'unknown');
    return offOnly ? undefined : { state: 'ok' as StepState, text: e.steps.some(s => s.id === 'url' && s.state === 'ok') ? 'Running · reachable' : 'Running' };
  }
  return next.state === 'fail'
    ? { state: 'fail' as StepState, text: `Needs you: ${next.title} — ${next.fix?.text ?? next.detail}` }
    : { state: 'wait' as StepState, text: `${next.title}${next.etaSec ? ` · ${mins(next.etaSec)}` : ''}${next.fix?.action === 'argocd-sync' ? ' — click Sync in ArgoCD' : ''}` };
};

export const StatusLine = ({ env }: { env?: EnvStatus }) => {
  const s = summarize(env);
  if (!s) return null;
  return (
    <Box mt={0.5} style={{ fontSize: 13, fontWeight: 600, color: colorOf(s.state) }}>
      {ICON[s.state]} {s.text}
    </Box>
  );
};

/** Same, by name — used right after Create deployment, before the catalog entry exists. */
export const StatusChainOf = ({ repo, project }: { repo: string; project: string }) => {
  const api = useEveresto();
  const alertApi = useApi(alertApiRef);
  const entityRoute = useRouteRef(entityRouteRef);
  const roles = useSpaceRole(project);
  const status = useStatusOf(repo);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const elapsed = Math.round((now - status.loadedAt) / 1000);

  const renew = async () => {
    setBusy(true);
    try {
      await api('POST', `/apps/${encodeURIComponent(repo)}/deployment/eso-login`);
      alertApi.post({ message: 'Cluster access renewed — the cluster picks it up within 5 minutes. This page updates by itself.', severity: 'success', display: 'transient' });
      status.retry();
    } catch (e: any) { alertApi.post({ message: `Renew cluster access failed: ${e.message}`, severity: 'error' }); } finally { setBusy(false); }
  };
  const secretsHref = `${entityRoute({ namespace: 'default', kind: 'resource', name: `${repo}-gitops` })}/secrets`;

  const fixOf = (s: Step) => {
    if (!s.fix) return null;
    const a = s.fix.action;
    let button: JSX.Element | null = null;
    if (a === 'renew-access') {
      button = roles.maintainer
        ? <Button size="small" variant="contained" color="primary" disabled={busy} onClick={renew}>Renew cluster access</Button>
        : <Typography variant="caption">Ask a maintainer of {project}.</Typography>;
    } else if (a === 'argocd-sync' && s.fix.url) {
      button = <Button size="small" variant="contained" color="primary" href={s.fix.url} target="_blank" rel="noopener">Open in ArgoCD</Button>;
    } else if (a === 'secrets') {
      button = <Button size="small" variant="outlined" href={secretsHref}>Open Secrets</Button>;
    }
    return (
      <Box display="flex" alignItems="center" mt={0.5} style={{ gap: 8, flexWrap: 'wrap' }}>
        <Typography variant="body2">→ {s.fix.text}</Typography>
        {button}
      </Box>
    );
  };

  if (status.loading && !status.value) return <Box display="flex" alignItems="center" style={{ gap: 8 }}><CircularProgress size={16} /><Typography variant="body2">Checking status…</Typography></Box>;
  if (status.error) return <Typography variant="body2" style={{ color: STATUS.critical }}>Status not available: {status.error.message}</Typography>;

  return (
    <Box>
      {status.value!.filter(e => !(e.env === 'prod' && e.steps[0]?.state === 'off')).map(e => (
        <Box key={e.env} mb={2} p={2} borderRadius={12} style={{ border: '1px solid rgba(128,128,128,0.25)' }}>
          <Box display="flex" alignItems="center" mb={1}>
            <Typography variant="h6">{e.env} · {e.namespace}</Typography>
            <Box ml={2}><StatusLine env={e} /></Box>
            <Box ml="auto"><Button size="small" onClick={status.retry}>Check now</Button></Box>
          </Box>
          {e.steps.map(s => (
            <Box key={s.id} display="flex" py={0.75} style={{ gap: 12, borderTop: '1px solid rgba(128,128,128,0.15)', opacity: s.state === 'off' ? 0.55 : 1 }}>
              <Box width={22} style={{ color: colorOf(s.state), fontWeight: 700, textAlign: 'center' }}>{ICON[s.state]}</Box>
              <Box flex={1} minWidth={0}>
                <Typography variant="body2" style={{ fontWeight: 600 }}>
                  {s.title}
                  {s.state === 'wait' && s.etaSec !== undefined && (
                    <span style={{ fontWeight: 400, color: STATUS.warning }}> · {s.etaSec - elapsed > 0 ? `about ${mins(s.etaSec - elapsed)} left` : 'any moment now'}</span>
                  )}
                </Typography>
                <Typography variant="body2" color="textSecondary">{s.detail}</Typography>
                {fixOf(s)}
              </Box>
            </Box>
          ))}
        </Box>
      ))}
      <Typography variant="caption" color="textSecondary">
        Updates by itself every 20 s while something is in progress. ArgoCD reads git every 3 min, secrets refresh every 5 min.
        {' '}<Link href="https://argocd.everesto.live" target="_blank" rel="noopener">ArgoCD</Link>
      </Typography>
    </Box>
  );
};

export const StatusChain = ({ entity }: { entity: Entity }) => (
  <StatusChainOf repo={insightsTarget(entity).repo} project={String(entity.spec?.system ?? '')} />
);
