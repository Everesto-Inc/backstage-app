import { Fragment, useState } from 'react';
import { alertApiRef, discoveryApiRef, fetchApiRef, useApi } from '@backstage/core-plugin-api';
import { useEntity, EntityRefLink } from '@backstage/plugin-catalog-react';
import { Progress, ResponseErrorPanel } from '@backstage/core-components';
import {
  Avatar,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  TextField,
  Typography,
  makeStyles,
} from '@material-ui/core';
import PersonAddIcon from '@material-ui/icons/PersonAdd';
import { Member, ROLES, ROLE_LABEL, Role, useMembers, useSpaceRole } from './data';
import { AccessSyncCard } from './AccessSyncCard';

const ROLE_RIGHTS: Record<Role, string> = {
  managers: 'promote to prod, prod secrets, delete applications, add/remove developers and viewers',
  maintainers: 'create CI / repositories / deployments, deploy to dev, change tools, delete deployments',
  developers: 'push code via pull request, dev secrets, run builds — creates nothing, deletes nothing',
  viewers: 'read only',
};

const useStyles = makeStyles(theme => ({
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(2),
    padding: theme.spacing(1.5, 2),
    borderBottom: `1px solid ${theme.palette.divider}`,
    '&:last-child': { borderBottom: 'none' },
  },
  list: {
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: 14,
    background: theme.palette.background.paper,
  },
  role: {
    fontSize: 12,
    fontWeight: 600,
    padding: '2px 10px',
    borderRadius: 999,
    border: `1px solid ${theme.palette.divider}`,
    color: theme.palette.text.secondary,
    whiteSpace: 'nowrap',
  },
  legend: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 16px', fontSize: 13, marginTop: theme.spacing(3) },
}));

