import { useState } from 'react';
import { Entity } from '@backstage/catalog-model';
import { useEntity, EntityRefLink } from '@backstage/plugin-catalog-react';
import { Progress, ResponseErrorPanel } from '@backstage/core-components';
import { Box, Button, Typography, makeStyles } from '@material-ui/core';
import AddIcon from '@material-ui/icons/Add';
import EditIcon from '@material-ui/icons/Edit';
import AccountTreeIcon from '@material-ui/icons/AccountTree';
import { deployedApp, useSpaceRole, useProjectParts } from './data';
import { PipelineFlow } from './PipelineFlow';
import { CreatePipelineDialog } from './CreatePipelineDialog';
import { CreateDeploymentDialog } from './CreateDeploymentDialog';
import { ImportRepoDialog } from './ImportRepoDialog';
import CallReceivedIcon from '@material-ui/icons/CallReceived';
import { EditPipelineDialog } from './EditPipelineDialog';
import { EditDeploymentDialog } from './CdActions';
import { RealCdMetrics, RealCiMetrics, RealSummary } from './RealMetrics';
import { CD_TOOLS, CI_TOOLS, Tool } from '../tools/tools';

const useStyles = makeStyles(theme => ({
  section: { marginTop: theme.spacing(4) },
  sectionHead: { display: 'flex', alignItems: 'baseline', gap: theme.spacing(1.5), marginBottom: theme.spacing(1.5) },
  count: {
    fontSize: 12, fontWeight: 700, padding: '1px 8px', borderRadius: 999,
    background: theme.palette.type === 'dark' ? '#2c2c2a' : '#ecebe6', color: theme.palette.text.secondary,
  },
  card: {
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: 16,
    background: theme.palette.background.paper,
    marginBottom: theme.spacing(1.5),
    overflow: 'hidden',
  },
  head: {
    display: 'grid',
    gridTemplateColumns: 'minmax(200px, 260px) 1fr auto',
    alignItems: 'center',
    gap: theme.spacing(3),
    padding: theme.spacing(2.5, 3),
    [theme.breakpoints.down('sm')]: { gridTemplateColumns: '1fr', gap: theme.spacing(2) },
  },
  name: { fontWeight: 700, fontSize: 22, lineHeight: 1.2 },
  empty: { border: `1px dashed ${theme.palette.divider}`, borderRadius: 16, padding: theme.spacing(6), textAlign: 'center' },
}));

const isProtected = (e: Entity) => e.metadata.annotations?.['everesto.live/protected'] === 'true';

const PipelineCard = ({ e, project, tools, kind }: { e: Entity; project: string; tools: Tool[]; kind: 'ci' | 'cd' | 'repo' }) => {
  const classes = useStyles();
  const [editing, setEditing] = useState(false);
  return (
    <div className={classes.card}>
      <div className={classes.head}>
        <Box minWidth={0}>
          <EntityRefLink entityRef={e} className={classes.name}>{e.metadata.name}</EntityRefLink>
          <Typography variant="body2" color="textSecondary">{e.metadata.description ?? e.metadata.name}</Typography>
        </Box>
        <PipelineFlow entity={e} tools={tools} size={48} labels />
        {!(kind === 'cd' && isProtected(e)) && (
          <Button variant="outlined" startIcon={<EditIcon />} onClick={() => setEditing(true)}>Edit</Button>
        )}
      </div>

      {kind === 'ci' && <RealCiMetrics entity={e} />}
      {kind === 'cd' && !isProtected(e) && <RealCdMetrics entity={e} />}
      {kind === 'cd' && isProtected(e) && (
        <Box px={3} pb={2}>
          <Typography variant="body2" color="textSecondary">
            Platform deployment — deploys <b>{deployedApp(e)}</b>, managed by Argo CD (auto-sync on every image bump).
          </Typography>
        </Box>
      )}

      {editing && kind !== 'cd' && <EditPipelineDialog entity={e} repoOnly={kind === 'repo'} onClose={() => setEditing(false)} />}
      {editing && kind === 'cd' && (
        <EditDeploymentDialog repo={deployedApp(e)} project={project} hasProd={false} onClose={() => setEditing(false)} />
      )}
    </div>
  );
};

