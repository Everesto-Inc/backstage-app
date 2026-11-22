import { useEffect, useState } from 'react';
import { StatusChainOf } from './StatusChain';
import { useEveresto } from './api';
import { BusyBar, BusyButton, SLOW_HINT } from './Busy';
import { Entity } from '@backstage/catalog-model';
import { alertApiRef, useApi } from '@backstage/core-plugin-api';
import {
  Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Grid,
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
type Row = { name: string; value: string; required?: boolean; hint?: string; example?: string };
type EnvTemplate = { found: boolean; path: string; url: string; vars: { name: string; required: boolean; hint?: string; example?: string }[] };
const REDIS_PROVIDED = ['REDIS_URL', 'REDIS_KEY_PREFIX'];

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

/** Placeholder of a value field: what the user should type (or why it's not needed). */
function valuePlaceholder(r: Row, secret: boolean | undefined, exempt: string[]) {
  if (r.required && exempt.includes(r.name)) return 'set by the Redis switch';
  if (r.example) return `e.g. ${r.example}`;
  if (!secret) return 'value';
  return r.required ? 'value (required)' : 'value (optional — or set it in Infisical)';
}

/** Where the pre-filled secrets came from (or how to get that). */
const TemplateNote = ({ repo, template }: { repo: string; template?: EnvTemplate }) => {
  if (template?.found && !template.vars.length) {
    return <><a href={template.url} target="_blank" rel="noopener">{template.path}</a> has no variables yet — add one <code>NAME=</code> per line (<code># optional</code> for optional ones).</>;
  }
  if (template?.found) {
    const required = template.vars.filter(v => v.required).length;
    return <>Pre-filled from <a href={template.url} target="_blank" rel="noopener">{template.path}</a>: {required} required (fill them), {template.vars.length - required} optional (empty = CHANGE_ME, set later in Infisical).</>;
  }
  if (repo) return <>No {template?.path ?? '.env.example'} in {repo} — add one (one <code>NAME=</code> per line, <code># optional</code> for optional ones) and this list fills itself.</>;
  return <>Pick an application: its <code>.env.example</code> fills this list.</>;
};

const Rows = ({ title, hint, rows, setRows, secret, exempt = [] }: { title: string; hint: React.ReactNode; rows: Row[]; setRows: (r: Row[]) => void; secret?: boolean; exempt?: string[] }) => (
  <Box mt={2}>
    <Typography variant="subtitle2">{title}</Typography>
    <Typography variant="caption" color="textSecondary">{hint}</Typography>
    {rows.map((r, i) => (
      <Box key={i} display="flex" style={{ gap: 8 }} mt={1}>
        <TextField size="small" variant="outlined" placeholder="NAME" value={r.name} style={{ flex: 1 }}
          error={!!r.name && !VAR.test(r.name)} disabled={r.required}
          helperText={r.required ? 'required (.env.example)' : undefined}
          onChange={e => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value.toUpperCase().replaceAll(/[^A-Z0-9_]/g, '_') } : x)))} />
        <TextField size="small" variant="outlined" value={r.value}
          placeholder={valuePlaceholder(r, secret, exempt)}
          error={!!r.required && !exempt.includes(r.name) && !r.value.trim()} disabled={exempt.includes(r.name)}
          helperText={r.hint} type={secret ? 'password' : 'text'} autoComplete="new-password" style={{ flex: 1.4 }}
          onChange={e => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
        {r.required ? <Box width={30} /> : <IconButton size="small" onClick={() => setRows(rows.filter((_, j) => j !== i))}><Close fontSize="small" /></IconButton>}
      </Box>
    ))}
    <Button size="small" startIcon={<AddIcon />} onClick={() => setRows([...rows, { name: '', value: '' }])}>Add</Button>
  </Box>
);

