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
 * A pipeline as a chain of connected tool logos: GitHub — Actions — Image — SonarQube …
 * Only tools the app uses are drawn. Status dot per tool: green = connected, red = error
 * (tooltip names the tool + state, so color never carries meaning alone).
 * The link after a tool is green when that tool is connected, red when it fails.
 */
export const PipelineFlow = ({ entity, tools, size = 34, labels = false }: { entity: Entity; tools: Tool[]; size?: number; labels?: boolean }) => {
  const classes = useStyles();
  const theme = useTheme();
  const used = tools
    .map(t => ({ tool: t, state: toolState(entity, t) }))
    .filter(x => x.state.kind !== 'missing');

  if (used.length === 0)
    return <Typography variant="body2" color="textSecondary">No tools yet</Typography>;

  return (
    <div className={classes.flow} aria-label="pipeline">
      {used.map(({ tool, state }, i) => {
        const color = state.kind === 'error' ? STATUS.critical : STATUS.good;
        const prevErr = i > 0 && used[i - 1].state.kind === 'error';
        return (
          <Fragment key={tool.id}>
            {i > 0 && (
              <div
                className={classes.link}
                style={{ marginTop: size / 2 - 1, background: prevErr ? STATUS.critical : theme.palette.type === 'dark' ? 'rgba(12,163,12,0.6)' : 'rgba(12,163,12,0.45)' }}
              />
            )}
            <Tooltip
              title={
                state.kind === 'error'
                  ? `${tool.name} — error: ${state.reason}`
                  : `${tool.name} — connected`
              }
            >
              <div className={classes.step}>
                <Box className={classes.node}>
                  <ToolLogo tool={tool} size={size} />
                  <span className={classes.dot} style={{ background: color, width: size > 40 ? 14 : 12, height: size > 40 ? 14 : 12 }} />
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