const Section = ({ title, items, ...rest }: {
  title: string; items: Entity[]; project: string; tools: Tool[]; kind: 'ci' | 'cd' | 'repo';
}) => {
  const classes = useStyles();
  if (items.length === 0) return null;
  return (
    <div className={classes.section}>
      <div className={classes.sectionHead}>
        <Typography variant="h6">{title}</Typography>
        <span className={classes.count}>{items.length}</span>
      </div>
      {items.map(e => <PipelineCard key={e.metadata.name} e={e} {...rest} />)}
    </div>
  );
};

/** Space (System) → Pipelines: summary, CI pipelines, CD pipelines, repositories — and the create buttons. */
export const ProjectPipelines = () => {
  const classes = useStyles();
  const { entity } = useEntity();
  const project = entity.metadata.name;
  const { value, loading, error } = useProjectParts(project);
  const [creating, setCreating] = useState<string | undefined>(); // stack preselected: 'python' | 'repo'
  const [deploying, setDeploying] = useState(false);
  const [importing, setImporting] = useState(false);
  const role = useSpaceRole(project);
  const canCreateCi = role.developer;   // Create pipeline / repository: developers and up
  const canCreate = role.maintainer;    // Create deployment (CD): maintainers, managers (+ entity managers, owner)

  if (loading) return <Progress />;
  if (error) return <ResponseErrorPanel error={error} />;
  const { ci, repoOnly, cd } = value!;

  const createButtons = canCreateCi && (
    <Box ml="auto" display="flex" style={{ gap: 8, flexWrap: 'wrap' }}>
      {canCreate && <Button variant="contained" color="primary" disableElevation startIcon={<CallReceivedIcon />} onClick={() => setImporting(true)}>Import repository</Button>}
      <Button variant="contained" color="primary" disableElevation startIcon={<AddIcon />} onClick={() => setCreating('repo')}>Create repository</Button>
      {canCreate && <Button variant="contained" color="primary" disableElevation startIcon={<AddIcon />} onClick={() => setDeploying(true)}>Create deployment</Button>}
      <Button variant="contained" color="primary" disableElevation startIcon={<AddIcon />} onClick={() => setCreating('python')}>Create pipeline</Button>
    </Box>
  );
  const dialog = (
    <>
      <CreatePipelineDialog project={project} open={!!creating} initialStack={creating ?? 'python'} onClose={() => setCreating(undefined)} />
      <ImportRepoDialog project={project} open={importing} onClose={() => setImporting(false)} />
      <CreateDeploymentDialog project={project} open={deploying} onClose={() => setDeploying(false)}
        apps={ci.filter(a => !cd.some(r => deployedApp(r) === a.metadata.name))} />
    </>
  );


  if (ci.length + repoOnly.length + cd.length === 0)
    return (
      <Box>
        <Box display="flex" alignItems="center" mb={2}>{createButtons}</Box>
        <Box className={classes.empty} mt={1}>
          <AccountTreeIcon color="disabled" style={{ fontSize: 48 }} />
          <Typography variant="h5" gutterBottom>No pipelines yet</Typography>
          <Typography variant="body2" color="textSecondary" paragraph>
            Create a pipeline (CI: build, test, scan, image), a repository (no pipeline), or import an existing repository — then a deployment (CD).
          </Typography>
          {!canCreateCi && <Typography variant="body2" color="textSecondary">Viewers can't create — developers create pipelines and repositories, maintainers and managers also deployments.</Typography>}
        </Box>
        {dialog}
      </Box>
    );

  return (
    <Box>
      <Box display="flex" alignItems="center" mb={2}>{createButtons}</Box>

      <RealSummary ci={ci} />

      <Section title="CI pipelines" items={ci} project={project} tools={CI_TOOLS} kind="ci" />
      <Section title="CD pipelines" items={cd} project={project} tools={CD_TOOLS} kind="cd" />
      <Section title="Repositories" items={repoOnly} project={project} tools={CI_TOOLS.filter(t => t.id === 'code')} kind="repo" />
      {dialog}
    </Box>
  );
};
