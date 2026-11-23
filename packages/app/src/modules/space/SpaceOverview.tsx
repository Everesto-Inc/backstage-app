import { useState } from 'react';
import { Entity } from '@backstage/catalog-model';
import { useEntity, EntityRefLink } from '@backstage/plugin-catalog-react';
import { Progress, ResponseErrorPanel } from '@backstage/core-components';
import { Box, Button, Typography, makeStyles } from '@material-ui/core';
import AddIcon from '@material-ui/icons/Add';
import BusinessIcon from '@material-ui/icons/Business';
import FolderIcon from '@material-ui/icons/FolderOpen';
import ArrowForward from '@material-ui/icons/ArrowForward';
import { classifyParts, useProjects } from './data';
import { CreateSpaceDialog } from './CreateSpaceDialog';
import { identityApiRef, useApi } from '@backstage/core-plugin-api';
import useAsync from 'react-use/esm/useAsync';
import { CD_TOOLS, CI_TOOLS, toolState } from '../tools/tools';
import { ToolLogo } from '../tools/ToolLogo';

const LINE = 2;

const useStyles = makeStyles(theme => {
  const line = theme.palette.type === 'dark' ? '#383835' : '#c3c2b7';
  return {
    tree: { display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: theme.spacing(1) },
    root: {
      display: 'flex',
      alignItems: 'center',
      gap: theme.spacing(1.5),
      padding: theme.spacing(1.5, 3),
      borderRadius: 14,
      background: theme.palette.primary.main,
      color: theme.palette.primary.contrastText,
    },
    rootTitle: { fontSize: 20, fontWeight: 700, lineHeight: 1.1 },
    stem: { width: LINE, height: 28, background: line },
    children: { display: 'flex', justifyContent: 'center', flexWrap: 'wrap', width: '100%' },
    child: {
      position: 'relative',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      padding: theme.spacing(0, 1.5),
      flex: '0 1 340px',
      // horizontal bar segments joining siblings
      '&::before, &::after': {
        content: '""',
        position: 'absolute',
        top: 0,
        width: '50%',
        height: LINE,
        background: line,
      },
      '&::before': { left: 0 },
      '&::after': { right: 0 },
      '&:first-child::before, &:last-child::after': { display: 'none' },
      '&:only-child::before, &:only-child::after': { display: 'none' },
    },
    childStem: { width: LINE, height: 24, background: line },
    card: {
      width: '100%',
      border: `1px solid ${theme.palette.divider}`,
      borderRadius: 16,
      padding: theme.spacing(2.5),
      background: theme.palette.background.paper,
      display: 'flex',
      flexDirection: 'column',
      gap: theme.spacing(1.5),
      transition: 'border-color 120ms, transform 120ms',
      '&:hover': { borderColor: theme.palette.primary.main, transform: 'translateY(-1px)' },
    },
    kicker: { fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: theme.palette.text.secondary },
    title: { fontSize: 18, fontWeight: 700 },
    stats: { display: 'flex', gap: theme.spacing(3), fontSize: 13, color: theme.palette.text.secondary },
    num: { color: theme.palette.text.primary, fontWeight: 700, fontSize: 18, display: 'block' },
    empty: {
      border: `1px dashed ${theme.palette.divider}`,
      borderRadius: 16,
      padding: theme.spacing(5),
      textAlign: 'center',
      width: '100%',
      maxWidth: 520,
    },
  };
});

const ProjectNode = ({ system, parts }: { system: Entity; parts: Entity[] }) => {
  const classes = useStyles();
  const { ci, cd, repoOnly: repos } = classifyParts(parts);
  const used = [...CI_TOOLS, ...CD_TOOLS].filter(t => parts.some(p => toolState(p, t).kind !== 'missing'));
  return (
    <div className={classes.card}>
      <Box>
        <div className={classes.kicker}>DevOps Space</div>
        <div className={classes.title}>{system.metadata.title ?? system.metadata.name}</div>
        <Typography variant="body2" color="textSecondary">{system.metadata.description ?? ''}</Typography>
      </Box>
      <div className={classes.stats}>
        <span><span className={classes.num}>{ci.length}</span>CI pipelines</span>
        <span><span className={classes.num}>{cd.length}</span>CD pipelines</span>
        <span><span className={classes.num}>{repos.length}</span>repo only</span>
      </div>
      <Box display="flex" flexWrap="wrap" style={{ gap: 6 }} minHeight={28}>
        {used.length === 0 ? (
          <Typography variant="caption" color="textSecondary">No pipelines yet</Typography>
        ) : (
          used.map(t => <ToolLogo key={t.id} tool={t} size={28} />)
        )}
      </Box>
      <EntityRefLink entityRef={system} style={{ textDecoration: 'none' }}>
        <Button fullWidth variant="outlined" color="primary" endIcon={<ArrowForward />}>
          Open space
        </Button>
      </EntityRefLink>
    </div>
  );
};

/** Entity (Domain) → hierarchy: Entity on top, its projects (DevOps Spaces) below. */
export const SpaceOverview = () => {
  const classes = useStyles();
  const { entity } = useEntity();
  const name = entity.metadata.name;
  const [reload, setReload] = useState(0);
  const { value, loading, error } = useProjects(name, reload);
  const [creating, setCreating] = useState(false);
  const identityApi = useApi(identityApiRef);
  const { value: refs = [] } = useAsync(async () => (await identityApi.getBackstageIdentity()).ownershipEntityRefs, []);
  const canCreate = refs.includes('group:default/platform-team') || refs.includes(`group:default/${name}-admins`);
  const createButton = canCreate && (
    <Button variant="contained" color="primary" disableElevation startIcon={<AddIcon />} onClick={() => setCreating(true)}>
      Create space
    </Button>
  );

  if (loading && !value) return <Progress />;
  if (error) return <ResponseErrorPanel error={error} />;
  const projects = value ?? [];

  return (
    <Box>
      <Box display="flex" alignItems="center" mb={1}>
        <Typography variant="body2" color="textSecondary">
          {projects.length} DevOps Space{projects.length === 1 ? '' : 's'}
        </Typography>
        <Box ml="auto">{createButton}</Box>
      </Box>

      <div className={classes.tree}>
        <div className={classes.root}>
          <BusinessIcon />
          <Box>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, opacity: 0.85 }}>ENTITY</div>
            <div className={classes.rootTitle}>{entity.metadata.title ?? name}</div>
          </Box>
        </div>
        <div className={classes.stem} />
        {projects.length === 0 ? (
          <div className={classes.empty}>
            <FolderIcon color="disabled" style={{ fontSize: 44 }} />
            <Typography variant="h6" gutterBottom>No DevOps Spaces yet</Typography>
            <Typography variant="body2" color="textSecondary" paragraph>
              A DevOps Space holds a team's applications, CI and CD pipelines, members and docs.
            </Typography>
            {createButton || <Typography variant="body2" color="textSecondary">The owner or a manager of this entity can create one.</Typography>}
          </div>
        ) : (
          <div className={classes.children}>
            {projects.map(({ system, parts }) => (
              <div key={system.metadata.name} className={classes.child}>
                <div className={classes.childStem} />
                <ProjectNode system={system} parts={parts} />
              </div>
            ))}
          </div>
        )}
      </div>

      <CreateSpaceDialog entity={name} entityTitle={entity.metadata.title ?? name} open={creating} onClose={() => setCreating(false)}
        onCreated={() => { setTimeout(() => setReload(r => r + 1), 4000); setTimeout(() => setReload(r => r + 1), 12000); }} />
    </Box>
  );
};
