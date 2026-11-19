import { Fragment } from 'react';
import { Box, Tooltip, Typography, makeStyles, useTheme } from '@material-ui/core';
import { Entity } from '@backstage/catalog-model';
import { ToolLogo } from '../tools/ToolLogo';
import { Tool, toolState } from '../tools/tools';
import { STATUS } from '../tools/charts';

const useStyles = makeStyles(theme => ({
  flow: { display: 'flex', alignItems: 'flex-start', flexWrap: 'wrap', rowGap: 12 },
  step: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, minWidth: 64 },
  node: { position: 'relative', display: 'inline-flex' },
  label: { fontSize: 12, fontWeight: 500, color: theme.palette.text.secondary, whiteSpace: 'nowrap' },
  dot: {
    position: 'absolute',
    right: -3,
    bottom: -3,
    width: 12,
    height: 12,
    borderRadius: '50%',
    border: `2px solid ${theme.palette.background.paper}`,
  },
  link: { width: 28, height: 2, borderRadius: 1, flexShrink: 0 },
}));

/**
 * Where a tool icon leads — always THIS app's own page in that tool (repo, its Actions, its own image package, …).
 * undefined → icon not clickable.
 */
export const toolUrl = (entity: Entity, toolId: string): string | undefined => {
  const a = entity.metadata.annotations ?? {};
  const slug = a['github.com/project-slug']; // Everesto-Inc/<repo> (CI) or Everesto-Inc/<repo>-gitops (CD)
  const repo = slug?.split('/')[1];
  const app = repo?.replace(/-gitops$/, '');
  switch (toolId) {
    case 'code': return slug && `https://github.com/${slug}`;
    case 'ci': return slug && `https://github.com/${slug}/actions`;
    case 'secrets-scan':
    case 'semgrep':
    case 'trivy': return slug && `https://github.com/${slug}/actions/workflows/ci.yml`;
    case 'quality': return a['sonarqube.org/project-key'] && `https://sonar.everesto.live/dashboard?id=${encodeURIComponent(a['sonarqube.org/project-key'])}`;
    case 'registry': return app && `https://github.com/orgs/Everesto-Inc/packages/container/package/${app}`; // this app's own package
    case 'dependabot': return slug && `https://github.com/${slug}/pulls?q=is%3Apr+author%3Aapp%2Fdependabot`;
    case 'cd': return app && `https://argocd.everesto.live/applications?search=${encodeURIComponent(app)}`;
    case 'secrets': return undefined; // secrets are changed in Backstage (Secrets tab), not in Infisical
    case 'monitoring': return 'https://grafana.everesto.live';
    default: return undefined;
  }
};

/**
 * A pipeline as a chain of connected tool logos: GitHub — Actions — Image — SonarQube …
 * Only tools the app uses are drawn. Status dot per tool: green = connected, red = error
 * (tooltip names the tool + state, so color never carries meaning alone).
 * The link after a tool is green when that tool is connected, red when it fails.
 */
export const PipelineFlow = ({ entity, tools, size = 34, labels = false }: { entity: Entity; tools: Tool[]; size?: number; labels?: boolean }) => {
  const classes = useStyles();
  const theme = useTheme();
  const linkGreen = theme.palette.type === 'dark' ? 'rgba(12,163,12,0.6)' : 'rgba(12,163,12,0.45)';
  const used = tools
    .map(t => ({ tool: t, state: toolState(entity, t) }))
    .filter(x => x.state.kind !== 'missing');

  if (used.length === 0)
    return <Typography variant="body2" color="textSecondary">No tools yet</Typography>;

  return (
    <div className={classes.flow} aria-label="pipeline">
      {used.map(({ tool }, i) => {
        return (
          <Fragment key={tool.id}>
            {i > 0 && (
              <div
                className={classes.link}
                style={{ marginTop: size / 2 - 1, background: linkGreen }}
              />
            )}
            <Tooltip
              title={`${tool.name} — connected${toolUrl(entity, tool.id) ? ' · click to open' : ''}`}
            >
              <div className={classes.step}>
                <Box className={classes.node} component={toolUrl(entity, tool.id) ? 'a' : 'span'}
                  {...(toolUrl(entity, tool.id) ? { href: toolUrl(entity, tool.id), target: '_blank', rel: 'noopener', style: { cursor: 'pointer' } } : {})}>
                  <ToolLogo tool={tool} size={size} />
                  <span className={classes.dot} style={{ background: STATUS.good, width: size > 40 ? 14 : 12, height: size > 40 ? 14 : 12 }} />
                </Box>
                {labels && <span className={classes.label}>{tool.name}</span>}
              </div>
            </Tooltip>
          </Fragment>
        );
      })}
    </div>
  );
};
