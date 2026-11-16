import { useState } from 'react';
import { Entity } from '@backstage/catalog-model';
import { useEntity, EntityRefLink } from '@backstage/plugin-catalog-react';
import { Progress, ResponseErrorPanel } from '@backstage/core-components';
import { Box, Button, Checkbox, FormControlLabel, Grid, Typography, makeStyles } from '@material-ui/core';
import AddIcon from '@material-ui/icons/Add';
import EditIcon from '@material-ui/icons/Edit';
import AccountTreeIcon from '@material-ui/icons/AccountTree';
import CheckCircle from '@material-ui/icons/CheckCircle';
import ErrorIcon from '@material-ui/icons/Error';
import { useIsProjectMaintainer, useIsProjectOwner, useProjectParts } from './data';
import { PipelineFlow } from './PipelineFlow';
import { PreviewDialog } from './PreviewDialog';
import { CreatePipelineDialog } from './CreatePipelineDialog';
import { CreateDeploymentDialog } from './CreateDeploymentDialog';
import { EditPipelineDialog } from './EditPipelineDialog';
import { EditDeploymentDialog } from './CdActions';
import { days, metricsFor } from './metrics';
import { useDemoData } from './demo';
import { RealCdMetrics, RealCiMetrics, RealSummary } from './RealMetrics';
import { CD_TOOLS, CI_TOOLS, Tool, toolState } from '../tools/tools';
import { ToolLogo } from '../tools/ToolLogo';
import { Meter, STATUS, Sparkline, StatTile } from '../tools/charts';

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
  metrics: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    borderTop: `1px solid ${theme.palette.divider}`,
    [theme.breakpoints.down('sm')]: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
  },
  metric: {
    padding: theme.spacing(1.5, 2.5),
    borderRight: `1px solid ${theme.palette.divider}`,
    '&:last-child': { borderRight: 'none' },
    minWidth: 0,
  },
  mLabel: { fontSize: 12, color: theme.palette.text.secondary, fontWeight: 500 },
  mValue: { fontSize: 15, fontWeight: 650, display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 },
  empty: { border: `1px dashed ${theme.palette.divider}`, borderRadius: 16, padding: theme.spacing(6), textAlign: 'center' },
}));

const short = (e: Entity, project: string) => e.metadata.name.replace(new RegExp(`^${project}-`), '');

const Good = ({ children }: { children: string }) => (
  <><CheckCircle style={{ fontSize: 16, color: STATUS.good }} />{children}</>
);
const Bad = ({ children }: { children: string }) => (
  <><ErrorIcon style={{ fontSize: 16, color: STATUS.critical }} />{children}</>
);

const Metric = ({ label, children }: { label: string; children: React.ReactNode }) => {
  const classes = useStyles();
  return (
    <div className={classes.metric}>
      <div className={classes.mLabel}>{label}</div>
      <div className={classes.mValue}>{children}</div>
    </div>
  );
};

const EditTools = ({ entity, tools, onClose, isOwner }: { entity: Entity; tools: Tool[]; onClose: () => void; isOwner: boolean }) => {
  const initial = Object.fromEntries(tools.map(t => [t.id, toolState(entity, t).kind !== 'missing']));
  const [checked, setChecked] = useState<Record<string, boolean>>(initial);
  const added = tools.filter(t => checked[t.id] && !initial[t.id]).map(t => t.name);
  const removed = tools.filter(t => !checked[t.id] && initial[t.id]).map(t => t.name);
  return (
    <PreviewDialog
      open
      onClose={onClose}
      title={`Edit pipeline · ${entity.metadata.name}`}
      steps={[
        added.length ? `add ${added.join(', ')}: provision for this app, per-app token in Infisical, PR with pipeline step + docs` : 'nothing to add',
        removed.length ? `remove ${removed.join(', ')}: PR removing the step, revoke token (owners only)` : 'nothing to remove',
      ]}
    >
      {tools.map(t => {
        const lock = initial[t.id] && !isOwner;
        return (
          <Box key={t.id} display="flex" alignItems="center" style={{ gap: 12 }} py={0.5}>
            <ToolLogo tool={t} size={32} />
            <FormControlLabel
              control={<Checkbox color="primary" checked={checked[t.id]} disabled={lock} onChange={e => setChecked({ ...checked, [t.id]: e.target.checked })} />}
              label={<span><b>{t.name}</b> <Typography component="span" variant="caption" color="textSecondary">{t.description}{lock ? ' · only owners can remove' : ''}</Typography></span>}
            />
          </Box>
        );
      })}
    </PreviewDialog>
  );
};

