import { useState } from 'react';
import { alertApiRef, discoveryApiRef, fetchApiRef, identityApiRef, useApi } from '@backstage/core-plugin-api';
import {
  Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, TextField, Typography,
} from '@material-ui/core';
import useAsync from 'react-use/esm/useAsync';
import { STATUS } from '../tools/charts';
import { CmdBox } from './CreateDeploymentDialog';
import { ago } from './insights';

/** Real CD actions on a deployment card: Deploy (dev), Promote to prod, Delete deployment. */
type Build = { tag: string; at: string; title: string; url: string };

const useEveresto = () => {
  const discovery = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  return async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const base = await discovery.getBaseUrl('everesto');
    const res = await fetchApi.fetch(`${base}${path}`, {
      method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json;
  };
};

const useRoles = (project: string) => {
  const identityApi = useApi(identityApiRef);
  const { value: refs = [] } = useAsync(async () => (await identityApi.getBackstageIdentity()).ownershipEntityRefs, []);
  const has = (g: string) => refs.includes(`group:default/${g}`);
  const owner = has('platform-team') || has(`${project}-owners`);
  return { owner, maintainer: owner || has(`${project}-maintainers`), member: owner || has(`${project}-maintainers`) || has(`${project}-developers`) };
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
      <Button size="small" variant="outlined" color="primary" disabled={!devTag || devTag === prodTag} onClick={() => setDialog('promote')}>
        Promote {devTag ?? ''} to prod
      </Button>
      {roles.owner && <Button size="small" style={{ color: STATUS.critical }} onClick={() => setDialog('delete')}>Delete deployment</Button>}

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
                    Writes the chosen image into <code>{repo}-gitops/apps/dev</code>. Nothing runs until you click <b>Sync</b> on <b>{repo}-dev</b> in ArgoCD.
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
                  {!prodTag && <> First promote: also creates <b>apps/prod</b> (namespace {project}-prod) and the Infisical prod folder <code>/{repo}</code> with the same secret names (values CHANGE_ME).</>}
                  {' '}After merge: <b>Sync</b> on <b>{repo}-prod</b> in ArgoCD.
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
                setOut({ title: 'Image written to apps/dev', lines: [`${r.from} → ${r.to}`, `ArgoCD → ${r.argocdApp} → Sync`] });
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
