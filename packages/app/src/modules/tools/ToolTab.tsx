import { useEntity } from '@backstage/plugin-catalog-react';
import { InfoCard, Table } from '@backstage/core-components';
import { Box, Button, Grid, Typography } from '@material-ui/core';
import ErrorIcon from '@material-ui/icons/Error';
import CheckCircle from '@material-ui/icons/CheckCircle';
import { TOOLS, Tool, toolState } from './tools';
import { Meter, RunColumns, STATUS, Sparkline, StatTile } from './charts';
import { ToolLogo } from './ToolLogo';
import { ConnectToSee, useDemoData } from '../space/demo';
import { compatWrapper } from '@backstage/core-compat-api';
import { SonarQubeCard } from '@backstage-community/plugin-sonarqube';
import { RealCiTab, RealCodeTab, RealImageTab } from '../space/RealMetrics';
import { SecretsTab } from '../space/SecretsTab';

// DUMMY data — layout preview only. Each tab becomes the real plugin later.

const days = (vals: number[]) =>
  vals.map((v, i) => ({ t: `${vals.length - i - 1 === 0 ? 'today' : `${vals.length - i - 1}d ago`}`, v }));

const Ok = ({ children }: { children: string }) => (
  <span style={{ color: STATUS.good, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
    <CheckCircle style={{ fontSize: 20 }} /> {children}
  </span>
);

const NotAdded = ({ tool }: { tool: Tool }) => (
  <InfoCard title={<Box display="flex" alignItems="center" style={{ gap: 12 }}><ToolLogo tool={tool} />{`${tool.name} is not set up for this application`}</Box>}>
    <Typography variant="body2" paragraph>{tool.description}.</Typography>
    <Typography variant="body2" paragraph color="textSecondary">
      Add it from the <b>Tools</b> card on the Overview tab — a template provisions it and opens a pull
      request with the CI change, the annotation <code>{tool.annotation}</code> and the docs <code>{tool.docsPath}</code>.
    </Typography>
    <Button variant="contained" color="primary" disableElevation disabled>Add {tool.name} (preview)</Button>
  </InfoCard>
);

const ErrorBanner = ({ tool, reason }: { tool: Tool; reason: string }) => (
  <Box
    mb={2}
    p={2}
    borderRadius={12}
    display="flex"
    alignItems="center"
    style={{ gap: 12, background: 'rgba(208,59,59,0.10)', border: `1px solid ${STATUS.critical}` }}
  >
    <ErrorIcon style={{ color: STATUS.critical }} />
    <Box>
      <Typography variant="subtitle2">{tool.name} connection error</Typography>
      <Typography variant="body2" color="textSecondary">{reason} — showing last known data.</Typography>
    </Box>
    <Box ml="auto"><Button variant="outlined" size="small">Reconnect</Button></Box>
  </Box>
);


const CodeContent = ({ repo }: { repo: string }) => (
  <Grid container spacing={2}>
    <Grid item xs={12} md={3}><StatTile label="Repository" value={<span style={{ fontSize: 18 }}>{repo}</span>} delta="private · default branch main" /></Grid>
    <Grid item xs={12} md={3}><StatTile label="Open pull requests" value="3" delta="oldest 2 days" /></Grid>
    <Grid item xs={12} md={3}><StatTile label="Branch protection" value={<Ok>On</Ok>} delta="1 review + CI required" /></Grid>
    <Grid item xs={12} md={3}>
      <StatTile label="Commits / day" value="7" delta="14 days">
        <Sparkline format={v => `${v} commits`} data={days([3, 5, 2, 8, 6, 4, 0, 1, 7, 9, 5, 6, 8, 7])} />
      </StatTile>
    </Grid>
  </Grid>
);

const SastContent = () => (
  <Grid container spacing={2}>
    <Grid item xs={12} md={3}><StatTile label="Critical" value="0" delta="last scan 3 h ago" /></Grid>
    <Grid item xs={12} md={3}><StatTile label="High" value="2" delta="−1 vs previous scan" /></Grid>
    <Grid item xs={12} md={3}><StatTile label="Medium" value="11" /></Grid>
    <Grid item xs={12} md={3}>
      <StatTile label="Open issues" value="13" delta="30-day trend">
        <Sparkline data={days([22, 21, 20, 18, 18, 17, 16, 15, 15, 14, 14, 13])} />
      </StatTile>
    </Grid>
  </Grid>
);

const DepsContent = () => (
  <Table
    title="Policy violations (dummy)"
    options={{ search: false, paging: false, padding: 'dense' }}
    columns={[
      { title: 'Component', field: 'c' },
      { title: 'Issue', field: 'i' },
      { title: 'Threat', field: 't' },
      { title: 'Fix', field: 'f' },
    ]}
    data={[
      { c: 'jackson-databind 2.15.0', i: 'CVE (deserialization)', t: <span style={{ color: STATUS.critical }}>✕ 8 · high</span>, f: '2.17.1' },
      { c: 'commons-text 1.9', i: 'CVE (interpolation)', t: <span style={{ color: STATUS.critical }}>✕ 9 · critical</span>, f: '1.10.0' },
      { c: 'some-lib 0.4', i: 'License: GPL-3.0', t: <span>⚠ 5 · license</span>, f: 'replace' },
    ]}
  />
);

const ConfigContent = ({ job }: { job: string }) => (
  <Table
    title={`AWX job template · ${job}`}
    options={{ search: false, paging: false, padding: 'dense' }}
    columns={[
      { title: 'Run', field: 'r' },
      { title: 'Result', field: 's' },
      { title: 'Changed', field: 'c' },
      { title: 'When', field: 'w' },
    ]}
    data={[
      { r: '#118', s: <Ok>successful</Ok>, c: '2 hosts', w: 'yesterday' },
      { r: '#117', s: <Ok>successful</Ok>, c: '0 hosts', w: '3 days ago' },
    ]}
  />
);

const CiContent = () => (
  <Grid container spacing={2}>
    <Grid item xs={12} md={4}><StatTile label="Success rate (30 runs)" value="93 %" delta="+4 pts vs previous 30" /></Grid>
    <Grid item xs={12} md={4}><StatTile label="Median duration" value="5.9 min" delta="−0.4 min vs previous 30" /></Grid>
    <Grid item xs={12} md={4}><StatTile label="Last run" value={<Ok>Success</Ok>} delta="#42 · 2 h ago" /></Grid>
    <Grid item xs={12}>
      <InfoCard title="Last 12 runs — duration">
        <RunColumns
          runs={[6.2, 5.8, 3.7, 6.0, 5.6, 6.4, 5.9, 2.9, 6.1, 5.7, 6.0, 6.2].map((m, i) => ({
            id: `#${31 + i}`,
            minutes: m,
            ok: ![2, 7].includes(i),
            commit: ['feat: orders API', 'fix: null check', 'test: broken mock', 'chore: deps', 'feat: auth', 'refactor', 'docs', 'build: bad cache', 'feat: search', 'fix: paging', 'chore: lint', 'feat: export'][i],
          }))}
        />
      </InfoCard>
    </Grid>
  </Grid>
);

const QualityContent = () => (
  <Grid container spacing={2}>
    <Grid item xs={12} md={3}><StatTile label="Quality gate" value={<Ok>Passed</Ok>} delta="last analysis 2 h ago" /></Grid>
    <Grid item xs={12} md={3}>
      <StatTile label="Coverage" value="78.4 %" delta="gate ≥ 70 %">
        <Meter value={78.4} target={70} />
      </StatTile>
    </Grid>
    <Grid item xs={12} md={3}>
      <StatTile label="Bugs" value="0" delta="30-day trend">
        <Sparkline data={days([4, 3, 3, 2, 2, 1, 1, 1, 0, 0, 0, 0])} />
      </StatTile>
    </Grid>
    <Grid item xs={12} md={3}>
      <StatTile label="Code smells" value="23" delta="30-day trend">
        <Sparkline data={days([41, 39, 36, 35, 33, 31, 30, 28, 27, 25, 24, 23])} />
      </StatTile>
    </Grid>
  </Grid>
);

const CdContent = ({ app }: { app: string }) => (
  <Grid container spacing={2}>
    <Grid item xs={12} md={3}><StatTile label="ArgoCD app" value={<span style={{ fontSize: 20 }}>{app}</span>} delta="namespace loire" /></Grid>
    <Grid item xs={12} md={3}><StatTile label="Sync" value={<Ok>Synced</Ok>} delta="main · 2 h ago" /></Grid>
    <Grid item xs={12} md={3}><StatTile label="Health" value={<Ok>Healthy</Ok>} delta="1/1 pods ready" /></Grid>
    <Grid item xs={12} md={3}><StatTile label="Image" value={<span style={{ fontSize: 20 }}>sha-3f9c2a1</span>} delta="deployed 2 h ago" /></Grid>
    <Grid item xs={12}>
      <InfoCard title="Deployments per day (14 days)">
        <Sparkline height={96} format={v => `${v} deploys`} data={days([1, 0, 2, 1, 3, 1, 0, 0, 2, 4, 1, 2, 3, 2])} />
      </InfoCard>
    </Grid>
  </Grid>
);

const SecretsContent = ({ path }: { path: string }) => (
  <Table
    title={`Infisical · ${path}`}
    subtitle="Key names only — values are never shown in Backstage"
    options={{ search: false, paging: false, padding: 'dense' }}
    columns={[
      { title: 'Key', field: 'key' },
      { title: 'Used by', field: 'by' },
      { title: 'Last rotated', field: 'rotated' },
    ]}
    data={[
      { key: 'DB_PASSWORD', by: 'K8s secret (ESO)', rotated: '12 days ago' },
      { key: 'DB_HOST', by: 'K8s secret (ESO)', rotated: '12 days ago' },
      { key: 'SONAR_TOKEN', by: 'CI only', rotated: '3 days ago' },
    ]}
  />
);

const MonitoringContent = () => (
  <Grid container spacing={2}>
    <Grid item xs={12} md={4}>
      <StatTile label="Requests / s" value="12.3" delta="24 h">
        <Sparkline format={v => `${v} req/s`} data={days([8, 9, 11, 10, 12, 14, 13, 12, 11, 12, 13, 12.3])} />
      </StatTile>
    </Grid>
    <Grid item xs={12} md={4}>
      <StatTile label="p95 latency" value="180 ms" delta="24 h">
        <Sparkline format={v => `${v} ms`} data={days([210, 200, 190, 220, 205, 195, 185, 190, 182, 178, 181, 180])} />
      </StatTile>
    </Grid>
    <Grid item xs={12} md={4}>
      <StatTile label="Error rate" value="0.2 %" delta="24 h">
        <Sparkline format={v => `${v} %`} data={days([0.5, 0.4, 0.4, 0.6, 0.3, 0.3, 0.2, 0.3, 0.2, 0.2, 0.1, 0.2])} />
      </StatTile>
    </Grid>
  </Grid>
);

export const makeToolTab = (toolId: string) => () => {
  const { entity } = useEntity();
  const tool = TOOLS.find(t => t.id === toolId)!;
  const state = toolState(entity, tool);
  const demo = useDemoData();
  // real deployment (Resource <app>-gitops): Infisical always on, Ansible excluded while ArgoCD deploys
  if (!demo && entity.kind === 'Resource' && toolId === 'secrets') return <SecretsTab entity={entity} />;
  if (!demo && entity.kind === 'Resource' && toolId === 'config') {
    return <Typography variant="body2" color="textSecondary">Ansible is not used — ArgoCD deploys this app (one deployment tool per app).</Typography>;
  }
  if (state.kind === 'missing') return <NotAdded tool={tool} />;
  // Live data: SonarQube is wired (plugin + backend). Other tools follow the same pattern.
  if (!demo && toolId === 'quality') return compatWrapper(<SonarQubeCard />);
  if (!demo && toolId === 'ci') return <RealCiTab entity={entity} />;
  if (!demo && toolId === 'code') return <RealCodeTab entity={entity} />;
  if (!demo && toolId === 'registry') return <RealImageTab entity={entity} />;
  if (!demo) return <ConnectToSee what={`Live ${tool.name} data`} tools={tool.name} />;

  return (
    <Box>
      {state.kind === 'error' && <ErrorBanner tool={tool} reason={state.reason} />}
      <Box display="flex" alignItems="center" mb={2} style={{ gap: 12 }}>
        <ToolLogo tool={tool} size={40} />
        <Box>
          <Typography variant="h6" style={{ lineHeight: 1.2 }}>{tool.name}</Typography>
          <Typography variant="caption" color="textSecondary">
            <code>{tool.annotation}: {state.value}</code> · dummy data (layout preview)
          </Typography>
        </Box>
      </Box>
      {toolId === 'code' && <CodeContent repo={state.value} />}
      {toolId === 'ci' && <CiContent />}
      {toolId === 'sast' && <SastContent />}
      {toolId === 'deps' && <DepsContent />}
      {toolId === 'config' && <ConfigContent job={state.value} />}
      {toolId === 'quality' && <QualityContent />}
      {toolId === 'cd' && <CdContent app={state.value} />}
      {toolId === 'secrets' && <SecretsContent path={state.value} />}
      {toolId === 'monitoring' && <MonitoringContent />}
    </Box>
  );
};