const PipelineCard = ({ e, project, tools, kind, isOwner }: {
  e: Entity; project: string; tools: Tool[]; kind: 'ci' | 'cd' | 'repo'; isOwner: boolean;
}) => {
  const classes = useStyles();
  const [editing, setEditing] = useState(false);
  const demo = useDemoData();
  const m = metricsFor(e);
  const sonar = tools.find(t => t.id === 'quality');
  const sonarState = sonar ? toolState(e, sonar) : undefined;

  return (
    <div className={classes.card}>
      <div className={classes.head}>
        <Box minWidth={0}>
          <EntityRefLink entityRef={e} className={classes.name}>{short(e, project)}</EntityRefLink>
          <Typography variant="body2" color="textSecondary">{e.metadata.description ?? e.metadata.name}</Typography>
        </Box>
        <PipelineFlow entity={e} tools={tools} size={48} labels />
        <Button variant="outlined" startIcon={<EditIcon />} onClick={() => setEditing(true)}>Edit</Button>
      </div>

      {!demo && kind === 'ci' && <RealCiMetrics entity={e} />}
      {!demo && kind === 'cd' && <RealCdMetrics entity={e} />}
      {demo && kind === 'ci' && (() => {
        const st = (id: string) => toolState(e, tools.find(x => x.id === id)!);
        const scanners = (['semgrep', 'trivy', 'sast', 'deps'] as const)
          .map(id => ({ id, tool: tools.find(x => x.id === id)!, state: st(id) }))
          .filter(x => x.state.kind !== 'missing');
        const counts: Record<string, { critical: number; high: number }> = {
          semgrep: m.semgrep, trivy: m.trivy, sast: m.sast, deps: m.deps,
        };
        const leaks = st('secrets-scan');
        return (
          <div className={classes.metrics} style={{ gridTemplateColumns: undefined }}>
            <Metric label={`Last build · #${m.lastBuild.id} · ${m.lastBuild.ago}`}>
              <Box width="100%">
                {m.lastBuild.ok ? <Good>Success</Good> : <Bad>Failed</Bad>}
                <Sparkline height={24} format={v => `${v} commits`} data={days(m.commits)} />
              </Box>
            </Metric>
            <Metric label="Test coverage · new code">
              {!sonarState || sonarState.kind === 'missing' ? (
                <Typography variant="body2" color="textSecondary">SonarQube not added</Typography>
              ) : sonarState.kind === 'error' ? (
                <Bad>Unavailable</Bad>
              ) : (
                <Box width="100%">
                  <Box display="flex" alignItems="baseline" style={{ gap: 8 }}>
                    <span style={{ fontSize: 22, fontWeight: 700 }}>{m.coverage}%</span>
                    <Typography variant="body2" color="textSecondary">new code {m.newCodeCoverage}%</Typography>
                  </Box>
                  <Meter value={m.coverage} target={70} />
                </Box>
              )}
            </Metric>
            <Metric label="New issues · this branch">
              {!sonarState || sonarState.kind !== 'connected' ? (
                <Typography variant="body2" color="textSecondary">—</Typography>
              ) : m.newIssues === 0 ? (
                <Good>None</Good>
              ) : (
                <Box>
                  <span style={{ fontWeight: 650 }}>{m.newIssues} new</span>
                  <Typography variant="caption" color="textSecondary" component="div">fix first: {m.topIssue}</Typography>
                </Box>
              )}
            </Metric>
            <Metric label="Vulnerabilities">
              {scanners.length === 0 ? (
                <Typography variant="body2" color="textSecondary">No scanner added</Typography>
              ) : (
                <Box display="flex" flexDirection="column" style={{ gap: 2 }}>
                  {scanners.map(({ id, tool, state }) => (
                    <Box key={id} display="flex" alignItems="center" style={{ gap: 6, fontSize: 14 }}>
                      <span style={{ minWidth: 70, fontWeight: 500, opacity: 0.7 }}>{tool.name}</span>
                      {state.kind === 'error' ? <Bad>Unavailable</Bad>
                        : counts[id].critical + counts[id].high === 0 ? <Good>None</Good>
                        : <Bad>{`${counts[id].critical} crit · ${counts[id].high} high`}</Bad>}
                    </Box>
                  ))}
                </Box>
              )}
            </Metric>
            <Metric label="Secrets in code">
              {leaks.kind === 'missing' ? (
                <Typography variant="body2" color="textSecondary">Gitleaks not added</Typography>
              ) : leaks.kind === 'error' ? (
                <Bad>Unavailable</Bad>
              ) : m.secretsFound ? (
                <Bad>{`${m.secretsFound} found — build blocked`}</Bad>
              ) : (
                <Good>None</Good>
              )}
            </Metric>
          </div>
        );
      })()}
      {demo && kind === 'cd' && (
        <div className={classes.metrics}>
          <Metric label="Status">{m.health === 'Healthy' ? <Good>Synced · Healthy</Good> : <Bad>Degraded</Bad>}</Metric>
          <Metric label="Deployments · 14 days">
            <Box width="100%"><Sparkline height={28} format={v => `${v} deploys`} data={days(m.deploys)} /></Box>
          </Metric>
          <Metric label="Last deploy">{m.lastDeploy}</Metric>
          <Metric label="Target">{e.spec?.type === 'gitops' ? `K3s · ns ${project}` : 'VMs via AWX'}</Metric>
        </div>
      )}

      {editing && !demo && kind !== 'cd' && <EditPipelineDialog entity={e} repoOnly={kind === 'repo'} onClose={() => setEditing(false)} />}
      {editing && !demo && kind === 'cd' && (
        <EditDeploymentDialog repo={e.metadata.name.replace(/-gitops$/, '')} project={project} hasProd={false} onClose={() => setEditing(false)} />
      )}
      {editing && demo && <EditTools entity={e} tools={tools} onClose={() => setEditing(false)} isOwner={isOwner} />}
    </div>
  );
};

