import { Fragment, useState } from 'react';
import { useEveresto } from './api';
import { alertApiRef, useApi } from '@backstage/core-plugin-api';
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
  Checkbox,
  Chip,
  FormControlLabel,
  TextField,
  Typography,
  makeStyles,
} from '@material-ui/core';
import PersonAddIcon from '@material-ui/icons/PersonAdd';
import { Member, ROLES, ROLE_LABEL, Role, useMembers, useSpaceRole } from './data';
import { AccessSyncCard } from './AccessSyncCard';

const ROLE_RIGHTS: Record<Role, string> = {
  managers: 'everything a maintainer can + promote to prod, prod secrets, delete applications, add/remove maintainers',
  maintainers: 'create CI / repositories / deployments, deploy to dev, change tools, delete deployments, add/remove developers and viewers',
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

/** Space (System) → "Members": one row per person, all their roles. Owner / managers / maintainers manage (givableRoles). */
export const ProjectMembers = () => {
  const classes = useStyles();
  const { entity } = useEntity();
  const project = entity.metadata.name;
  const [reload, setReload] = useState(0);
  const { value, loading, error } = useMembers(project, reload);
  const alertApi = useApi(alertApiRef);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ done: string[]; warn: string[] } | undefined>();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  // who may give/take which role — same rule as the backend (everestoMembers.givableRoles)
  const myRole = useSpaceRole(project);
  const givable: Role[] = (() => {
    if (myRole.superAdmin) return [...ROLES];
    if (myRole.manager) return ['maintainers', 'developers', 'viewers'];
    if (myRole.maintainer) return ['developers', 'viewers'];
    return [];
  })();
  const isOwner = givable.length > 0;
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<Member | undefined>();
  const [email, setEmail] = useState('');
  const [roles, setRoles] = useState<Role[]>(['developers']);

  const api = useEveresto();
  const call = async (path: string, body: unknown) => {
    setBusy(true);
    try {
      setResult(await api('POST', `/spaces/${project}/${path}`, body));
      // the catalog was refreshed by the backend; give it a few seconds, then reload the list
      setTimeout(() => setReload(r => r + 1), 4000);
    } catch (e: any) {
      alertApi.post({ message: e.message, severity: 'error' });
    } finally { setBusy(false); }
  };
  const closeInvite = () => { setInviting(false); setResult(undefined); setUsername(''); setEmail(''); setDisplayName(''); setRoles(['developers']); };
  const closeRemove = () => { setRemoving(undefined); setResult(undefined); };

  // one row per person, all their roles as chips (× = remove that role, only where you may)
  const people = ROLES.flatMap(r => (value ?? []).filter(m => m.role === r)).reduce<{ user: Member['user']; roles: Role[] }[]>((acc, m) => {
    const p = acc.find(x => x.user.metadata.name === m.user.metadata.name);
    if (p) p.roles.push(m.role); else acc.push({ user: m.user, roles: [m.role] });
    return acc;
  }, []);

  if (loading && !value) return <Progress />;
  if (error) return <ResponseErrorPanel error={error} />;

  return (
    <Box maxWidth={900}>
      <Box display="flex" alignItems="center" mb={2}>
        <Typography variant="h6">Members · {new Set((value ?? []).map(m => m.user.metadata.name)).size}</Typography>
        {isOwner && (
          <Box ml="auto">
            <Button variant="contained" color="primary" disableElevation startIcon={<PersonAddIcon />} onClick={() => setInviting(true)}>
              Invite member
            </Button>
          </Box>
        )}
      </Box>

      <div className={classes.list}>
        {people.map(({ user, roles: theirs }) => (
          <div key={user.metadata.name} className={classes.row}>
            <Avatar src={(user.spec as any)?.profile?.picture} style={{ width: 36, height: 36 }}>
              {(((user.spec as any)?.profile?.displayName ?? user.metadata.name) as string)[0].toUpperCase()}
            </Avatar>
            <Box minWidth={0}>
              <EntityRefLink entityRef={user} style={{ fontWeight: 600 }}>
                {(user.spec as any)?.profile?.displayName ?? user.metadata.name}
              </EntityRefLink>
              <Typography variant="caption" color="textSecondary" component="div">
                @{user.metadata.name} · {(user.spec as any)?.profile?.email ?? 'no email'}
              </Typography>
            </Box>
            <Box ml="auto" display="flex" alignItems="center" flexWrap="wrap" justifyContent="flex-end" style={{ gap: 8 }}>
              {theirs.map(r => (
                <Chip key={r} size="small" label={ROLE_LABEL[r]}
                  onDelete={givable.includes(r) ? () => setRemoving({ user, role: r }) : undefined} />
              ))}
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
                Backstage adds them with the ticked roles and invites them to the GitHub organisation with the right teams (one email).
              </Typography>
              <Box display="flex" style={{ gap: 12 }}>
                <TextField label="GitHub username" required fullWidth variant="outlined" size="small" value={username}
                  onChange={e => setUsername(e.target.value.trim())} placeholder="e.g. babu-chan" />
              </Box>
              <Box mt={2}>
                <Typography variant="subtitle2">Roles</Typography>
                {givable.map(r => (
                  <FormControlLabel key={r} label={<span><b>{ROLE_LABEL[r]}</b> <Typography component="span" variant="caption" color="textSecondary">{ROLE_RIGHTS[r]}</Typography></span>}
                    control={<Checkbox color="primary" checked={roles.includes(r)}
                      onChange={e => setRoles(cur => (e.target.checked ? [...cur, r] : cur.filter(x => x !== r)))} />} />
                ))}
              </Box>
              <Box display="flex" style={{ gap: 12 }} mt={2}>
                <TextField label="Email (optional)" fullWidth variant="outlined" size="small" value={email} onChange={e => setEmail(e.target.value)} />
                <TextField label="Display name (optional)" fullWidth variant="outlined" size="small" value={displayName} onChange={e => setDisplayName(e.target.value)} />
              </Box>
              {!myRole.superAdmin && <Typography variant="caption" color="textSecondary">{myRole.manager ? 'Managers give Maintainer, Developer and Viewer; the Manager role is given by the owner.' : 'Maintainers give Developer and Viewer.'}</Typography>}
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeInvite} disabled={busy}>{result ? 'Close' : 'Cancel'}</Button>
          {!result && (
            <Button color="primary" variant="contained" disableElevation disabled={busy || !username || !roles.some(r => givable.includes(r))}
              onClick={() => call('members', { username, roles: roles.filter(r => givable.includes(r)), email: email || undefined, displayName: displayName || undefined })}>
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
