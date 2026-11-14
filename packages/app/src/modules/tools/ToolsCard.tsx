import { useState } from 'react';
import useAsync from 'react-use/esm/useAsync';
import { useEntity } from '@backstage/plugin-catalog-react';
import { identityApiRef, useApi } from '@backstage/core-plugin-api';
import { InfoCard } from '@backstage/core-components';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
  makeStyles,
} from '@material-ui/core';
import CheckCircle from '@material-ui/icons/CheckCircle';
import ErrorIcon from '@material-ui/icons/Error';
import { CD_TOOLS, CI_TOOLS, Tool, ToolState, canRemoveTools, toolState } from './tools';
import { STATUS } from './charts';
import { ToolLogo } from './ToolLogo';

const useStyles = makeStyles(theme => ({
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(2),
    padding: theme.spacing(1.5, 0),
    borderBottom: `1px solid ${theme.palette.divider}`,
    '&:last-child': { borderBottom: 'none' },
  },
  name: { fontWeight: 600, fontSize: 14 },
  desc: { color: theme.palette.text.secondary, fontSize: 13 },
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 12,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 999,
    whiteSpace: 'nowrap',
  },
  actions: { display: 'flex', gap: theme.spacing(1), marginLeft: 'auto', flexShrink: 0 },
}));

const Badge = ({ state }: { state: ToolState }) => {
  const classes = useStyles();
  if (state.kind === 'connected')
    return (
      <span className={classes.badge} style={{ color: STATUS.good, background: 'rgba(12,163,12,0.12)' }}>
        <CheckCircle style={{ fontSize: 14 }} /> Connected
      </span>
    );
  if (state.kind === 'error')
    return (
      <span className={classes.badge} style={{ color: STATUS.critical, background: 'rgba(208,59,59,0.12)' }} title={state.reason}>
        <ErrorIcon style={{ fontSize: 14 }} /> Error
      </span>
    );
  return null;
};

type Action = { tool: Tool; kind: 'add' | 'remove' | 'reconnect' };

/** "Tools" card on an application's Overview. */
export const ToolsCard = () => {
  const classes = useStyles();
  const { entity } = useEntity();
  const identityApi = useApi(identityApiRef);
  const { value: identity } = useAsync(() => identityApi.getBackstageIdentity(), []);
  const isOwner = canRemoveTools(entity, identity?.ownershipEntityRefs ?? []);
  const [action, setAction] = useState<Action | undefined>();

  const TOOLS = entity.kind === 'Resource' ? CD_TOOLS : CI_TOOLS;
  const states = TOOLS.map(t => ({ tool: t, state: toolState(entity, t) }));
  const ok = states.filter(s => s.state.kind === 'connected').length;
  const err = states.filter(s => s.state.kind === 'error').length;

  return (
    <InfoCard
      title="Tools"
      subheader={`${ok} connected · ${err} error · ${TOOLS.length - ok - err} not added`}
    >
      {states.map(({ tool, state }) => (
        <div key={tool.id} className={classes.row}>
          <ToolLogo tool={tool} />
          <Box minWidth={0}>
            <Box display="flex" alignItems="center" style={{ gap: 8 }}>
              <span className={classes.name}>{tool.name}</span>
              <Badge state={state} />
            </Box>
            <div className={classes.desc}>
              {state.kind === 'error' ? `⚠ ${state.reason}` : tool.description}
            </div>
          </Box>
          <div className={classes.actions}>
            {state.kind === 'missing' && (
              <Button size="small" variant="contained" color="primary" disableElevation onClick={() => setAction({ tool, kind: 'add' })}>
                Add
              </Button>
            )}
            {state.kind === 'error' && (
              <Button size="small" variant="outlined" onClick={() => setAction({ tool, kind: 'reconnect' })}>
                Reconnect
              </Button>
            )}
            {state.kind !== 'missing' && isOwner && (
              <Button size="small" style={{ color: STATUS.critical }} onClick={() => setAction({ tool, kind: 'remove' })}>
                Remove
              </Button>
            )}
          </div>
        </div>
      ))}
      {!isOwner && (
        <Typography variant="caption" color="textSecondary">
          Only owners of this space can remove tools.
        </Typography>
      )}

      <Dialog open={Boolean(action)} onClose={() => setAction(undefined)} maxWidth="sm" fullWidth>
        {action && (
          <>
            <DialogTitle>
              {action.kind === 'add' && `Add ${action.tool.name}`}
              {action.kind === 'reconnect' && `Reconnect ${action.tool.name}`}
              {action.kind === 'remove' && `Remove ${action.tool.name}`} · {entity.metadata.name}
            </DialogTitle>
            <DialogContent>
              <Typography variant="body2" paragraph color="textSecondary">
                Preview — nothing is changed. The real action runs <code>{action.tool.templateRef}</code>:
              </Typography>
              <Box component="ol" pl={3} m={0} style={{ lineHeight: 1.8 }}>
                {action.kind === 'add' && (
                  <>
                    <li>creates the {action.tool.name} project for <b>{entity.metadata.name}</b></li>
                    <li>stores its per-app token in Infisical (never in GitHub or Backstage)</li>
                    <li>opens a PR: CI step + annotation <code>{action.tool.annotation}</code> + docs <code>{action.tool.docsPath}</code></li>
                    <li>after merge the <b>{action.tool.tab}</b> tab shows live data</li>
                  </>
                )}
                {action.kind === 'reconnect' && (
                  <>
                    <li>checks {action.tool.name} is reachable</li>
                    <li>rotates the per-app token in Infisical</li>
                    <li>re-runs the connection check → green when it answers</li>
                  </>
                )}
                {action.kind === 'remove' && (
                  <>
                    <li>opens a PR removing the CI step, the annotation and the docs page</li>
                    <li>after merge: revokes the token in Infisical, archives the {action.tool.name} project</li>
                    <li>owners of the space only</li>
                  </>
                )}
              </Box>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setAction(undefined)}>Close</Button>
            </DialogActions>
          </>
        )}
      </Dialog>
    </InfoCard>
  );
};
