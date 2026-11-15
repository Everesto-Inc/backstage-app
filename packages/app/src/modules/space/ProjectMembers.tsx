import { Fragment, useState } from 'react';
import { useEntity, EntityRefLink } from '@backstage/plugin-catalog-react';
import { Progress, ResponseErrorPanel } from '@backstage/core-components';
import {
  Avatar,
  Box,
  Button,
  MenuItem,
  TextField,
  Typography,
  makeStyles,
} from '@material-ui/core';
import PersonAddIcon from '@material-ui/icons/PersonAdd';
import { Member, ROLES, ROLE_LABEL, Role, useIsProjectOwner, useMembers } from './data';
import { PreviewDialog } from './PreviewDialog';
import { AccessSyncCard } from './AccessSyncCard';

const ROLE_RIGHTS: Record<Role, string> = {
  owners: 'everything + invite/remove members, assign roles',
  maintainers: 'developer + delete applications, change tool settings',
  developers: 'push code, run pipelines, create applications — no delete',
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
  const { value, loading, error } = useMembers(project);
  const isOwner = useIsProjectOwner(project);
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<Member | undefined>();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('developers');

  if (loading) return <Progress />;
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
              {isOwner && (
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

      <PreviewDialog
        open={inviting}
        onClose={() => setInviting(false)}
        title={`Invite to ${project}`}
        steps={[
          `creates a pending user with ${email || '<email>'} and role ${ROLE_LABEL[role]}`,
          'sends the invitation email + GitHub org invite (Everesto-Inc)',
          'on first GitHub login the verified email is matched → user bound to the role',
          `access sync: GitHub team ${project}-${role}, SonarQube, ArgoCD, Infisical`,
        ]}
      >
        <Box display="flex" style={{ gap: 12 }}>
          <TextField label="Email" fullWidth variant="outlined" size="small" value={email} onChange={e => setEmail(e.target.value)} />
          <TextField select label="Role" variant="outlined" size="small" value={role} onChange={e => setRole(e.target.value as Role)} style={{ minWidth: 160 }}>
            {ROLES.map(r => <MenuItem key={r} value={r}>{ROLE_LABEL[r]}</MenuItem>)}
          </TextField>
        </Box>
      </PreviewDialog>

      <PreviewDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(undefined)}
        title={`Remove ${removing?.user.metadata.name ?? ''} from ${project}`}
        steps={[
          `removes the ${removing ? ROLE_LABEL[removing.role] : ''} role in ${project}`,
          `access sync revokes GitHub team ${project}-${removing?.role ?? ''}, SonarQube, ArgoCD, Infisical rights`,
          'if this was their last project anywhere: they can no longer log in to Backstage',
        ]}
      />
      <AccessSyncCard />
    </Box>
  );
};
