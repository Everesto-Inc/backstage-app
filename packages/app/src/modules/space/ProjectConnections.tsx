import { useState } from 'react';
import { useEntity } from '@backstage/plugin-catalog-react';
import { Box, Button, TextField, Typography, makeStyles } from '@material-ui/core';
import LockIcon from '@material-ui/icons/Lock';
import CheckCircle from '@material-ui/icons/CheckCircle';
import { useIsProjectOwner } from './data';
import { PreviewDialog } from './PreviewDialog';
import { TOOLS, Tool } from '../tools/tools';
import { ToolLogo } from '../tools/ToolLogo';
import { STATUS } from '../tools/charts';

/**
 * Who connects a tool:
 *   none      → pipeline-only CLI / repo config (Gitleaks, Semgrep, Trivy, Dependabot) — nothing to connect.
 *   platform  → shared tool run by the platform (SonarQube, ArgoCD, Grafana, Infisical, GitHub).
 *               Platform admins connect it ONCE; projects just use it. No token for owners.
 *   project   → tool the tenant brings / licenses itself (Fortify, Nexus IQ, their own AWX).
 *               The project owner connects it here: URL + token, written straight into the
 *               project's Infisical (write-only, never shown again, never stored by Backstage).
 */
// DUMMY: which project-level tools seine already connected
const CONNECTED_PROJECT_TOOLS = ['deps'];

const useStyles = makeStyles(theme => ({
  list: { border: `1px solid ${theme.palette.divider}`, borderRadius: 14, background: theme.palette.background.paper },
  row: {
    display: 'flex', alignItems: 'center', gap: theme.spacing(2), padding: theme.spacing(1.5, 2),
    borderBottom: `1px solid ${theme.palette.divider}`, '&:last-child': { borderBottom: 'none' },
  },
  pill: {
    fontSize: 12, fontWeight: 600, padding: '2px 10px', borderRadius: 999, whiteSpace: 'nowrap',
    display: 'inline-flex', alignItems: 'center', gap: 4,
  },
}));

export const ProjectConnections = () => {
  const classes = useStyles();
  const { entity } = useEntity();
  const project = entity.metadata.name;
  const isOwner = useIsProjectOwner(project);
  const [connecting, setConnecting] = useState<Tool | undefined>();

  const section = (level: 'none' | 'platform' | 'project', title: string, hint: string) => (
    <Box mb={4}>
      <Typography variant="h6">{title}</Typography>
      <Typography variant="body2" color="textSecondary" paragraph>{hint}</Typography>
      <div className={classes.list}>
        {TOOLS.filter(t => t.connection === level).map(t => {
          const connected = level !== 'project' || CONNECTED_PROJECT_TOOLS.includes(t.id);
          return (
            <div key={t.id} className={classes.row}>
              <ToolLogo tool={t} />
              <Box minWidth={0}>
                <b>{t.name}</b>
                <Typography variant="body2" color="textSecondary">{t.description}</Typography>
              </Box>
              <Box ml="auto" display="flex" alignItems="center" style={{ gap: 12 }}>
                {connected ? (
                  <span className={classes.pill} style={{ color: STATUS.good, background: 'rgba(12,163,12,0.12)' }}>
                    <CheckCircle style={{ fontSize: 14 }} />
                    {level === 'platform' ? 'Provided by platform' : level === 'none' ? 'Ready — no connection needed' : 'Connected'}
                  </span>
                ) : (
                  <span className={classes.pill} style={{ border: '1px solid rgba(128,128,128,0.4)' }}>Not connected</span>
                )}
                {level === 'project' && isOwner && (
                  <Button size="small" variant={connected ? 'outlined' : 'contained'} color="primary" disableElevation onClick={() => setConnecting(t)}>
                    {connected ? 'Rotate' : 'Connect'}
                  </Button>
                )}
              </Box>
            </div>
          );
        })}
      </div>
    </Box>
  );

  return (
    <Box maxWidth={960}>
      {section('platform', 'Platform tools', 'Shared tools run by the platform team — already connected for every project. Nothing to configure.')}
      {section('project', 'Project tools', isOwner
        ? 'Tools your project licenses or runs itself. As owner you connect them once; every pipeline in this project can then use them.'
        : 'Tools this project licenses or runs itself. Only project owners can connect them.')}
      {section('none', 'Pipeline tools', 'Free tools that run as a step inside the pipeline (no server, no token). Nothing to connect — add them to a pipeline with Edit.')}

      <Box display="flex" alignItems="center" style={{ gap: 8 }}>
        <LockIcon fontSize="small" color="action" />
        <Typography variant="caption" color="textSecondary">
          Tokens are written straight to this project's Infisical vault — write-only, never shown again, never stored in Backstage or GitHub.
        </Typography>
      </Box>

      <PreviewDialog
        open={Boolean(connecting)}
        onClose={() => setConnecting(undefined)}
        title={`Connect ${connecting?.name ?? ''} · ${project}`}
        steps={[
          `tests the URL + token against ${connecting?.name ?? ''} (read-only call)`,
          `writes the token to Infisical project ${project}, folder /_connections/${connecting?.id ?? ''} (write-only)`,
          'Backstage keeps only the reference — the value is never displayed again',
          'pipelines of this project can now add the tool via Edit',
        ]}
      >
        <Box display="flex" flexDirection="column" style={{ gap: 12 }}>
          <TextField label={`${connecting?.name ?? ''} URL`} placeholder="https://…" variant="outlined" size="small" fullWidth />
          <TextField label="API token" type="password" variant="outlined" size="small" fullWidth helperText="Write-only — stored in Infisical, never shown again" />
        </Box>
      </PreviewDialog>
    </Box>
  );
};
