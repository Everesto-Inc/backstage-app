import { ReactNode } from 'react';
import { useEntity, EntityRefLink } from '@backstage/plugin-catalog-react';
import { Progress } from '@backstage/core-components';
import { Box, Button, Grid, Typography, makeStyles } from '@material-ui/core';
import MenuBookIcon from '@material-ui/icons/MenuBook';
import CodeIcon from '@material-ui/icons/Code';
import OpenInNew from '@material-ui/icons/OpenInNew';
import { useProjectParts } from './data';
import { TOOLS } from '../tools/tools';
import { ToolLogo } from '../tools/ToolLogo';

const useStyles = makeStyles(theme => ({
  card: {
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: 14,
    padding: theme.spacing(2),
    background: theme.palette.background.paper,
    display: 'flex',
    gap: theme.spacing(1.5),
    alignItems: 'flex-start',
    height: '100%',
  },
  step: {
    display: 'grid',
    gridTemplateColumns: '40px 1fr auto',
    gap: theme.spacing(2),
    alignItems: 'center',
    padding: theme.spacing(2),
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: 14,
    background: theme.palette.background.paper,
    marginBottom: theme.spacing(1.5),
    [theme.breakpoints.down('xs')]: { gridTemplateColumns: '40px 1fr' },
  },
  num: {
    width: 36, height: 36, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontWeight: 700, background: theme.palette.primary.main, color: theme.palette.primary.contrastText,
  },
}));

const DocCard = ({ icon, title, text, action }: { icon: ReactNode; title: ReactNode; text: string; action?: string }) => {
  const classes = useStyles();
  return (
    <div className={classes.card}>
      {icon}
      <Box flex={1} minWidth={0}>
        <b>{title}</b>
        <Typography variant="body2" color="textSecondary">{text}</Typography>
      </Box>
      {action && <Button size="small" color="primary" endIcon={<OpenInNew fontSize="small" />}>{action}</Button>}
    </div>
  );
};

/** Project → Tech Docs: each application's TechDocs + how-to per tool. */
export const ProjectTechDocs = () => {
  const { entity } = useEntity();
  const { value, loading } = useProjectParts(entity.metadata.name);
  if (loading) return <Progress />;
  const apps = [...(value?.ci ?? []), ...(value?.repoOnly ?? [])];
  return (
    <Box>
      <Typography variant="h6" gutterBottom>Applications</Typography>
      <Grid container spacing={2}>
        {apps.map(e => (
          <Grid item xs={12} sm={6} md={4} key={e.metadata.name}>
            <DocCard
              icon={<MenuBookIcon color="primary" />}
              title={<EntityRefLink entityRef={e}>{e.metadata.name}</EntityRefLink>}
              text="Architecture, runbook and ADRs — from the repo's docs/ folder (TechDocs)"
              action="Read"
            />
          </Grid>
        ))}
      </Grid>
      <Box mt={4}><Typography variant="h6" gutterBottom>Tools — how to use them in your pipelines</Typography></Box>
      <Grid container spacing={2}>
        {TOOLS.map(t => (
          <Grid item xs={12} sm={6} md={4} key={t.id}>
            <DocCard icon={<ToolLogo tool={t} size={32} />} title={t.name} text={`${t.docsPath} — setup, pipeline step, troubleshooting`} action="Read" />
          </Grid>
        ))}
      </Grid>
    </Box>
  );
};

/** Project → Startup Guide: first day for a new member, step by step. */
export const ProjectStartupGuide = () => {
  const classes = useStyles();
  const { entity } = useEntity();
  const p = entity.metadata.name;
  const steps = [
    { t: 'Accept your invitations', d: `GitHub org Everesto-Inc + team ${p}-developers (email invite)`, a: 'Open GitHub' },
    { t: 'Sign in to Backstage with GitHub', d: 'Your role in this space is applied automatically', a: undefined },
    { t: 'Clone an application', d: `git clone git@github.com:Everesto-Inc/${p}-java-backend.git`, a: 'Copy' },
    { t: 'Run it locally', d: 'See the app’s README — secrets come from Infisical (infisical run -- ./gradlew bootRun)', a: 'Open README' },
    { t: 'Open your first pull request', d: 'CI runs build, tests, SonarQube, Fortify, Nexus IQ — all must pass', a: 'Pipelines' },
    { t: 'Merge → deployed', d: `CI bumps the image tag in ${p}-gitops-cd → ArgoCD deploys to namespace ${p}`, a: 'CD status' },
  ];
  return (
    <Box maxWidth={900}>
      <Typography variant="h6">Startup guide · {entity.metadata.title ?? p}</Typography>
      <Typography variant="body2" color="textSecondary" paragraph>From zero to your first deployment.</Typography>
      {steps.map((s, i) => (
        <div key={s.t} className={classes.step}>
          <div className={classes.num}>{i + 1}</div>
          <Box minWidth={0}>
            <b>{s.t}</b>
            <Typography variant="body2" color="textSecondary" style={{ wordBreak: 'break-word' }}>{s.d}</Typography>
          </Box>
          {s.a ? <Button size="small" variant="outlined" color="primary">{s.a}</Button> : <span />}
        </div>
      ))}
    </Box>
  );
};

/** Project → API Docs: APIs provided by the project's applications. */
export const ProjectApiDocs = () => {
  const { entity } = useEntity();
  const { value, loading } = useProjectParts(entity.metadata.name);
  if (loading) return <Progress />;
  const apis = value?.apis ?? [];
  if (apis.length === 0)
    return <Typography color="textSecondary">No APIs yet — an application declares them in its catalog-info.yaml (OpenAPI, gRPC, AsyncAPI).</Typography>;
  return (
    <Grid container spacing={2}>
      {apis.map(a => (
        <Grid item xs={12} md={6} key={a.metadata.name}>
          <DocCard
            icon={<CodeIcon color="primary" />}
            title={<EntityRefLink entityRef={a}>{a.metadata.name}</EntityRefLink>}
            text={`${String(a.spec?.type ?? '')} · ${a.metadata.description ?? ''}`}
            action="Open spec"
          />
        </Grid>
      ))}
    </Grid>
  );
};
