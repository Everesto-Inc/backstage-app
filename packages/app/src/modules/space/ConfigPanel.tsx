import { useEffect, useState } from 'react';
import { alertApiRef, useApi } from '@backstage/core-plugin-api';
import { Box, Button, IconButton, TextField, Typography } from '@material-ui/core';
import AddIcon from '@material-ui/icons/Add';
import Close from '@material-ui/icons/Close';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import { useEveresto } from './api';
import { BusyBar, BusyButton } from './Busy';
import { STATUS } from '../tools/charts';

/**
 * Deployment → Secrets tab → Config: the plain (non-secret) environment variables of the deployment
 * (`env:` of <app>-gitops/apps/<env>/deployment.yaml). Save = one commit to the gitops repo → Sync in ArgoCD.
 * dev: developers / maintainers / managers · prod: managers (enforced by the backend).
 */
type Env = 'dev' | 'prod';
type Var = { name: string; value: string };
type List = { env: Env; vars: Var[]; editable: boolean; canEdit: boolean; reason?: string };
const VAR = /^[A-Z][A-Z0-9_]{0,63}$/;

export const ConfigPanel = ({ repo, env }: { repo: string; env: Env }) => {
  const alertApi = useApi(alertApiRef);
  const api = useEveresto();
  const list = useAsyncRetry(async (): Promise<List> => api('GET', `/apps/${encodeURIComponent(repo)}/config?env=${env}`), [repo, env]);
  const [rows, setRows] = useState<Var[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | undefined>();
  useEffect(() => { setRows(list.value?.vars ?? []); setSaved(undefined); }, [list.value]);

  const d = list.value;
  const edit = !!d?.editable && !!d?.canEdit;
  const dirty = JSON.stringify(rows) !== JSON.stringify(d?.vars ?? []);
  const names = rows.map(r => r.name);
  const valid = rows.every(r => VAR.test(r.name) && !/[\r\n]/.test(r.value)) && new Set(names).size === names.length;

  const save = async () => {
    setBusy(true);
    try {
      const r = await api('POST', `/apps/${encodeURIComponent(repo)}/config`, { env, vars: rows });
      setSaved(r.changed ? `Committed — now Sync ${r.argocdApp} in ArgoCD (the app restarts with the new values).` : 'Nothing changed.');
      list.retry();
    } catch (e: any) {
      alertApi.post({ message: e.message, severity: 'error' });
    } finally { setBusy(false); }
  };

  return (
    <Box mt={2} p={2} borderRadius={12} style={{ border: '1px solid rgba(128,128,128,0.25)' }}>
      <Box display="flex" alignItems="center">
        <Typography variant="subtitle2">Config — plain environment variables · {env} (in git, not secret)</Typography>
        {edit && <Box ml="auto"><Button size="small" color="primary" variant="outlined" startIcon={<AddIcon />} onClick={() => setRows([...rows, { name: '', value: '' }])}>Add</Button></Box>}
      </Box>
      <Typography variant="caption" color="textSecondary">
        Written into apps/{env}/deployment.yaml of {repo}-gitops — visible to everyone who can read the repo. Never put a secret here.
        A config value wins over a secret of the same name.
      </Typography>
      {list.loading && <Box mt={1}><BusyBar busy hint={`Loading ${env} config…`} /></Box>}
      {list.error && <Typography variant="body2" style={{ color: STATUS.critical }}>{list.error.message}</Typography>}
      {d?.reason && <Typography variant="body2" color="textSecondary" style={{ marginTop: 8 }}>{d.reason}</Typography>}
      {d && d.editable && rows.length === 0 && <Typography variant="body2" color="textSecondary" style={{ marginTop: 8 }}>No config in {env}.</Typography>}

      {rows.map((r, i) => (
        <Box key={i} display="flex" style={{ gap: 8 }} mt={1}>
          <TextField size="small" variant="outlined" placeholder="NAME" value={r.name} disabled={!edit} style={{ flex: 1 }}
            error={!!r.name && !VAR.test(r.name)}
            onChange={e => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value.toUpperCase().replaceAll(/[^A-Z0-9_]/g, '_') } : x)))} />
          <TextField size="small" variant="outlined" placeholder="value" value={r.value} disabled={!edit} style={{ flex: 1.6 }}
            onChange={e => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
          {edit ? <IconButton size="small" aria-label={`Remove ${r.name}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}><Close fontSize="small" /></IconButton> : <Box width={30} />}
        </Box>
      ))}

      {d && d.editable && !d.canEdit && (
        <Typography variant="caption" color="textSecondary" component="div" style={{ marginTop: 8 }}>
          Changing {env} config needs {env === 'prod' ? 'manager' : 'developer, maintainer or manager'} rights.
        </Typography>
      )}
      {edit && (
        <Box mt={1.5} display="flex" alignItems="center" style={{ gap: 8 }}>
          <BusyButton color="primary" variant="contained" disableElevation busy={busy} busyLabel="Committing…" disabled={!dirty || !valid} onClick={save}>
            Save {env} config
          </BusyButton>
          {dirty && <Button onClick={() => setRows(d?.vars ?? [])} disabled={busy}>Reset</Button>}
          {env === 'prod' && dirty && <Typography variant="body2" style={{ color: STATUS.warning }}>This changes PROD.</Typography>}
          {!valid && <Typography variant="caption" style={{ color: STATUS.critical }}>Names: A-Z 0-9 _, each once · values: one line</Typography>}
        </Box>
      )}
      {saved && <Typography variant="body2" style={{ marginTop: 8, color: STATUS.good }}>{saved}</Typography>}
    </Box>
  );
};
