import { useState } from 'react';
import { Entity, stringifyEntityRef } from '@backstage/catalog-model';
import { alertApiRef, discoveryApiRef, fetchApiRef, identityApiRef, useApi } from '@backstage/core-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import {
  Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, Divider,
  FormControlLabel, TextField, Typography,
} from '@material-ui/core';
import DeleteForever from '@material-ui/icons/DeleteForever';
import useAsync from 'react-use/esm/useAsync';
import { useNavigate } from 'react-router-dom';
import { TOOLS, toolState } from '../tools/tools';
import { ToolLogo } from '../tools/ToolLogo';
import { STATUS } from '../tools/charts';

/**
 * Edit pipeline — REAL: saves tool switches (backend POST /api/everesto/apps/:repo/tools) and
 * deletes the whole application (POST /api/everesto/apps/:repo/delete, owners only).
 */
export const SWITCHABLE: Record<string, 'sonarqube' | 'semgrep' | 'dependabot'> = {
  quality: 'sonarqube',
  semgrep: 'semgrep',
  dependabot: 'dependabot',
};
const ALWAYS_ON = ['secrets-scan', 'trivy', 'registry'];

export const EditPipelineDialog = ({ entity, onClose, preset }: { entity: Entity; onClose: () => void; preset?: { id: string; on: boolean } }) => {
  const discovery = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const catalogApi = useApi(catalogApiRef);
  const alertApi = useApi(alertApiRef);
  const identityApi = useApi(identityApiRef);
  const navigate = useNavigate();

  const repo = entity.metadata.name;
  const project = String(entity.spec?.system ?? '');
  const sonarKey = entity.metadata.annotations?.['sonarqube.org/project-key'];
  const { value: refs = [] } = useAsync(async () => (await identityApi.getBackstageIdentity()).ownershipEntityRefs, []);
  const isPlatform = refs.includes('group:default/platform-team');
  const canEdit = isPlatform || refs.includes(`group:default/${project}-owners`) || refs.includes(`group:default/${project}-maintainers`);
  const canDelete = isPlatform || refs.includes(`group:default/${project}-owners`);

  const tools = TOOLS.filter(t => t.stage === 'ci' && (t.id in SWITCHABLE || ALWAYS_ON.includes(t.id)));
  const initial = Object.fromEntries(tools.map(t => [t.id, toolState(entity, t).kind !== 'missing']));
  const [checked, setChecked] = useState<Record<string, boolean>>(preset ? { ...initial, [preset.id]: preset.on } : initial);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState('');
  const [result, setResult] = useState<{ done: string[]; warn?: string[] } | undefined>();

  const changes = Object.entries(SWITCHABLE)
    .filter(([id]) => checked[id] !== initial[id])
    .map(([id, key]) => ({ id, key, on: checked[id] }));
  const removingSonar = changes.some(c => c.key === 'sonarqube' && !c.on);

  const call = async (path: string, body: unknown) => {
    const base = await discovery.getBaseUrl('everesto');
    const res = await fetchApi.fetch(`${base}/apps/${encodeURIComponent(repo)}/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json;
  };

  const save = async () => {
    setBusy(true);
    try {
      const out = await call('tools', Object.fromEntries(changes.map(c => [c.key, c.on])));
      await catalogApi.refreshEntity(stringifyEntityRef(entity)).catch(() => {});
      setResult(out);
      alertApi.post({ message: `Pipeline of ${repo} saved — CI runs with the new settings`, severity: 'success', display: 'transient' });
    } catch (e: any) {
      alertApi.post({ message: `Save failed: ${e.message}`, severity: 'error' });
    } finally { setBusy(false); }
  };

  const del = async () => {
    setBusy(true);
    try {
      const out = await call('delete', { confirm: repo });
      setResult(out);
      alertApi.post({ message: `Application ${repo} deleted`, severity: 'success', display: 'transient' });
    } catch (e: any) {
      alertApi.post({ message: `Delete failed: ${e.message}`, severity: 'error' });
    } finally { setBusy(false); }
  };

  if (result) {
    return (
      <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
        <DialogTitle>Done · {repo}</DialogTitle>
        <DialogContent>
          <Box component="ul" pl={3} m={0} style={{ lineHeight: 1.8 }}>
            {result.done.map(d => <li key={d}>{d}</li>)}
          </Box>
          {result.warn?.map(w => <Typography key={w} variant="body2" style={{ color: STATUS.warning, marginTop: 8 }}>⚠ {w}</Typography>)}
        </DialogContent>
        <DialogActions>
          <Button color="primary" onClick={() => { onClose(); if (confirmDelete === repo) navigate(`/catalog/default/system/${project}`); }}>Close</Button>
        </DialogActions>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Edit pipeline · {repo}</DialogTitle>
      <DialogContent>
        {tools.map(t => {
          const locked = ALWAYS_ON.includes(t.id) || !canEdit;
          return (
            <Box key={t.id} display="flex" alignItems="center" style={{ gap: 12 }} py={0.5}>
              <ToolLogo tool={t} size={32} />
              <FormControlLabel
                control={<Checkbox color="primary" checked={ALWAYS_ON.includes(t.id) || !!checked[t.id]} disabled={locked || busy}
                  onChange={e => setChecked({ ...checked, [t.id]: e.target.checked })} />}
                label={<span><b>{t.name}</b>{' '}
                  <Typography component="span" variant="caption" color="textSecondary">
                    {ALWAYS_ON.includes(t.id) ? 'always on (Loop guard)' : t.description}
                  </Typography></span>}
              />
            </Box>
          );
        })}
        {!canEdit && <Typography variant="body2" color="textSecondary">Only owners and maintainers of {project} can change tools.</Typography>}
        {changes.length > 0 && (
          <Box mt={2}>
            <Typography variant="body2" paragraph style={{ marginBottom: 4 }}>Saving will:</Typography>
            <Box component="ul" pl={3} m={0} style={{ lineHeight: 1.7, fontSize: 14 }}>
              {changes.map(c => <li key={c.id}>{c.on ? 'add' : 'remove'} the {c.key} stage — one commit to <code>ci.yml</code> + <code>catalog-info.yaml</code>{c.key === 'dependabot' ? ' + .github/dependabot.yml' : ''}</li>)}
              {changes.some(c => c.key === 'sonarqube' && c.on) && <li>create the SonarQube project + token (secret SONAR_TOKEN)</li>}
              {removingSonar && <li style={{ color: STATUS.critical }}><b>DELETE SonarQube project {sonarKey ?? repo}</b> with all its history + secret SONAR_TOKEN</li>}
              <li>CI runs once with the new settings and deploys the result</li>
            </Box>
          </Box>
        )}

        {canDelete && (
          <Box mt={3}>
            <Divider />
            <Typography variant="subtitle2" style={{ color: STATUS.critical, marginTop: 16 }}>Delete application</Typography>
            <Typography variant="body2" color="textSecondary" paragraph>
              Permanently deletes: GitHub repo <b>Everesto-Inc/{repo}</b> (code, Actions, secrets), SonarQube project
              {sonarKey ? <> <b>{sonarKey}</b></> : ''}, its folder in <b>{project}-gitops-cd</b> (ArgoCD removes the running app),
              deploy key and the catalog entry. Cannot be undone. Type <b>{repo}</b> to confirm.
            </Typography>
            <Box display="flex" style={{ gap: 12 }} alignItems="center">
              <TextField size="small" variant="outlined" placeholder={repo} value={confirmDelete} disabled={busy}
                onChange={e => setConfirmDelete(e.target.value)} style={{ flex: 1 }} />
              <Button variant="contained" disabled={busy || confirmDelete !== repo} startIcon={<DeleteForever />}
                style={confirmDelete === repo ? { background: STATUS.critical, color: '#fff' } : undefined} onClick={del}>
                Delete
              </Button>
            </Box>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button color="primary" variant="contained" disabled={busy || !canEdit || changes.length === 0} onClick={save}>
          {busy ? 'Working…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
