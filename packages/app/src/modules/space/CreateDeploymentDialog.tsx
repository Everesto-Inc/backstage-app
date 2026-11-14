import { useState } from 'react';
import { Entity } from '@backstage/catalog-model';
import { alertApiRef, discoveryApiRef, fetchApiRef, useApi } from '@backstage/core-plugin-api';
import {
  Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Grid,
  IconButton, MenuItem, TextField, Tooltip, Typography,
} from '@material-ui/core';
import FileCopy from '@material-ui/icons/FileCopy';
import Close from '@material-ui/icons/Close';
import AddIcon from '@material-ui/icons/Add';
import { ToolLogo } from '../tools/ToolLogo';
import { TOOLS } from '../tools/tools';
import { STATUS } from '../tools/charts';

/**
 * Create deployment (CD) for an existing CI application — maintainers / owners.
 * Infisical first (secrets), then <repo>-gitops with apps/dev. Every sync is manual.
 * Backend: POST /api/everesto/apps/:repo/deployment (packages/backend/src/modules/everestoDeploy.ts).
 */
type Result = { done: string[]; tag: string; commands: { title: string; cmd: string; secret?: boolean }[]; infisicalUrl?: string };
type Row = { name: string; value: string };

export const CmdBox = ({ title, cmd, secret }: { title: string; cmd: string; secret?: boolean }) => (
  <Box mt={2}>
    <Typography variant="body2" style={{ fontWeight: 600, color: secret ? STATUS.critical : undefined }}>{title}</Typography>
    <Box display="flex" alignItems="flex-start" style={{ gap: 4 }}>
      <Box component="pre" flex={1} m={0} p={1.5} style={{ background: 'rgba(128,128,128,0.12)', borderRadius: 8, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {cmd}
      </Box>
      <Tooltip title="Copy"><IconButton size="small" onClick={() => navigator.clipboard.writeText(cmd)}><FileCopy fontSize="small" /></IconButton></Tooltip>
    </Box>
  </Box>
);

const VAR = /^[A-Z][A-Z0-9_]{0,63}$/;

const Rows = ({ title, hint, rows, setRows, secret }: { title: string; hint: string; rows: Row[]; setRows: (r: Row[]) => void; secret?: boolean }) => (
  <Box mt={2}>
    <Typography variant="subtitle2">{title}</Typography>
    <Typography variant="caption" color="textSecondary">{hint}</Typography>
    {rows.map((r, i) => (
      <Box key={i} display="flex" style={{ gap: 8 }} mt={1}>
        <TextField size="small" variant="outlined" placeholder="NAME" value={r.name} style={{ flex: 1 }}
          error={!!r.name && !VAR.test(r.name)}
          onChange={e => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') } : x)))} />
        <TextField size="small" variant="outlined" placeholder={secret ? 'value (optional — or set it in Infisical)' : 'value'} value={r.value}
          type={secret ? 'password' : 'text'} autoComplete="new-password" style={{ flex: 1.4 }}
          onChange={e => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
        <IconButton size="small" onClick={() => setRows(rows.filter((_, j) => j !== i))}><Close fontSize="small" /></IconButton>
      </Box>
    ))}
    <Button size="small" startIcon={<AddIcon />} onClick={() => setRows([...rows, { name: '', value: '' }])}>Add</Button>
  </Box>
);

export const CreateDeploymentDialog = ({ project, apps, open, onClose }: {
  project: string; apps: Entity[]; open: boolean; onClose: () => void;
}) => {
  const discovery = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const alertApi = useApi(alertApiRef);
  const candidates = apps.filter(a => a.metadata.annotations?.['everesto.live/image']);
  const [repo, setRepo] = useState('');
  const [secrets, setSecrets] = useState<Row[]>([{ name: 'DATABASE_URL', value: '' }]);
  const [config, setConfig] = useState<Row[]>([]);
  const [port, setPort] = useState('8080');
  const [memory, setMemory] = useState('192');
  const [replicas, setReplicas] = useState('1');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | undefined>();
  const argocd = TOOLS.find(t => t.id === 'cd')!;
  const infisical = TOOLS.find(t => t.id === 'secrets')!;
  const valid = repo && [...secrets, ...config].every(r => !r.name || VAR.test(r.name));

  const create = async () => {
    setBusy(true);
    try {
      const base = await discovery.getBaseUrl('everesto');
      const res = await fetchApi.fetch(`${base}/apps/${encodeURIComponent(repo)}/deployment`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          secrets: secrets.filter(s => s.name), config: config.filter(c => c.name),
          port: Number(port), memoryMi: Number(memory), replicas: Number(replicas),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setResult(json);
    } catch (e: any) {
      alertApi.post({ message: `Create deployment failed: ${e.message}`, severity: 'error' });
    } finally { setBusy(false); }
  };

  const close = () => { setResult(undefined); setRepo(''); setSecrets([{ name: 'DATABASE_URL', value: '' }]); setConfig([]); onClose(); };

  return (
    <Dialog open={open} onClose={busy ? undefined : close} maxWidth="md" fullWidth>
      <DialogTitle>{result ? `Deployment created · ${repo}` : `Create deployment · ${project}`}</DialogTitle>
      <DialogContent>
        {result ? (
          <>
            <Box component="ul" pl={3} m={0} style={{ lineHeight: 1.8 }}>
              {result.done.map(d => <li key={d}>{d}</li>)}
            </Box>
            <Typography variant="subtitle2" style={{ marginTop: 16 }}>Run on the control plane (<code>ssho control-plane</code>), in this order — Backstage has no cluster access. Also available later: Edit deployment and the Tech Docs tab of {repo}-gitops.</Typography>
            {result.commands.map(c => <CmdBox key={c.title} {...c} />)}
            {result.commands.some(c => c.secret) && (
              <Typography variant="body2" style={{ color: STATUS.critical, marginTop: 12 }}>
                The client secret is shown only now and is stored nowhere — copy it before closing. Lost it? Edit deployment → “New ESO login”.
              </Typography>
            )}
            <Typography variant="body2" color="textSecondary" style={{ marginTop: 16 }}>
              Then in ArgoCD: <b>{repo}-dev</b> → <b>Sync</b>. Later: <b>Deploy</b> a newer build, <b>Promote to prod</b> (creates {project}-prod on first use).
              {result.infisicalUrl && <> Secrets: <a href={result.infisicalUrl} target="_blank" rel="noopener">Infisical {repo}-gitops</a> → dev.</>}
            </Typography>
          </>
        ) : (
          <>
            <Box display="flex" alignItems="center" style={{ gap: 16 }} mb={1}>
              <Box display="flex" alignItems="center" style={{ gap: 6 }}><ToolLogo tool={argocd} size={22} /><b>ArgoCD</b></Box>
              <Box display="flex" alignItems="center" style={{ gap: 6 }}><ToolLogo tool={infisical} size={22} /><b>Infisical</b> secrets</Box>
              <Typography variant="caption" color="textSecondary">namespace <b>{project}-dev</b> · manual sync · prod via Promote</Typography>
            </Box>

            <TextField select fullWidth variant="outlined" margin="dense" label="CI application (its image is deployed)" value={repo}
              onChange={e => setRepo(e.target.value)} helperText={candidates.length ? 'Applications of this project that build an image and have no deployment yet' : 'No CI application with an image in this project yet'}>
              {candidates.map(a => <MenuItem key={a.metadata.name} value={a.metadata.name}>{a.metadata.name} — {a.metadata.annotations?.['everesto.live/image']}</MenuItem>)}
            </TextField>

            <Rows title="Secrets → Infisical" secret rows={secrets} setRows={setSecrets}
              hint={`Stored in Infisical project ${repo || '<app>'}-gitops → dev, never in git. Empty value = CHANGE_ME, set it in Infisical later.`} />
            <Rows title="Config (not secret)" rows={config} setRows={setConfig} hint="Plain environment variables, written into the deployment (visible in git), e.g. LOG_LEVEL=info" />

            <Grid container spacing={2} style={{ marginTop: 8 }}>
              <Grid item xs={4}><TextField fullWidth size="small" variant="outlined" label="Container port" value={port} onChange={e => setPort(e.target.value.replace(/\D/g, ''))} /></Grid>
              <Grid item xs={4}><TextField fullWidth size="small" variant="outlined" label="Memory limit (Mi)" value={memory} onChange={e => setMemory(e.target.value.replace(/\D/g, ''))} helperText="64–1024 · nodes are small" /></Grid>
              <Grid item xs={4}><TextField fullWidth size="small" variant="outlined" label="Replicas" value={replicas} onChange={e => setReplicas(e.target.value.replace(/\D/g, ''))} helperText="1–3" /></Grid>
            </Grid>

            {repo && (
              <Box mt={2}>
                <Typography variant="body2">Creates, in this order (stops before git if Infisical fails):</Typography>
                <Box component="ol" pl={3} m={0} style={{ lineHeight: 1.7, fontSize: 14 }}>
                  <li>Infisical project <b>{repo}-gitops</b> → dev with the secrets above + read-only identity eso-{repo}</li>
                  <li>public repo <b>Everesto-Inc/{repo}-gitops</b> — apps/dev with the newest image of {repo} (no secret values)</li>
                  <li>kubectl commands for you: ArgoCD project <b>{project}</b> + app <b>{repo}-dev</b>, secret store</li>
                </Box>
              </Box>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions>
        {result ? <Button color="primary" onClick={close}>Close</Button> : (
          <>
            <Button onClick={close} disabled={busy}>Cancel</Button>
            <Button color="primary" variant="contained" disableElevation disabled={busy || !valid} onClick={create}>{busy ? 'Creating…' : 'Create deployment'}</Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
};