const Section = ({ title, items, ...rest }: {
  title: string; items: Entity[]; project: string; tools: Tool[]; kind: 'ci' | 'cd' | 'repo'; isOwner: boolean;
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

/** Project (System) → Pipelines: summary, CI pipelines, repo-only apps, CD pipelines. */
export const ProjectPipelines = () => {
  const classes = useStyles();
  const { entity } = useEntity();
  const project = entity.metadata.name;
  const { value, loading, error } = useProjectParts(project);
  const isOwner = useIsProjectOwner(project);
  const demo = useDemoData();
  const [creating, setCreating] = useState<string | undefined>(); // stack preselected: 'python' | 'repo'
  const [deploying, setDeploying] = useState(false);
  const canCreate = useIsProjectMaintainer(project); // maintainers + managers (+ entity managers, owner)

  if (loading) return <Progress />;
  if (error) return <ResponseErrorPanel error={error} />;
  const { ci, repoOnly, cd } = value!;

  // the page header already shows "DevOps Space – Orchid"; this page IS the space's home (all CI / CD / repositories)
  const back = null;
  const createButtons = canCreate && !demo && (
    <Box ml="auto" display="flex" style={{ gap: 8, flexWrap: 'wrap' }}>
      <Button variant="contained" color="primary" disableElevation startIcon={<AddIcon />} onClick={() => setCreating('repo')}>Create repository</Button>
      <Button variant="contained" color="primary" disableElevation startIcon={<AddIcon />} onClick={() => setDeploying(true)}>Create deployment</Button>
      <Button variant="contained" color="primary" disableElevation startIcon={<AddIcon />} onClick={() => setCreating('python')}>Create pipeline</Button>
    </Box>
  );
  const dialog = (
    <>
      <CreatePipelineDialog project={project} open={!!creating} initialStack={creating ?? 'python'} onClose={() => setCreating(undefined)} />
      <CreateDeploymentDialog project={project} open={deploying} onClose={() => setDeploying(false)}
        apps={ci.filter(a => !cd.some(r => r.metadata.name === `${a.metadata.name}-gitops`))} />
    </>
  );


  if (ci.length + repoOnly.length + cd.length === 0)
    return (
      <Box>
        <Box display="flex" alignItems="center" mb={2}>{back}{createButtons}</Box>
        <Box className={classes.empty} mt={1}>
          <AccountTreeIcon color="disabled" style={{ fontSize: 48 }} />
          <Typography variant="h5" gutterBottom>No pipelines yet</Typography>
          <Typography variant="body2" color="textSecondary" paragraph>
            Create a pipeline (CI: build, test, scan, image), a repository (no pipeline), then a deployment (CD).
          </Typography>
          {!canCreate && <Typography variant="body2" color="textSecondary">Only maintainers and managers of this space can create.</Typography>}
        </Box>
        {dialog}
      </Box>
    );

  // project summary (dummy): aggregate the per-app metrics — demo only
  const ms = ci.map(metricsFor);
  const commits = ms.reduce((acc, m) => acc.map((v, i) => v + m.commits[i]), new Array<number>(14).fill(0));
  const deploys = cd.map(metricsFor).reduce((acc, m) => acc.map((v, i) => v + m.deploys[i]), new Array<number>(14).fill(0));
  const failing = ms.filter(m => !m.lastBuild.ok).length;
  const scanned = (e: Entity, id: string) => toolState(e, CI_TOOLS.find(t => t.id === id)!).kind === 'connected';
  const vulns = ci.reduce((n, e, i) =>
    n + (['semgrep', 'trivy', 'sast', 'deps'] as const).reduce((k, id) =>
      k + (scanned(e, id) ? ms[i][id].critical + ms[i][id].high : 0), 0), 0);
  const errors = [...ci, ...cd].flatMap(e => [...CI_TOOLS, ...CD_TOOLS].filter(t => toolState(e, t).kind === 'error'));

  return (
    <Box>
      <Box display="flex" alignItems="center" mb={2}>
        {back}
        {createButtons}
      </Box>

      {!demo && <RealSummary ci={ci} />}
      {demo && <Grid container spacing={2}>
        <Grid item xs={12} sm={6} md={3}>
          <StatTile label="Commits · 14 days" value={commits.reduce((a, b) => a + b, 0)}>
            <Sparkline format={v => `${v} commits`} data={days(commits)} />
          </StatTile>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatTile label="Deployments · 14 days" value={deploys.reduce((a, b) => a + b, 0)}>
            <Sparkline format={v => `${v} deploys`} data={days(deploys)} />
          </StatTile>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatTile
            label="Builds"
            value={failing === 0 ? <Good>All green</Good> : <Bad>{`${failing} failing`}</Bad>}
            delta={`${ci.length} CI pipelines · last run each`}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatTile
            label="Needs attention"
            value={errors.length + vulns === 0 ? <Good>Nothing</Good> : <Bad>{`${errors.length + vulns} items`}</Bad>}
            delta={`${errors.length} tool error${errors.length === 1 ? '' : 's'} · ${vulns} high/critical vulns`}
          />
        </Grid>
      </Grid>}

      <Section title="CI pipelines" items={ci} project={project} tools={CI_TOOLS} kind="ci" isOwner={isOwner} />
      <Section title="CD pipelines" items={cd} project={project} tools={CD_TOOLS} kind="cd" isOwner={isOwner} />
      <Section title="Repositories" items={repoOnly} project={project} tools={CI_TOOLS.filter(t => t.id === 'code')} kind="repo" isOwner={isOwner} />
      {dialog}
    </Box>
  );
};
