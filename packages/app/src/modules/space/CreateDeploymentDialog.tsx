import { useState } from 'react';
import { Entity } from '@backstage/catalog-model';
import { alertApiRef, discoveryApiRef, fetchApiRef, useApi } from '@backstage/core-plugin-api';
import {
  Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel,
  IconButton, MenuItem, TextField, Tooltip, Typography,
} from '@material-ui/core';
import FileCopy from '@material-ui/icons/FileCopy';
import { ToolLogo } from '../tools/ToolLogo';
import { TOOLS } from '../tools/tools';
import { STATUS } from '../tools/charts';

/**
 * Create deployment (CD) for an existing CI application — maintainers / owners.
 * Backend: POST /api/everesto/apps/:repo/deployment (packages/backend/src/modules/everestoDeploy.ts).
 */
type Result = {
  done: string[];
  tag: string;
  commands: { title: string; cmd: string; secret?: boolean }[];
  infisical: { connected: boolean; note?: string; projectUrl?: string };
};

const CmdBox = ({ title, cmd, secret }: { title: string; cmd: string; secret?: boolean }) => (
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

export const CreateDeploymentDialog = ({ project, apps, open, onClose }: {
  project: string; apps: Entity[]; open: boolean; onClose: () => void;
}) => {
  const discovery = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const alertApi = useApi(alertApiRef);
  // CI apps that build an image and have no deployment yet
  const candidates = apps.filter(a => a.metadata.annotations?.['everesto.live/image']);
  const [repo, setRepo] = useState('');
  const [tool, setTool] = useState<'argocd' | 'ansible'>('argocd');
  const [infisical, setInfisical] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | undefined>();
  const cdTool = (id: string) => TOOLS.find(t => t.id === id)!;

  const create = async () => {
    setBusy(true);
    try {
      const base = await discovery.getBaseUrl('everesto');
      const res = await fetchApi.fetch(`${base}/apps/${encodeURIComponent(repo)}/deployment`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ infisical }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setResult(json);
    } catch (e: any) {
      alertApi.post({ message: `Create deployment failed: ${e.message}`, severity: 'error' });
    } finally { setBusy(false); }
  };

  const close = () => { setResult(undefined); setRepo(''); onClose(); };

  return (
    <Dialog open={open} onClose={busy ? undefined : close} maxWidth="md" fullWidth>
      <DialogTitle>{result ? `Deployment created · ${repo}` : `Create deployment · ${project}`}</DialogTitle>
      <DialogContent>
        {result ? (
          <>
            <Box component="ul" pl={3} m={0} style={{ lineHeight: 1.8 }}>
              {result.done.map(d => <li key={d}>{d}</li>)}
            </Box>
            {result.infisical.note && <Typography variant="body2" style={{ color: STATUS.warning, marginTop: 8 }}>⚠ {result.infisical.note}</Typography>}
            <Typography variant="subtitle2" style={{ marginTop: 16 }}>Run once on the control plane (<code>ssho control-plane</code>) — Backstage has no cluster access:</Typography>
            {result.commands.map(c => <CmdBox key={c.title} {...c} />)}
            {result.commands.some(c => c.secret) && (
              <Typography variant="body2" style={{ color: STATUS.critical, marginTop: 12 }}>
                The client secret is shown only now and is stored nowhere — copy it before closing.
              </Typography>
            )}
            <Typography variant="body2" color="textSecondary" style={{ marginTop: 16 }}>
              Then: <b>dev</b> deploys by itself after every build on main · <b>prod</b> via “Promote to prod” (PR) + Sync in ArgoCD.
              {result.infisical.projectUrl && <> Add the app's secrets in <a href={result.infisical.projectUrl} target="_blank" rel="noopener">Infisical</a> → folder <code>/{repo}</code>.</>}
            </Typography>
          </>
        ) : (
          <>
            <TextField select fullWidth variant="outlined" margin="dense" label="CI application (its image is deployed)" value={repo}
              onChange={e => setRepo(e.target.value)} helperText={candidates.length ? 'Only applications of this project that build an image' : 'No CI application with an image in this project yet'}>
              {candidates.map(a => <MenuItem key={a.metadata.name} value={a.metadata.name}>{a.metadata.name} — {a.metadata.annotations?.['everesto.live/image']}</MenuItem>)}
            </TextField>

            <Typography variant="subtitle2" style={{ marginTop: 16 }}>Deployment tool</Typography>
            <Box display="flex" style={{ gap: 12 }} mt={1}>
              {(['argocd', 'ansible'] as const).map(id => {
                const t = cdTool(id === 'argocd' ? 'cd' : 'config');
                const soon = id === 'ansible';
                return (
                  <Button key={id} variant={tool === id ? 'contained' : 'outlined'} color={tool === id ? 'primary' : 'default'} disableElevation disabled={soon}
                    onClick={() => setTool(id)} startIcon={<ToolLogo tool={t} size={20} />}>
                    {t.name}{soon ? ' · coming soon' : ''}
                  </Button>
                );
              })}
            </Box>

            <Typography variant="subtitle2" style={{ marginTop: 16 }}>Environments</Typography>
            <Typography variant="body2" color="textSecondary">
              <b>dev</b> (namespace {project}-dev): auto-sync, CI deploys every build on main · <b>prod</b> (namespace {project}-prod): manual — Promote PR + Sync in ArgoCD
            </Typography>

            <FormControlLabel style={{ marginTop: 12 }}
              control={<Checkbox color="primary" checked={infisical} onChange={e => setInfisical(e.target.checked)} />}
              label={<span><b>Infisical secrets</b> <Typography component="span" variant="caption" color="textSecondary">project {project}, folder /{repo || '<app>'} in dev + prod → Kubernetes Secret via ESO</Typography></span>} />

            {repo && (
              <Box mt={2}>
                <Typography variant="body2">Creates:</Typography>
                <Box component="ul" pl={3} m={0} style={{ lineHeight: 1.7, fontSize: 14 }}>
                  <li>public repo <b>Everesto-Inc/{repo}-gitops</b> — apps/dev, apps/prod, argocd/ (no secrets inside)</li>
                  <li>Deploy stage in <b>{repo}</b>'s CI + deploy key (writes only to {repo}-gitops)</li>
                  <li>ArgoCD project <b>{project}</b> + apps {repo}-dev / {repo}-prod — as a kubectl command for you</li>
                  {infisical && <li>Infisical project <b>{project}</b> + identity eso-{project} — its login as a kubectl command (shown once)</li>}
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
            <Button color="primary" variant="contained" disableElevation disabled={busy || !repo} onClick={create}>{busy ? 'Creating…' : 'Create deployment'}</Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
};
