import { useState } from 'react';
import { useEveresto } from './api';
import { BusyBar, BusyButton, SLOW_HINT } from './Busy';
import { Entity, stringifyEntityRef } from '@backstage/catalog-model';
import { alertApiRef, useApi } from '@backstage/core-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import {
  Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, Divider,
  FormControlLabel, Radio, RadioGroup, TextField, Typography,
} from '@material-ui/core';
import DeleteForever from '@material-ui/icons/DeleteForever';
import { useNavigate } from 'react-router-dom';
import { TOOLS, toolState } from '../tools/tools';
import { useSpaceRole } from './data';
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

export const EditPipelineDialog = ({ entity, onClose, preset, repoOnly }: { entity: Entity; onClose: () => void; preset?: { id: string; on: boolean }; repoOnly?: boolean }) => {
  const catalogApi = useApi(catalogApiRef);
  const alertApi = useApi(alertApiRef);
  const navigate = useNavigate();

  const repo = entity.metadata.name;
  const project = String(entity.spec?.system ?? '');
  const sonarKey = entity.metadata.annotations?.['sonarqube.org/project-key'];
  const role = useSpaceRole(project); // includes entity admins
  const canEdit = role.maintainer;
  // platform systems (Backstage itself, Loop) are never deletable from Backstage
  const isProtected = ['backstage', 'loop'].includes(project) || entity.metadata.annotations?.['everesto.live/protected'] === 'true';
  const canDelete = !isProtected && role.manager; // delete application: managers (incl. entity managers) + owner

  // repository only (no CI): nothing to switch, just Delete
  const tools = repoOnly ? [] : TOOLS.filter(t => t.stage === 'ci' && (t.id in SWITCHABLE || ALWAYS_ON.includes(t.id)));
  const initial = Object.fromEntries(tools.map(t => [t.id, toolState(entity, t).kind !== 'missing']));
  const [checked, setChecked] = useState<Record<string, boolean>>(preset ? { ...initial, [preset.id]: preset.on } : initial);
  const [busyAction, setBusyAction] = useState<'save' | 'delete' | undefined>();
  const busy = !!busyAction;
  const [confirmDelete, setConfirmDelete] = useState('');
  const [result, setResult] = useState<{ done: string[]; warn?: string[] } | undefined>();

  // Loop v1.1+: the pipeline is one call with switches — tests and Trivy mode exist only there
  const annotations = entity.metadata.annotations ?? {};
  const loopVersion = annotations['everesto.live/loop'] ?? '';
  const v11 = /^v(1\.([1-9]|\d{2,})|[2-9])/.test(loopVersion);
  const initialTests = annotations['everesto.live/tests'] !== 'off';
  const initialTrivy: 'enforce' | 'report' = annotations['everesto.live/trivy'] === 'report' ? 'report' : 'enforce';
  const [tests, setTests] = useState(initialTests);
  const [trivy, setTrivy] = useState<'enforce' | 'report'>(initialTrivy);

  const changes = Object.entries(SWITCHABLE)
    .filter(([id]) => checked[id] !== initial[id])
    .map(([id, key]) => ({ id, key, on: checked[id] }));
  const extra: { key: 'tests' | 'trivy'; text: string }[] = [
    ...(v11 && tests !== initialTests ? [{ key: 'tests' as const, text: `${tests ? 'turn on' : 'turn off'} tests + coverage` }] : []),
    ...(v11 && trivy !== initialTrivy ? [{ key: 'trivy' as const, text: `Trivy: ${trivy === 'report' ? 'report only (findings no longer fail the build)' : 'enforce (vulnerabilities fail the build again)'}` }] : []),
  ];
  const hasChanges = changes.length + extra.length > 0;
  const removingSonar = changes.some(c => c.key === 'sonarqube' && !c.on);

  const api = useEveresto();
  const call = (path: string, body: unknown) => api('POST', `/apps/${encodeURIComponent(repo)}/${path}`, body);

  const save = async () => {
    setBusyAction('save');
    try {
      const out = await call('tools', {
        ...Object.fromEntries(changes.map(c => [c.key, c.on])),
        ...(extra.some(x => x.key === 'tests') ? { tests } : {}),
        ...(extra.some(x => x.key === 'trivy') ? { trivy } : {}),
      });
      await catalogApi.refreshEntity(stringifyEntityRef(entity)).catch(() => {});
      setResult(out);
      alertApi.post({ message: `Pipeline of ${repo} saved — CI runs with the new settings`, severity: 'success', display: 'transient' });
    } catch (e: any) {
      alertApi.post({ message: `Save failed: ${e.message}`, severity: 'error' });
    } finally { setBusyAction(undefined); }
  };

  const del = async () => {
    setBusyAction('delete');
    try {
      const out = await call('delete', { confirm: repo });
      setResult(out);
      alertApi.post({ message: `Application ${repo} deleted`, severity: 'success', display: 'transient' });
    } catch (e: any) {
      alertApi.post({ message: `Delete failed: ${e.message}`, severity: 'error' });
    } finally { setBusyAction(undefined); }
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
      <DialogTitle>{repoOnly ? 'Edit repository' : 'Edit pipeline'} · {repo}</DialogTitle>
      <Box px={3}><BusyBar busy={busy} hint={busyAction === 'delete' ? `${SLOW_HINT} (repo, SonarQube, deployment, catalog)` : 'Saving the pipeline settings…'} /></Box>
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
        {!repoOnly && v11 && (
          <Box mt={1}>
            <FormControlLabel
              control={<Checkbox color="primary" checked={tests} disabled={!canEdit || busy} onChange={e => setTests(e.target.checked)} />}
              label={<span><b>Tests + coverage</b>{' '}<Typography component="span" variant="caption" color="textSecondary">install, run the tests, coverage for SonarQube</Typography></span>} />
            <Typography variant="subtitle2" style={{ marginTop: 8 }}>Trivy — always scans dependencies and the image</Typography>
            <RadioGroup row value={trivy} onChange={e => setTrivy(e.target.value as 'enforce' | 'report')}>
              <FormControlLabel value="enforce" disabled={!canEdit || busy} control={<Radio color="primary" />} label="Enforce — vulnerabilities fail the build" />
              <FormControlLabel value="report" disabled={!canEdit || busy} control={<Radio color="primary" />} label="Report only" />
            </RadioGroup>
            {trivy === 'report' && <Typography variant="caption" style={{ color: STATUS.warning }}>Report only: findings are shown but never block — the scorecard flags this pipeline.</Typography>}
          </Box>
        )}
        {!repoOnly && !v11 && (
          <Typography variant="caption" color="textSecondary" component="div" style={{ marginTop: 8 }}>
            Loop {loopVersion || 'v1.0'}: the Tests and Trivy (enforce / report) switches need Loop v1.1.
          </Typography>
        )}
        {repoOnly && <Typography variant="body2" color="textSecondary">Repository only — no CI pipeline, no tools.</Typography>}
        {!canEdit && !repoOnly && <Typography variant="body2" color="textSecondary">Only maintainers and managers of {project} can change tools.</Typography>}
        {hasChanges && (
          <Box mt={2}>
            <Typography variant="body2" paragraph style={{ marginBottom: 4 }}>Saving will:</Typography>
            <Box component="ul" pl={3} m={0} style={{ lineHeight: 1.7, fontSize: 14 }}>
              {changes.map(c => <li key={c.id}>{v11 && c.key !== 'dependabot' ? `switch ${c.key} ${c.on ? 'on' : 'off'}` : `${c.on ? 'add' : 'remove'} the ${c.key} stage`} — one commit to <code>ci.yml</code> + <code>catalog-info.yaml</code>{c.key === 'dependabot' ? ' + .github/dependabot.yml' : ''}</li>)}
              {extra.map(x => <li key={x.key}>{x.text} — one commit to <code>ci.yml</code> + <code>catalog-info.yaml</code></li>)}
              {changes.some(c => c.key === 'sonarqube' && c.on) && <li>create the SonarQube project + token (secret SONAR_TOKEN)</li>}
              {removingSonar && <li style={{ color: STATUS.critical }}><b>DELETE SonarQube project {sonarKey ?? repo}</b> with all its history + secret SONAR_TOKEN</li>}
              <li>CI runs once with the new settings and deploys the result</li>
            </Box>
          </Box>
        )}

        {isProtected && (
          <Typography variant="body2" color="textSecondary" style={{ marginTop: 16 }}>
            Platform · protected — this cannot be deleted from Backstage (by anyone).
          </Typography>
        )}
        {canDelete && (
          <Box mt={3}>
            <Divider />
            <Typography variant="subtitle2" style={{ color: STATUS.critical, marginTop: 16 }}>Delete application</Typography>
            <Typography variant="body2" color="textSecondary" paragraph>
              Permanently deletes: GitHub repo <b>Everesto-Inc/{repo}</b> (code, Actions, secrets), SonarQube project
              {sonarKey ? <> <b>{sonarKey}</b></> : ''}, its deployment (<b>{repo}-gitops</b> repo + Infisical project + identity),
              and the catalog entry. Kept: images in ghcr.io. Cannot be undone. Type <b>{repo}</b> to confirm.
            </Typography>
            <Box display="flex" style={{ gap: 12 }} alignItems="center">
              <TextField size="small" variant="outlined" placeholder={repo} value={confirmDelete} disabled={busy}
                onChange={e => setConfirmDelete(e.target.value)} style={{ flex: 1 }} />
              <BusyButton variant="contained" busy={busyAction === 'delete'} busyLabel="Deleting…" disabled={busy || confirmDelete !== repo} startIcon={<DeleteForever />}
                style={confirmDelete === repo ? { background: STATUS.critical, color: '#fff' } : undefined} onClick={del}>
                Delete
              </BusyButton>
            </Box>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <BusyButton color="primary" variant="contained" busy={busyAction === 'save'} busyLabel="Saving…" disabled={busy || !canEdit || !hasChanges} onClick={save}>
          Save
        </BusyButton>
      </DialogActions>
    </Dialog>
  );
};
