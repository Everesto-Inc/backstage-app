import { useState } from 'react';
import { alertApiRef, useApi } from '@backstage/core-plugin-api';
import {
  Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, TextField, Typography,
} from '@material-ui/core';
import useAsync from 'react-use/esm/useAsync';
import { STATUS } from '../tools/charts';
import { CmdBox } from './CreateDeploymentDialog';
import { ago } from './insights';
import { useSpaceRole } from './data';
import { useEveresto } from './api';

export type SetupStep = { n: number; env: 'once' | 'dev' | 'prod'; title: string; cmd: string; creates: string[]; explain: string };

/** Ordered control-plane commands with what each one creates — same content as the Tech Docs runbook. */
export const SetupSteps = ({ steps }: { steps: SetupStep[] }) => (
  <>
    {steps.map(x => (
      <Box key={x.n} mt={2}>
        <CmdBox title={`${x.n}. ${x.title}`} cmd={x.cmd} />
        <Typography variant="body2" color="textSecondary" style={{ marginTop: 4 }}>{x.explain}</Typography>
        {x.creates.length > 0 && (
          <Typography variant="caption" color="textSecondary" component="div">Creates: {x.creates.join(' · ')}</Typography>
        )}
      </Box>
    ))}
  </>
);

/** Real CD actions on a deployment card: Deploy (dev), Promote to prod. Delete is in EditDeploymentDialog. */
type Build = { tag: string; at: string; title: string; url: string };

const useRoles = (project: string) => {
  const r = useSpaceRole(project); // includes entity managers
  return { owner: r.superAdmin, manager: r.manager, maintainer: r.maintainer, member: r.developer };
};

