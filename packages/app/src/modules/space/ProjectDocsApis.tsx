import { ReactNode } from 'react';
import { useEntity, EntityRefLink } from '@backstage/plugin-catalog-react';
import { Progress } from '@backstage/core-components';
import { Box, Button, Grid, Typography, makeStyles } from '@material-ui/core';
import CodeIcon from '@material-ui/icons/Code';
import OpenInNew from '@material-ui/icons/OpenInNew';
import { useProjectParts } from './data';

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

const DocCard = ({ icon, title, text, action }: { icon: ReactNode; title: ReactNode; text: string; action?: { label: string; href: string } }) => {
  const classes = useStyles();
  return (
    <div className={classes.card}>
      {icon}
      <Box flex={1} minWidth={0}>
        <b>{title}</b>
        <Typography variant="body2" color="textSecondary">{text}</Typography>
      </Box>
      {action && <Button size="small" color="primary" href={action.href} endIcon={<OpenInNew fontSize="small" />}>{action.label}</Button>}
    </div>
  );
};

/** Space → Startup Guide: a new member's first day, step by step — every link goes somewhere real. */
export const ProjectStartupGuide = () => {
  const classes = useStyles();
  const { entity } = useEntity();
  const p = entity.metadata.name;
  const steps: { t: string; d: string; a?: { label: string; href: string } }[] = [
    { t: 'Accept your GitHub invitation', d: `Organisation Everesto-Inc with your ${p} team — sent by email when you were added in Members`, a: { label: 'Open invitation', href: 'https://github.com/orgs/Everesto-Inc/invitation' } },
    { t: 'Sign in to Backstage with GitHub', d: 'Your role in this space applies automatically (GitHub, ArgoCD and SonarQube follow within 30 minutes)' },
    { t: 'Pick or create an application', d: 'Pipelines tab: open an existing app, or Create pipeline (developers and up) — it creates the repo, CI, Dockerfile and docs', a: { label: 'Pipelines', href: `/catalog/default/system/${p}` } },
    { t: 'Clone it and run it locally', d: 'git clone git@github.com:Everesto-Inc/<app>.git — the README of the app explains how to run it' },
    { t: 'Open a pull request', d: 'CI runs tests, secret scan (Gitleaks), image scan (Trivy) and, if switched on, Semgrep and SonarQube. main needs 1 approval from someone else; CI changes need a maintainer' },
    { t: 'Merge → new image', d: 'Each merge builds ghcr.io/everesto-inc/<app>:sha-… — CI never deploys' },
    { t: 'Deploy to dev', d: 'Maintainers: CD card → Deploy → pick the build → Sync in ArgoCD. The CD tab → Status shows each step and what to do', a: { label: 'ArgoCD', href: 'https://argocd.everesto.live' } },
    { t: 'Promote to prod', d: 'Managers: Promote to prod opens a pull request in <app>-gitops; a manager approves, then Sync in ArgoCD' },
  ];
  return (
    <Box maxWidth={900}>
      <Typography variant="h6">Startup guide · {entity.metadata.title ?? p}</Typography>
      <Typography variant="body2" color="textSecondary" paragraph>From invitation to your first deployment.</Typography>
      {steps.map((s, i) => (
        <div key={s.t} className={classes.step}>
          <div className={classes.num}>{i + 1}</div>
          <Box minWidth={0}>
            <b>{s.t}</b>
            <Typography variant="body2" color="textSecondary" style={{ wordBreak: 'break-word' }}>{s.d}</Typography>
          </Box>
          {s.a ? <Button size="small" variant="outlined" color="primary" href={s.a.href} {...(s.a.href.startsWith('http') ? { target: '_blank', rel: 'noopener' } : {})}>{s.a.label}</Button> : <span />}
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
            action={{ label: 'Open spec', href: `/catalog/${a.metadata.namespace ?? 'default'}/api/${a.metadata.name}/definition` }}
          />
        </Grid>
      ))}
    </Grid>
  );
};