export const CreateDeploymentDialog = ({ project, apps, open, onClose }: {
  project: string; apps: Entity[]; open: boolean; onClose: () => void;
}) => {
  const alertApi = useApi(alertApiRef);
  const candidates = apps.filter(a => a.metadata.annotations?.['everesto.live/image']);
  const [repo, setRepo] = useState('');
  // Secrets come ONLY from the app's .env.example (no built-in defaults)
  const [secrets, setSecrets] = useState<Row[]>([]);
  const [config, setConfig] = useState<Row[]>([]);
  const [port, setPort] = useState('8080');
  const [memory, setMemory] = useState('192');
  const [replicas, setReplicas] = useState('1');
  const [health, setHealth] = useState('/health');
  const [publicUrl, setPublicUrl] = useState(true);
  const [redis, setRedis] = useState(false);
  const [template, setTemplate] = useState<EnvTemplate | undefined>();
  const [nsKey, setNsKey] = useState('');
  const key = (nsKey || repo.split('-')[0] || '').toLowerCase();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | undefined>();
  const argocd = TOOLS.find(t => t.id === 'cd')!;
  const infisical = TOOLS.find(t => t.id === 'secrets')!;
  const valid = repo && [...secrets, ...config].every(r => !r.name || VAR.test(r.name));  // + missing (below)

  const api = useEveresto();
  // Secrets come from the app's .env.example: required ones locked + must be filled, optional ones removable.
  useEffect(() => {
    if (!repo) { setTemplate(undefined); return undefined; }
    let live = true;
    api('GET', `/apps/${encodeURIComponent(repo)}/env-template`).then((tpl: EnvTemplate) => {
      if (!live) return;
      setTemplate(tpl);
      setSecrets(tpl.vars.map(v => ({ name: v.name, value: '', required: v.required, hint: v.hint, example: v.example })));
    }, () => { if (live) { setTemplate(undefined); setSecrets([]); } });
    return () => { live = false; };
  }, [repo]); // eslint-disable-line react-hooks/exhaustive-deps
  const exempt = redis ? REDIS_PROVIDED : [];
  const missing = secrets.filter(s => s.required && !exempt.includes(s.name) && !s.value.trim()).map(s => s.name);

  const create = async () => {
    setBusy(true);
    try {
      setResult(await api('POST', `/apps/${encodeURIComponent(repo)}/deployment`, {
        secrets: secrets.filter(s => s.name && !exempt.includes(s.name)).map(({ name, value }) => ({ name, value })), config: config.filter(c => c.name),
        port: Number(port), memoryMi: Number(memory), replicas: Number(replicas), healthPath: health.trim(), publicUrl, redis, nsKey: key,
      }));
    } catch (e: any) {
      alertApi.post({ message: `Create deployment failed: ${e.message}`, severity: 'error' });
    } finally { setBusy(false); }
  };

  const close = () => { setResult(undefined); setRepo(''); setSecrets([]); setConfig([]); setRedis(false); setTemplate(undefined); onClose(); };

  return (
    <Dialog open={open} onClose={busy ? undefined : close} maxWidth="md" fullWidth>
      <DialogTitle>{result ? `Deployment created · ${repo}` : `Create deployment · ${project}`}</DialogTitle>
      <DialogContent>
        <BusyBar busy={busy} hint={`${SLOW_HINT} (Infisical project, gitops repo, ArgoCD app)`} />
        {result ? (
          <>
            <Box component="ul" pl={3} m={0} style={{ lineHeight: 1.8 }}>
              {result.done.map(d => <li key={d}>{d}</li>)}
            </Box>
            {result.commands.length > 0 && (
              <>
                <Typography variant="subtitle2" style={{ marginTop: 16 }}>One-time platform step (owner, on the control plane)</Typography>
                {result.commands.map(c => <CmdBox key={c.title} {...c} />)}
              </>
            )}
            <Typography variant="subtitle2" style={{ margin: '16px 0 8px' }}>Live status — updates by itself (you can close this; the same view is in the CD tab)</Typography>
            <StatusChainOf repo={repo} project={project} />
            {result.infisicalUrl && (
              <Typography variant="body2" color="textSecondary" style={{ marginTop: 8 }}>
                Secret values: <a href={result.infisicalUrl} target="_blank" rel="noopener">Infisical {repo}-gitops</a> → dev, or the Secrets tab.
              </Typography>
            )}
          </>
        ) : (
          <>
            <Box display="flex" alignItems="center" style={{ gap: 16 }} mb={1}>
              <Box display="flex" alignItems="center" style={{ gap: 6 }}><ToolLogo tool={argocd} size={22} /><b>ArgoCD</b></Box>
              <Box display="flex" alignItems="center" style={{ gap: 6 }}><ToolLogo tool={infisical} size={22} /><b>Infisical</b> secrets</Box>
              <Typography variant="caption" color="textSecondary">ArgoCD app <b>dev-{repo || '<app>'}</b> · namespace <b>dev-{key || '<short>'}</b> · manual sync · prod via Promote</Typography>
            </Box>

            <TextField select fullWidth variant="outlined" margin="dense" label="CI application (its image is deployed)" value={repo}
              onChange={e => setRepo(e.target.value)} helperText={candidates.length ? 'Applications of this space that build an image and have no deployment yet' : 'No CI application with an image in this project yet'}>
              {candidates.map(a => <MenuItem key={a.metadata.name} value={a.metadata.name}>{a.metadata.name} — {a.metadata.annotations?.['everesto.live/image']}</MenuItem>)}
            </TextField>

            <Rows title="Secrets → Infisical" secret rows={secrets} setRows={setSecrets} exempt={exempt}
              hint={<>
                Stored in Infisical project {repo || '<app>'}-gitops → dev, never in git.{' '}
                <TemplateNote repo={repo} template={template} />
              </>} />
            <Rows title="Config (not secret)" rows={config} setRows={setConfig} hint="Plain environment variables, written into the deployment (visible in git), e.g. LOG_LEVEL=info" />

            <Grid container spacing={2} style={{ marginTop: 8 }}>
              <Grid item xs={12}>
                <TextField fullWidth size="small" variant="outlined" label="Namespace (short name)" value={nsKey} placeholder={repo.split('-')[0] || 'python'}
                  onChange={e => setNsKey(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                  error={!!key && !/^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$/.test(key)}
                  helperText={`→ namespaces dev-${key || '<short>'} and prod-${key || '<short>'} (must be unused — checked when you create)`} />
              </Grid>
              <Grid item xs={12}>
                <FormControlLabel control={<Checkbox color="primary" checked={publicUrl} onChange={e => setPublicUrl(e.target.checked)} />}
                  label={<span><b>Public URL (dev)</b> <Typography component="span" variant="caption" color="textSecondary">https://{repo || '<app>'}-dev.everesto.live — ingress in apps/dev (prod URL: later)</Typography></span>} />
              </Grid>
              <Grid item xs={12}>
                <FormControlLabel control={<Checkbox color="primary" checked={redis} onChange={e => setRedis(e.target.checked)} />}
                  label={<span><b>Redis</b> <Typography component="span" variant="caption" color="textSecondary">own user + keys <b>{project}-{repo || '<app>'}:*</b> in the shared platform Redis (prod: <b>…-prod</b>) → secrets REDIS_URL + REDIS_KEY_PREFIX. The app must prefix its keys with REDIS_KEY_PREFIX.</Typography></span>} />
              </Grid>
              <Grid item xs={12}><TextField fullWidth size="small" variant="outlined" label="Health check path" value={health} onChange={e => setHealth(e.target.value)}
                helperText="HTTP GET → readiness + liveness probes (FastAPI skeleton: /health). Empty = only check that the port is open." /></Grid>
              <Grid item xs={4}><TextField fullWidth size="small" variant="outlined" label="Container port" value={port} onChange={e => setPort(e.target.value.replaceAll(/\D/g, ''))} /></Grid>
              <Grid item xs={4}><TextField fullWidth size="small" variant="outlined" label="Memory limit (Mi)" value={memory} onChange={e => setMemory(e.target.value.replaceAll(/\D/g, ''))} helperText="64–1024 · nodes are small" /></Grid>
              <Grid item xs={4}><TextField fullWidth size="small" variant="outlined" label="Replicas" value={replicas} onChange={e => setReplicas(e.target.value.replaceAll(/\D/g, ''))} helperText="1–3" /></Grid>
            </Grid>

            {repo && (
              <Box mt={2}>
                <Typography variant="body2">Creates, in this order (stops before git if Infisical fails):</Typography>
                <Box component="ol" pl={3} m={0} style={{ lineHeight: 1.7, fontSize: 14 }}>
                  {redis && <li>Redis user <b>{project}-{repo}</b> in the shared Redis (keys <b>{project}-{repo}:*</b> only, no FLUSHALL / KEYS / CONFIG)</li>}
                  <li>Infisical project <b>{repo}-gitops</b> → dev with the secrets above{redis ? ' + REDIS_URL / REDIS_KEY_PREFIX' : ''} (+ a read-only login for the cluster)</li>
                  <li>public repo <b>Everesto-Inc/{repo}-gitops</b> — apps/dev with the newest image of {repo} (no secret values)</li>
                  <li>ArgoCD app <b>dev-{repo}</b> + its cluster access to secrets — automatic (~3 min), then you click <b>Sync</b></li>
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
            {missing.length > 0 && <Typography variant="caption" color="error" style={{ marginRight: 8 }}>Required: {missing.join(', ')}</Typography>}
            <BusyButton color="primary" variant="contained" disableElevation busy={busy} busyLabel="Creating…" disabled={!valid || missing.length > 0} onClick={create}>Create deployment</BusyButton>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
};