export const CdActions = ({ repo, project, devTag, prodTag, onChange }: {
  repo: string; project: string; devTag?: string; prodTag?: string; onChange: () => void;
}) => {
  const call = useEveresto();
  const alertApi = useApi(alertApiRef);
  const roles = useRoles(project);
  const [dialog, setDialog] = useState<'deploy' | 'promote' | 'delete' | undefined>();
  const [busy, setBusy] = useState(false);
  const [tag, setTag] = useState('');
  const [confirm, setConfirm] = useState('');
  const [out, setOut] = useState<{ title: string; lines: string[]; commands?: { title: string; cmd: string }[]; link?: string } | undefined>();
  const { value: builds = [] } = useAsync(async (): Promise<Build[]> =>
    (dialog === 'deploy' ? (await call('GET', `/apps/${repo}/builds`)).builds : []), [dialog]);

  if (!roles.maintainer) return null;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); onChange(); } catch (e: any) { alertApi.post({ message: e.message, severity: 'error' }); } finally { setBusy(false); }
  };
  const close = () => { setDialog(undefined); setOut(undefined); setConfirm(''); setTag(''); };

  return (
    <Box display="flex" flexWrap="wrap" style={{ gap: 8 }}>
      <Button size="small" variant="outlined" color="primary" onClick={() => setDialog('deploy')}>Deploy to dev</Button>
      {roles.manager && (
        <Button size="small" variant="outlined" color="primary" disabled={!devTag || devTag === prodTag} onClick={() => setDialog('promote')}>
          Promote {devTag ?? ''} to prod
        </Button>
      )}

      <Dialog open={!!dialog} onClose={busy ? undefined : close} maxWidth="sm" fullWidth>
        <DialogTitle>
          {dialog === 'deploy' && `Deploy ${repo} to dev`}
          {dialog === 'promote' && `Promote ${repo} to prod`}
          {dialog === 'delete' && `Delete deployment of ${repo}`}
        </DialogTitle>
        <DialogContent>
          {out ? (
            <>
              <Typography variant="subtitle2">{out.title}</Typography>
              <Box component="ul" pl={3} m={0} style={{ lineHeight: 1.8 }}>{out.lines.map(l => <li key={l}>{l}</li>)}</Box>
              {out.link && <Box mt={1}><a href={out.link} target="_blank" rel="noopener">{out.link}</a></Box>}
              {out.commands?.map(c => <CmdBox key={c.title} {...c} />)}
            </>
          ) : (
            <>
              {dialog === 'deploy' && (
                <>
                  <Typography variant="body2" paragraph>
                    Writes the chosen image into <code>{repo}-gitops/apps/dev</code>. Nothing runs until you click <b>Sync</b> on <b>dev-{repo}</b> in ArgoCD.
                    Now on dev: <code>{devTag ?? '—'}</code>
                  </Typography>
                  <TextField select fullWidth variant="outlined" size="small" label="Image (last successful builds on main)" value={tag} onChange={e => setTag(e.target.value)}>
                    {builds.map(b => (
                      <MenuItem key={b.tag} value={b.tag} disabled={b.tag === devTag}>
                        {b.tag} · {ago(b.at)} · {b.title.slice(0, 50)}{b.tag === devTag ? ' (on dev)' : ''}
                      </MenuItem>
                    ))}
                  </TextField>
                </>
              )}
              {dialog === 'promote' && (
                <Typography variant="body2">
                  Opens a pull request in <code>{repo}-gitops</code>: prod <code>{prodTag ?? '(not created yet)'}</code> → <code>{devTag}</code>.
                  {!prodTag && <> First promote: also creates <b>apps/prod</b> (the app's prod namespace) and the prod secrets in Infisical <code>{repo}-gitops</code> with the same names (values CHANGE_ME).</>}
                  {' '}After merge: <b>Sync</b> on <b>prod-{repo}</b> in ArgoCD.
                </Typography>
              )}
              {dialog === 'delete' && (
                <>
                  <Typography variant="body2" paragraph>
                    Deletes the GitHub repo <b>{repo}-gitops</b> and its catalog entry. The CI application <b>{repo}</b> and its images stay.
                    Infisical secrets are kept. You get the kubectl command that removes the running app. Type <b>{repo}-gitops</b> to confirm.
                  </Typography>
                  <TextField fullWidth size="small" variant="outlined" placeholder={`${repo}-gitops`} value={confirm} onChange={e => setConfirm(e.target.value)} />
                </>
              )}
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={close} disabled={busy}>{out ? 'Close' : 'Cancel'}</Button>
          {!out && dialog === 'deploy' && (
            <Button color="primary" variant="contained" disableElevation disabled={busy || !tag}
              onClick={() => run(async () => {
                const r = await call('POST', `/apps/${repo}/deploy`, { tag });
                setOut({ title: 'Image written to apps/dev', lines: [`${r.from} → ${r.to}`], commands: r.commands });
              })}>Deploy</Button>
          )}
          {!out && dialog === 'promote' && (
            <Button color="primary" variant="contained" disableElevation disabled={busy}
              onClick={() => run(async () => {
                const r = await call('POST', `/apps/${repo}/promote`);
                setOut({ title: 'Promote PR opened', lines: [`${r.from ?? '(new prod)'} → ${r.to}`, 'merge it, then Sync the prod app in ArgoCD'], link: r.url, commands: r.commands });
              })}>Open PR</Button>
          )}
          {!out && dialog === 'delete' && (
            <Button variant="contained" disableElevation disabled={busy || confirm !== `${repo}-gitops`}
              style={confirm === `${repo}-gitops` ? { background: STATUS.critical, color: '#fff' } : undefined}
              onClick={() => run(async () => {
                const r = await call('POST', `/apps/${repo}/deployment/delete`, { confirm: `${repo}-gitops` });
                setOut({ title: 'Deleted', lines: [...r.done, ...r.warn.map((w: string) => `⚠ ${w}`)] });
              })}>Delete</Button>
          )}
        </DialogActions>
      </Dialog>
    </Box>
  );
};

/** "Run build" on a CI card: starts ci.yml on main (members of the project). */
export const RunBuild = ({ repo, project }: { repo: string; project: string }) => {
  const call = useEveresto();
  const alertApi = useApi(alertApiRef);
  const roles = useRoles(project);
  const [busy, setBusy] = useState(false);
  if (!roles.member) return null;
  return (
    <Button size="small" variant="outlined" disabled={busy} onClick={async () => {
      setBusy(true);
      try {
        await call('POST', `/apps/${repo}/build`);
        alertApi.post({ message: `Build of ${repo} started on main — image appears in ~3 min`, severity: 'success', display: 'transient' });
      } catch (e: any) { alertApi.post({ message: `Run build failed: ${e.message}`, severity: 'error' }); } finally { setBusy(false); }
    }}>Run build</Button>
  );
};

/**
 * Edit deployment — same pattern as Edit pipeline: the tools (fixed rules) + Delete (owners, typed confirmation).
 * ArgoCD deploys (Ansible excluded while ArgoCD is active), Infisical always on, Grafana later.
 */
export const EditDeploymentDialog = ({ repo, project, hasProd, onClose, onDeleted }: {
  repo: string; project: string; hasProd: boolean; onClose: () => void; onDeleted?: () => void;
}) => {
  const call = useEveresto();
  const alertApi = useApi(alertApiRef);
  const roles = useRoles(project);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<string[] | undefined>();
  const [esoCmd, setEsoCmd] = useState<string | undefined>();
  const gitops = `${repo}-gitops`;
  const { value: setup } = useAsync(async (): Promise<SetupStep[]> =>
    (await call('GET', `/apps/${repo}/deployment/setup`)).commands, [repo]);
  const newLogin = async () => {
    setBusy(true);
    try { setEsoCmd((await call('POST', `/apps/${repo}/deployment/eso-login`)).cmd); } catch (e: any) {
      alertApi.post({ message: `Renew cluster access failed: ${e.message}`, severity: 'error' });
    } finally { setBusy(false); }
  };
  const rows: [string, string, boolean][] = [
    ['ArgoCD', `active — dev-${repo}${hasProd ? ` / prod-${repo}` : ''}, manual sync`, true],
    ['Ansible', 'not used — excluded while ArgoCD deploys this app', false],
    ['Infisical', `always on — Infisical project ${gitops} → Secret ${repo} in the cluster`, true],
    ['Grafana', 'coming later', false],
  ];
  const del = async () => {
    setBusy(true);
    try {
      const r = await call('POST', `/apps/${repo}/deployment/delete`, { confirm: gitops });
      setOut([...r.done, ...r.warn.map((w: string) => `⚠ ${w}`)]);
      onDeleted?.();
    } catch (e: any) { alertApi.post({ message: `Delete failed: ${e.message}`, severity: 'error' }); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={busy ? undefined : onClose} maxWidth="md" fullWidth>
      <DialogTitle>{out ? `Deleted · ${gitops}` : `Edit deployment · ${repo}`}</DialogTitle>
      <DialogContent>
        {out ? (
          <Box component="ul" pl={3} m={0} style={{ lineHeight: 1.8 }}>{out.map(l => <li key={l}>{l}</li>)}</Box>
        ) : (
          <>
            {rows.map(([name, note, on]) => (
              <Box key={name} display="flex" alignItems="baseline" style={{ gap: 12, padding: '6px 0', opacity: on ? 1 : 0.55 }}>
                <b style={{ width: 80 }}>{name}</b>
                <Typography variant="body2" color="textSecondary">{note}</Typography>
              </Box>
            ))}
            <Box mt={3} pt={2} style={{ borderTop: '1px solid rgba(128,128,128,0.25)' }}>
              <Typography variant="subtitle2">Setup commands (control plane) — also in the Tech Docs tab of {gitops}</Typography>
              <Typography variant="caption" color="textSecondary">Re-running them is safe. Secret values are never shown. Cluster access to secrets is managed automatically (“Renew cluster access” replaces it).</Typography>
              <SetupSteps steps={setup ?? []} />
              <Box mt={2} display="flex" alignItems="center" style={{ gap: 12 }}>
                <Button size="small" variant="outlined" disabled={busy || !roles.maintainer} onClick={newLogin}>Renew cluster access</Button>
                <Typography variant="caption" color="textSecondary">replaces the cluster's login for this app's secrets — applied automatically within 5 min</Typography>
              </Box>
              {esoCmd && (
                <>
                  <CmdBox title={`✓ Renewed — the cluster picks it up within 5 minutes (nothing to run). Follow it in the CD tab → Status.`} cmd={esoCmd} />
                </>
              )}
            </Box>
            {roles.maintainer ? (
              <Box mt={3} pt={2} style={{ borderTop: '1px solid rgba(128,128,128,0.25)' }}>
                <Typography variant="subtitle2" style={{ color: STATUS.critical }}>Delete deployment (dev + prod)</Typography>
                <Typography variant="body2" color="textSecondary" paragraph>
                  Deletes the GitHub repo <b>{gitops}</b>, its catalog entry, the Infisical project <b>{gitops}</b> (all its secrets)
                  and the identity eso-{repo}. Kept: the CI application <b>{repo}</b> and its images. You get the kubectl command that
                  removes dev + prod from the cluster (the apps and their access to secrets).
                  Type <b>{gitops}</b> to confirm.
                </Typography>
                <Box display="flex" style={{ gap: 12 }}>
                  <TextField size="small" variant="outlined" placeholder={gitops} value={confirm} disabled={busy} onChange={e => setConfirm(e.target.value)} style={{ flex: 1 }} />
                  <Button variant="contained" disableElevation disabled={busy || confirm !== gitops}
                    style={confirm === gitops ? { background: STATUS.critical, color: '#fff' } : undefined} onClick={del}>Delete</Button>
                </Box>
              </Box>
            ) : (
              <Typography variant="body2" color="textSecondary" style={{ marginTop: 16 }}>Only maintainers and managers of {project} can delete deployments.</Typography>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions><Button onClick={onClose} disabled={busy}>Close</Button></DialogActions>
    </Dialog>
  );
};
