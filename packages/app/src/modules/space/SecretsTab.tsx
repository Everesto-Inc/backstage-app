import { useState } from 'react';
import { Entity } from '@backstage/catalog-model';
import { alertApiRef, discoveryApiRef, fetchApiRef, useApi } from '@backstage/core-plugin-api';
import {
  Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Link, TextField, Typography,
} from '@material-ui/core';
import Lock from '@material-ui/icons/Lock';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import useAsync from 'react-use/esm/useAsync';
import { STATUS } from '../tools/charts';
import { CmdBox } from './CreateDeploymentDialog';
import { SetupStep, SetupSteps } from './CdActions';
import { ago, insightsTarget, nsOf } from './insights';
import { useSpaceRole } from './data';

/**
 * Deployment → Secrets tab (real). Infisical project <app>-gitops, env dev / prod.
 * Names + last change only; values are write-only (never sent to the browser).
 * dev: developers / maintainers / owners · prod: maintainers / owners (enforced by the backend).
 */
type Env = 'dev' | 'prod';
type List = { env: Env; canEdit: boolean; secrets: { name: string; updatedAt: string; placeholder: boolean }[]; applyCmd: string; infisicalUrl: string };
const VAR = /^[A-Z][A-Z0-9_]{0,63}$/;

export const SecretsTab = ({ entity }: { entity: Entity }) => {
  const discovery = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const alertApi = useApi(alertApiRef);
  const repo = insightsTarget(entity).repo;
  const project = String(entity.spec?.system ?? '');
  const [env, setEnv] = useState<Env>('dev');
  const [edit, setEdit] = useState<{ name: string; isNew: boolean } | undefined>();
  const [value, setValue] = useState('');
  const [newName, setNewName] = useState('');
  const [del, setDel] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [applyCmd, setApplyCmd] = useState<string | undefined>();
  const [esoCmd, setEsoCmd] = useState<string | undefined>();

  const isMaintainer = useSpaceRole(project).maintainer; // includes entity admins

  const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const base = await discovery.getBaseUrl('everesto');
    const res = await fetchApi.fetch(`${base}/apps/${encodeURIComponent(repo)}${path}`, {
      method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json;
  };
  const list = useAsyncRetry(async (): Promise<List> => call('GET', `/secrets?env=${env}`), [env, repo]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); list.retry(); } catch (e: any) { alertApi.post({ message: e.message, severity: 'error' }); } finally { setBusy(false); }
  };

  const save = () => run(async () => {
    const name = edit!.isNew ? newName : edit!.name;
    const r = await call('POST', '/secrets', { env, name, value });
    setApplyCmd(r.applyCmd);
    alertApi.post({ message: `${name} saved in ${env} — run the command below (or wait for the next deploy)`, severity: 'success', display: 'transient' });
    setEdit(undefined); setValue(''); setNewName('');
  });
  const remove = () => run(async () => {
    const r = await call('POST', '/secrets/delete', { env, name: del });
    setApplyCmd(r.applyCmd);
    setDel(undefined);
  });
  const newLogin = () => run(async () => setEsoCmd((await call('POST', '/deployment/eso-login')).cmd));

  const { value: steps = [] } = useAsync(async (): Promise<SetupStep[]> => (await call('GET', '/deployment/setup')).commands, [repo]);
  const d = list.value;
  const canEdit = !!d?.canEdit;
  const row = { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderTop: '1px solid rgba(128,128,128,0.15)' } as const;

  return (
    <Box maxWidth={980}>
      <Box display="flex" alignItems="center" style={{ gap: 8 }} mb={2}>
        {(['dev', 'prod'] as Env[]).map(e => (
          <Button key={e} size="small" variant={env === e ? 'contained' : 'outlined'} color="primary" disableElevation
            onClick={() => { setEnv(e); setApplyCmd(undefined); }}>
            {e} · {nsOf(entity, e)}
          </Button>
        ))}
        <Typography variant="caption" color="textSecondary" style={{ marginLeft: 8 }}>
          {env === 'prod' ? 'prod: only managers can change secrets' : 'dev: developers, maintainers and managers can change secrets'}
        </Typography>
        {d?.infisicalUrl && <Box ml="auto"><Link href={d.infisicalUrl} target="_blank" rel="noopener">Open in Infisical</Link></Box>}
      </Box>

      <Box p={2} borderRadius={12} style={{ border: '1px solid rgba(128,128,128,0.25)' }}>
        <Box display="flex" alignItems="center">
          <Typography variant="subtitle2">Secrets — Infisical {repo}-gitops / {env} → Kubernetes Secret {repo}</Typography>
          {canEdit && <Box ml="auto"><Button size="small" color="primary" variant="outlined" onClick={() => { setEdit({ name: '', isNew: true }); setNewName(''); setValue(''); }}>Add secret</Button></Box>}
        </Box>
        {list.loading && <Typography variant="body2" color="textSecondary">Loading…</Typography>}
        {list.error && <Typography variant="body2" style={{ color: STATUS.critical }}>{list.error.message}</Typography>}
        {d && d.secrets.length === 0 && <Typography variant="body2" color="textSecondary">No secrets in {env} yet.</Typography>}
        {d?.secrets.map(s => (
          <div key={s.name} style={row}>
            <Lock style={{ fontSize: 16, opacity: 0.6 }} />
            <code style={{ flex: 1 }}>{s.name}</code>
            {s.placeholder && <span style={{ color: STATUS.warning, fontSize: 12, fontWeight: 600 }}>CHANGE_ME — not set yet</span>}
            <Typography variant="caption" color="textSecondary">changed {ago(s.updatedAt)}</Typography>
            {canEdit && (
              <>
                <Button size="small" variant="outlined" onClick={() => { setEdit({ name: s.name, isNew: false }); setValue(''); }}>Change value</Button>
                <Button size="small" style={{ color: STATUS.critical }} onClick={() => setDel(s.name)}>Delete</Button>
              </>
            )}
          </div>
        ))}
        {d && !canEdit && <Typography variant="caption" color="textSecondary">You can see the names; changing {env} secrets needs {env === 'prod' ? 'manager' : 'developer, maintainer or manager'} rights in {project}.</Typography>}
        <Typography variant="caption" color="textSecondary" component="div" style={{ marginTop: 8 }}>
          Values are never shown here — only written. ESO syncs within 5 minutes; the pod reads them at start.
        </Typography>
      </Box>

      <Box mt={2}>
        <CmdBox title={`After changing a secret — apply it now (force ESO sync + restart ${repo} in ${nsOf(entity, env)}). Only works once the app runs there: first setup = Edit deployment → Setup commands, then Sync.`} cmd={applyCmd ?? d?.applyCmd ?? ''} />
      </Box>

      <Box mt={3} p={2} borderRadius={12} style={{ border: '1px solid rgba(128,128,128,0.25)' }}>
        <Typography variant="subtitle2">Setup commands · {env} (control plane, <code>ssho control-plane</code>) — in order, safe to re-run</Typography>
        <Typography variant="caption" color="textSecondary">
          Use them whenever the app does not exist yet in {nsOf(entity, env)}. Explained in detail in the Tech Docs tab of {repo}-gitops.
        </Typography>
        <SetupSteps steps={steps.filter(x => x.env === 'once' || x.env === env)} />
      </Box>

      {isMaintainer && (
        <Box mt={3} p={2} borderRadius={12} style={{ border: '1px solid rgba(128,128,128,0.25)' }}>
          <Typography variant="subtitle2">ESO login (identity eso-{repo})</Typography>
          <Typography variant="body2" color="textSecondary">
            The cluster reads these secrets with the Kubernetes secret <code>infisical-{repo}-auth</code>. Lost it, new cluster, or rotating?
            Create a new client secret — the command (client ID + client secret) is shown once.
          </Typography>
          <Box mt={1}><Button size="small" variant="outlined" disabled={busy} onClick={newLogin}>New ESO login</Button></Box>
          {esoCmd && (
            <>
              <CmdBox title={`Infisical login for ESO (eso-${repo}) — shown ONCE, copy it now`} cmd={esoCmd} secret />
              <Typography variant="caption" style={{ color: STATUS.critical }}>Not stored anywhere — gone when you leave this page.</Typography>
            </>
          )}
        </Box>
      )}

      <Dialog open={!!edit} onClose={busy ? undefined : () => setEdit(undefined)} maxWidth="sm" fullWidth>
        <DialogTitle>{edit?.isNew ? `Add secret · ${env}` : `Change ${edit?.name} · ${env}`}</DialogTitle>
        <DialogContent>
          {edit?.isNew && (
            <TextField fullWidth size="small" variant="outlined" margin="dense" label="Name" value={newName} error={!!newName && !VAR.test(newName)}
              onChange={e => setNewName(e.target.value.toUpperCase().replaceAll(/[^A-Z0-9_]/g, '_'))} helperText="A-Z 0-9 _ — becomes an environment variable" />
          )}
          <TextField fullWidth size="small" variant="outlined" margin="dense" label="Value" type="password" autoComplete="new-password"
            value={value} onChange={e => setValue(e.target.value)} helperText={`Written to Infisical ${repo}-gitops / ${env}. Not stored in Backstage.`} />
          {env === 'prod' && <Typography variant="body2" style={{ color: STATUS.warning, marginTop: 8 }}>This changes PROD.</Typography>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEdit(undefined)} disabled={busy}>Cancel</Button>
          <Button color="primary" variant="contained" disableElevation disabled={busy || !value || (edit?.isNew && !VAR.test(newName))} onClick={save}>Save</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!del} onClose={busy ? undefined : () => setDel(undefined)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete {del} · {env}?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">The variable disappears from the pod after the next sync + restart. If the app needs it, it may fail to start.</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDel(undefined)} disabled={busy}>Cancel</Button>
          <Button variant="contained" disableElevation disabled={busy} style={{ background: STATUS.critical, color: '#fff' }} onClick={remove}>Delete</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};
