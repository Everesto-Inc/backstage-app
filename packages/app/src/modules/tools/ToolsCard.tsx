import { useState } from 'react';
import { useSpaceRole } from '../space/data';
import { useEntity } from '@backstage/plugin-catalog-react';
import { InfoCard } from '@backstage/core-components';
import {
  Box,
  Button,
  Typography,
  makeStyles,
} from '@material-ui/core';
import CheckCircle from '@material-ui/icons/CheckCircle';
import { CD_TOOLS, CI_TOOLS, Tool, ToolState, toolState } from './tools';
import { STATUS } from './charts';
import { ToolLogo } from './ToolLogo';
import { EditPipelineDialog, SWITCHABLE } from '../space/EditPipelineDialog';
import { CdActions, EditDeploymentDialog } from '../space/CdActions';
import EditIcon from '@material-ui/icons/Edit';
import { insightsTarget, useInsights } from '../space/insights';

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
  return null;
};


type Action = { tool: Tool; kind: 'add' | 'remove' };

/**
 * CD (Resource <app>-gitops) — real mode. Rules: ArgoCD is the deployment tool (Ansible excluded while ArgoCD is
 * active, and vice versa), Infisical is always on, Grafana comes later. No per-tool remove: the deployment as a
 * whole is deleted (owners) via "Delete deployment".
 */
const CdToolsCard = () => {
  const classes = useStyles();
  const { entity } = useEntity();
  const { value: d, retry } = useInsights(entity);
  const project = String(entity.spec?.system ?? '');
  const repo = insightsTarget(entity).repo;
  const tool = (id: string) => CD_TOOLS.find(t => t.id === id)!;
  const [editing, setEditing] = useState(false);
  const rows: { tool: Tool; label: string; note: string; on: boolean }[] = [
    { tool: tool('cd'), label: 'Active', note: `apps dev-${repo}${d?.envs?.prod ? ` / prod-${repo}` : ''} · manual sync`, on: true },
    { tool: tool('config'), label: 'Not used', note: 'excluded while ArgoCD deploys this app (one deployment tool per app)', on: false },
    { tool: tool('secrets'), label: 'Always on', note: `Infisical project ${repo}-gitops → ESO → Secret ${repo}`, on: true },
    { tool: tool('monitoring'), label: 'Coming later', note: 'dashboards and alerts', on: false },
  ];
  return (
    <InfoCard title="Tools" subheader="ArgoCD + Infisical · every deployment"
      action={<Button size="small" variant="outlined" startIcon={<EditIcon />} onClick={() => setEditing(true)} style={{ margin: 8 }}>Edit</Button>}>
      {editing && <EditDeploymentDialog repo={repo} project={project} hasProd={!!d?.envs?.prod} onClose={() => setEditing(false)} />}
      {rows.map(r => (
        <div key={r.tool.id} className={classes.row} style={r.on ? undefined : { opacity: 0.55 }}>
          <ToolLogo tool={r.tool} />
          <Box minWidth={0}>
            <Box display="flex" alignItems="center" style={{ gap: 8 }}>
              <span className={classes.name}>{r.tool.name}</span>
              {r.on
                ? <span className={classes.badge} style={{ color: STATUS.good, background: 'rgba(12,163,12,0.12)' }}><CheckCircle style={{ fontSize: 14 }} /> {r.label}</span>
                : <span className={classes.badge} style={{ background: 'rgba(128,128,128,0.15)' }}>{r.label}</span>}
            </Box>
            <div className={classes.desc}>{r.note}</div>
          </Box>
        </div>
      ))}
      <Box mt={2}>
        <CdActions repo={repo} project={project} devTag={d?.envs?.dev?.tag} prodTag={d?.envs?.prod?.tag} onChange={retry} />
      </Box>
    </InfoCard>
  );
};

const CiToolsCard = () => {
  const classes = useStyles();
  const { entity } = useEntity();
  // same rule as the backend (setTools): maintainers + managers (+ entity managers, owner)
  const isOwner = useSpaceRole(String(entity.spec?.system ?? '')).maintainer;
  const [action, setAction] = useState<Action | undefined>();
  // Add / Remove = the Edit pipeline dialog, for the tools Backstage can switch in a Loop pipeline (SonarQube, Semgrep, Dependabot)
  const switchable = (t: Tool) => entity.kind === 'Component' && t.id in SWITCHABLE;

  const TOOLS = entity.kind === 'Resource' ? CD_TOOLS : CI_TOOLS;
  const states = TOOLS.map(t => ({ tool: t, state: toolState(entity, t) }));
  const ok = states.filter(s => s.state.kind === 'connected').length;

  const [editing, setEditing] = useState(false);
  return (
    <InfoCard
      title="Tools"
      subheader={`${ok} connected · ${TOOLS.length - ok} not added`}
      action={entity.kind === 'Component'
        ? <Button size="small" variant="outlined" startIcon={<EditIcon />} onClick={() => setEditing(true)} style={{ margin: 8 }}>Edit</Button>
        : undefined}
    >
      {editing && <EditPipelineDialog entity={entity} onClose={() => setEditing(false)} />}
      {states.map(({ tool, state }) => (
        <div key={tool.id} className={classes.row}>
          <ToolLogo tool={tool} />
          <Box minWidth={0}>
            <Box display="flex" alignItems="center" style={{ gap: 8 }}>
              <span className={classes.name}>{tool.name}</span>
              <Badge state={state} />
            </Box>
            <div className={classes.desc}>
              {tool.description}
            </div>
          </Box>
          <div className={classes.actions}>
            {state.kind === 'missing' && switchable(tool) && isOwner && (
              <Button size="small" variant="contained" color="primary" disableElevation onClick={() => setAction({ tool, kind: 'add' })}>
                Add
              </Button>
            )}
            {state.kind === 'missing' && !switchable(tool) && (
              <Typography variant="caption" color="textSecondary">not available yet</Typography>
            )}
            {state.kind !== 'missing' && switchable(tool) && isOwner && (
              <Button size="small" style={{ color: STATUS.critical }} onClick={() => setAction({ tool, kind: 'remove' })}>
                Remove
              </Button>
            )}
          </div>
        </div>
      ))}
      {!isOwner && (
        <Typography variant="caption" color="textSecondary">
          Only maintainers and managers of this space can add or remove tools.
        </Typography>
      )}

      {action && (
        <EditPipelineDialog entity={entity} preset={{ id: action.tool.id, on: action.kind === 'add' }} onClose={() => setAction(undefined)} />
      )}
    </InfoCard>
  );
};

/** "Tools" card on an application's Overview. */
export const ToolsCard = () => {
  const { entity } = useEntity();
  if (entity.kind === 'Resource') return <CdToolsCard />;
  return <CiToolsCard />;
};