/** Project (System) → "Members": who is in the project and with which role. Owners manage. */
export const ProjectMembers = () => {
  const classes = useStyles();
  const { entity } = useEntity();
  const project = entity.metadata.name;
  const [reload, setReload] = useState(0);
  const { value, loading, error } = useMembers(project, reload);
  const discovery = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const alertApi = useApi(alertApiRef);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ done: string[]; warn: string[] } | undefined>();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  // Managers add/remove developers and viewers of THEIR space; the Manager / Maintainer ticks are set by the owner
  const myRole = useSpaceRole(project);
  const isOwner = myRole.manager;
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<Member | undefined>();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('developers');

  const call = async (path: string, body: unknown) => {
    setBusy(true);
    try {
      const base = await discovery.getBaseUrl('everesto');
      const res = await fetchApi.fetch(`${base}/spaces/${project}/${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setResult(json);
      // the catalog was refreshed by the backend; give it a few seconds, then reload the list
      setTimeout(() => setReload(r => r + 1), 4000);
    } catch (e: any) {
      alertApi.post({ message: e.message, severity: 'error' });
    } finally { setBusy(false); }
  };
  const closeInvite = () => { setInviting(false); setResult(undefined); setUsername(''); setEmail(''); setDisplayName(''); };
  const closeRemove = () => { setRemoving(undefined); setResult(undefined); };

  if (loading && !value) return <Progress />;
  if (error) return <ResponseErrorPanel error={error} />;

  return (
    <Box maxWidth={900}>
      <Box display="flex" alignItems="center" mb={2}>
        <Typography variant="h6">Members · {value?.length ?? 0}</Typography>
        {isOwner && (
          <Box ml="auto">
            <Button variant="contained" color="primary" disableElevation startIcon={<PersonAddIcon />} onClick={() => setInviting(true)}>
              Invite member
            </Button>
          </Box>
        )}
      </Box>

      <div className={classes.list}>
        {(value ?? []).map(m => (
          <div key={`${m.user.metadata.name}-${m.role}`} className={classes.row}>
            <Avatar src={(m.user.spec as any)?.profile?.picture} style={{ width: 36, height: 36 }}>
              {(((m.user.spec as any)?.profile?.displayName ?? m.user.metadata.name) as string)[0].toUpperCase()}
            </Avatar>
            <Box minWidth={0}>
              <EntityRefLink entityRef={m.user} style={{ fontWeight: 600 }}>
                {(m.user.spec as any)?.profile?.displayName ?? m.user.metadata.name}
              </EntityRefLink>
              <Typography variant="caption" color="textSecondary" component="div">
                @{m.user.metadata.name} · {(m.user.spec as any)?.profile?.email ?? 'no email'}
              </Typography>
            </Box>
            <Box ml="auto" display="flex" alignItems="center" style={{ gap: 12 }}>
              <span className={classes.role}>{ROLE_LABEL[m.role]}</span>
              {isOwner && (myRole.superAdmin || m.role === 'developers' || m.role === 'viewers') && (
                <Button size="small" style={{ color: '#d03b3b' }} onClick={() => setRemoving(m)}>
                  Remove
                </Button>
              )}
            </Box>
          </div>
        ))}
      </div>

      <div className={classes.legend}>
        {ROLES.map(r => (
          <Fragment key={r}>
            <b>{ROLE_LABEL[r]}</b>
            <span style={{ opacity: 0.75 }}>{ROLE_RIGHTS[r]}</span>
          </Fragment>
        ))}
      </div>

      <Dialog open={inviting} onClose={busy ? undefined : closeInvite} maxWidth="sm" fullWidth>
        <DialogTitle>Add a member to {entity.metadata.title ?? project}</DialogTitle>
        <DialogContent>
          {result ? (
            <Box component="ul" pl={3} m={0} style={{ lineHeight: 1.8 }}>
              {result.done.map(d => <li key={d}>{d}</li>)}
              {result.warn.map(w => <li key={w} style={{ color: '#fab219' }}>⚠ {w}</li>)}
            </Box>
          ) : (
            <>
              <Typography variant="body2" color="textSecondary" paragraph>
                Login is with GitHub: enter the person's <b>GitHub username</b> (they need a GitHub account first).
                Backstage adds them to the catalog with this role and invites them to the GitHub organisation with the right team.
              </Typography>
              <Box display="flex" style={{ gap: 12 }}>
                <TextField label="GitHub username" required fullWidth variant="outlined" size="small" value={username}
                  onChange={e => setUsername(e.target.value.trim())} placeholder="e.g. babu-chan" />
                <TextField select label="Role" variant="outlined" size="small" value={role} onChange={e => setRole(e.target.value as Role)} style={{ minWidth: 160 }}>
                  {ROLES.filter(r => myRole.superAdmin || r === 'developers' || r === 'viewers').map(r => <MenuItem key={r} value={r}>{ROLE_LABEL[r]}</MenuItem>)}
                </TextField>
              </Box>
              <Box display="flex" style={{ gap: 12 }} mt={2}>
                <TextField label="Email (optional)" fullWidth variant="outlined" size="small" value={email} onChange={e => setEmail(e.target.value)} />
                <TextField label="Display name (optional)" fullWidth variant="outlined" size="small" value={displayName} onChange={e => setDisplayName(e.target.value)} />
              </Box>
              {!myRole.superAdmin && <Typography variant="caption" color="textSecondary">Managers add developers and viewers; Manager / Maintainer roles are given by the owner.</Typography>}
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeInvite} disabled={busy}>{result ? 'Close' : 'Cancel'}</Button>
          {!result && (
            <Button color="primary" variant="contained" disableElevation disabled={busy || !username}
              onClick={() => call('members', { username, role, email: email || undefined, displayName: displayName || undefined })}>
              {busy ? 'Adding…' : 'Add member'}
            </Button>
          )}
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(removing)} onClose={busy ? undefined : closeRemove} maxWidth="xs" fullWidth>
        <DialogTitle>Remove {removing?.user.metadata.name} ({removing ? ROLE_LABEL[removing.role] : ''})?</DialogTitle>
        <DialogContent>
          {result ? (
            <Box component="ul" pl={3} m={0} style={{ lineHeight: 1.8 }}>
              {result.done.map(d => <li key={d}>{d}</li>)}
              {result.warn.map(w => <li key={w} style={{ color: '#fab219' }}>⚠ {w}</li>)}
            </Box>
          ) : (
            <Typography variant="body2">
              Removes the {removing ? ROLE_LABEL[removing.role] : ''} role in {project} (catalog + GitHub team). Their GitHub account
              and org membership stay — they may belong to other spaces.
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeRemove} disabled={busy}>{result ? 'Close' : 'Cancel'}</Button>
          {!result && removing && (
            <Button variant="contained" disableElevation disabled={busy} style={{ background: '#d03b3b', color: '#fff' }}
              onClick={() => call('members/remove', { username: removing.user.metadata.name, role: removing.role })}>
              {busy ? 'Removing…' : 'Remove'}
            </Button>
          )}
        </DialogActions>
      </Dialog>
      <AccessSyncCard />
    </Box>
  );
};
