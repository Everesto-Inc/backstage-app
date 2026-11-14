import { ReactNode } from 'react';
import { Entity } from '@backstage/catalog-model';
import { discoveryApiRef, fetchApiRef, useApi } from '@backstage/core-plugin-api';
import { Box, Grid, Link, Tooltip, Typography, makeStyles } from '@material-ui/core';
import CheckCircle from '@material-ui/icons/CheckCircle';
import ErrorIcon from '@material-ui/icons/Error';
import RemoveCircleOutline from '@material-ui/icons/RemoveCircleOutline';
import useAsync from 'react-use/esm/useAsync';
import { Insights, Run, StepResult, ago, fmtDuration, insightsTarget, useInsights } from './insights';
import { Meter, STATUS, Sparkline, StatTile } from '../tools/charts';

const useStyles = makeStyles(theme => ({
  metrics: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    borderTop: `1px solid ${theme.palette.divider}`,
  },
  metric: {
    padding: theme.spacing(1.5, 2.5),
    borderRight: `1px solid ${theme.palette.divider}`,
    '&:last-child': { borderRight: 'none' },
    minWidth: 0,
  },
  mLabel: { fontSize: 12, color: theme.palette.text.secondary, fontWeight: 500 },
  mValue: { fontSize: 15, fontWeight: 650, display: 'flex', alignItems: 'center', gap: 4, marginTop: 2, flexWrap: 'wrap' },
  bars: { display: 'flex', alignItems: 'flex-end', gap: 3, height: 26, marginTop: 6 },
  bar: { width: 8, borderRadius: '3px 3px 0 0' },
}));

export const Good = ({ children }: { children: ReactNode }) => (
  <><CheckCircle style={{ fontSize: 16, color: STATUS.good }} />{children}</>
);
export const Bad = ({ children }: { children: ReactNode }) => (
  <><ErrorIcon style={{ fontSize: 16, color: STATUS.critical }} />{children}</>
);
const Muted = ({ children }: { children: ReactNode }) => (
  <Typography variant="body2" color="textSecondary" component="span">{children}</Typography>
);

const Metric = ({ label, children }: { label: ReactNode; children: ReactNode }) => {
  const c = useStyles();
  return (
    <div className={c.metric}>
      <div className={c.mLabel}>{label}</div>
      <div className={c.mValue}>{children}</div>
    </div>
  );
};

/** Last N runs as small bars: height = duration, colour = result (tooltip names it). */
export const RunBars = ({ runs }: { runs: Run[] }) => {
  const c = useStyles();
  const list = runs.slice(0, 12).reverse();
  const max = Math.max(...list.map(r => r.durationSec ?? 0), 1);
  return (
    <div className={c.bars} aria-label="last runs">
      {list.map(r => {
        const color = r.conclusion === 'success' ? STATUS.good : r.conclusion === 'failure' ? STATUS.critical : '#9e9e9e';
        return (
          <Tooltip key={r.id} title={`#${r.number} · ${r.conclusion ?? r.status} · ${fmtDuration(r.durationSec)} · ${r.event} · ${ago(r.createdAt)}`}>
            <Link href={r.url} target="_blank" rel="noopener">
              <div className={c.bar} style={{ height: Math.max(4, ((r.durationSec ?? 0) / max) * 26), background: color }} />
            </Link>
          </Tooltip>
        );
      })}
    </div>
  );
};

const scan = (r: StepResult, name: string) => {
  if (r === 'success') return <Good>{name}</Good>;
  if (r === 'failure') return <Bad>{name}</Bad>;
  return (
    <Tooltip title={r === 'skipped' ? 'skipped' : 'not reached in the last run (an earlier step failed)'}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, opacity: 0.6 }}>
        <RemoveCircleOutline style={{ fontSize: 16 }} />{name}
      </span>
    </Tooltip>
  );
};

/** CI card row — real data (GitHub Actions + SonarQube + scanner steps). */
export const RealCiMetrics = ({ entity }: { entity: Entity }) => {
  const c = useStyles();
  const { value: d, loading, error } = useInsights(entity);
  if (loading) return <Box px={3} pb={2}><Muted>Loading pipeline data…</Muted></Box>;
  if (error || !d?.exists) return <Box px={3} pb={2}><Muted>No pipeline data yet{error ? ` (${error.message})` : ''}.</Muted></Box>;
  const last = d.lastMainRun ?? d.runs?.[0];
  const commits = d.commitsPerDay ?? [];
  const s = d.sonar;
  const has = (k: string) => k in (d.scanners ?? {});
  return (
    <div className={c.metrics}>
      <Metric label={last ? <>Last build · <Link href={last.url} target="_blank" rel="noopener">#{last.number}</Link> · {ago(last.createdAt)} · {fmtDuration(last.durationSec)}</> : 'Last build'}>
        <Box width="100%">
          {!last ? <Muted>no runs yet</Muted> : last.conclusion === 'success' ? <Good>Success</Good> : last.status !== 'completed' ? <Muted>running…</Muted> : <Bad>{`Failed${d.failedStep ? ` · ${d.failedStep}` : ''}`}</Bad>}
          {d.runs && d.runs.length > 0 && <RunBars runs={d.runs} />}
        </Box>
      </Metric>
      <Metric label={`Commits · 14 days · ${commits.reduce((a, b) => a + b.count, 0)}`}>
        <Box width="100%"><Sparkline height={26} format={v => `${v} commits`} data={commits.map(x => ({ t: x.day.slice(5), v: x.count }))} /></Box>
      </Metric>
      <Metric label="Test coverage · new code">
        {!s?.exists ? <Muted>SonarQube not added</Muted>
          : s.error ? <Bad>Unavailable</Bad>
          : !s.analysed ? <Muted>waiting for first analysis</Muted>
          : (
            <Box width="100%">
              <Box display="flex" alignItems="baseline" style={{ gap: 8 }}>
                <span style={{ fontSize: 22, fontWeight: 700 }}>{s.coverage ?? 0}%</span>
                {s.newCoverage !== undefined && <Muted>new code {s.newCoverage}%</Muted>}
              </Box>
              <Meter value={s.coverage ?? 0} target={70} />
            </Box>
          )}
      </Metric>
      <Metric label={<>Quality gate {s?.url && <Link href={s.url} target="_blank" rel="noopener">· SonarQube</Link>}</>}>
        {!s?.exists || !s.analysed ? <Muted>—</Muted>
          : s.gate === 'OK' ? <Good>{`Passed · ${s.bugs ?? 0} bugs · ${s.codeSmells ?? 0} smells`}</Good>
          : <Bad>{`Failed · ${s.newIssues ?? 0} new issues`}</Bad>}
      </Metric>
      <Metric label="Security scans · last main run">
        <Box display="flex" flexDirection="column" style={{ gap: 2, fontSize: 14 }}>
          {has('gitleaks') && scan(d.scanners!.gitleaks, 'Gitleaks · secrets')}
          {has('semgrep') && scan(d.scanners!.semgrep, 'Semgrep · code')}
          {has('trivyDeps') && scan(d.scanners!.trivyDeps, 'Trivy · dependencies')}
          {has('trivyImage') && scan(d.scanners!.trivyImage, 'Trivy · image')}
          {!has('gitleaks') && !has('semgrep') && !has('trivyDeps') && <Muted>No scanner added</Muted>}
        </Box>
      </Metric>
    </div>
  );
};

/** CD card row — real data (latest commit in the gitops folder). */
export const RealCdMetrics = ({ entity }: { entity: Entity }) => {
  const c = useStyles();
  const { value: d, loading } = useInsights(entity);
  if (loading) return <Box px={3} pb={2}><Muted>Loading…</Muted></Box>;
  return (
    <div className={c.metrics}>
      <Metric label="Last deploy (gitops)">
        {d?.lastDeploy ? <Link href={d.lastDeploy.url} target="_blank" rel="noopener">{ago(d.lastDeploy.at)}</Link> : <Muted>not deployed yet</Muted>}
      </Metric>
      <Metric label="Change">{d?.lastDeploy ? <span style={{ fontWeight: 500, fontSize: 13 }}>{d.lastDeploy.message}</span> : <Muted>—</Muted>}</Metric>
      <Metric label="Sync · health"><Muted>ArgoCD not connected yet</Muted></Metric>
    </div>
  );
};

/** Fetch insights for many CI pipelines at once (project summary). */
const useManyInsights = (entities: Entity[]) => {
  const discovery = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  return useAsync(async () => {
    const base = await discovery.getBaseUrl('everesto');
    return Promise.all(entities.map(async e => {
      const { repo, project, app } = insightsTarget(e);
      const r = await fetchApi.fetch(`${base}/pipeline/${encodeURIComponent(repo)}?project=${project}&app=${app}`);
      return r.ok ? ((await r.json()) as Insights) : undefined;
    }));
  }, [entities.map(e => e.metadata.name).join(',')]);
};

/** Project summary tiles — real data. */
export const RealSummary = ({ ci }: { ci: Entity[] }) => {
  const { value, loading } = useManyInsights(ci);
  if (loading || !value) return null;
  const list = value.filter((x): x is Insights => Boolean(x?.exists));
  const commits = Array.from({ length: 14 }, (_, i) => list.reduce((n, x) => n + (x.commitsPerDay?.[i]?.count ?? 0), 0));
  const days = list[0]?.commitsPerDay?.map(d => d.day.slice(5)) ?? [];
  const lastRuns = list.map(x => x.lastMainRun ?? x.runs?.[0]).filter(Boolean) as Run[];
  const failing = lastRuns.filter(r => r.status === 'completed' && r.conclusion !== 'success').length;
  const runs14 = list.flatMap(x => x.runs ?? []).filter(r => Date.now() - Date.parse(r.createdAt) < 14 * 864e5 && r.status === 'completed');
  const okRate = runs14.length ? Math.round((runs14.filter(r => r.conclusion === 'success').length / runs14.length) * 100) : undefined;
  const scanFails = list.reduce((n, x) => n + Object.values(x.scanners ?? {}).filter(v => v === 'failure').length, 0);
  const gateFails = list.filter(x => x.sonar?.analysed && x.sonar.gate && x.sonar.gate !== 'OK').length;
  return (
    <Grid container spacing={2}>
      <Grid item xs={12} sm={6} md={3}>
        <StatTile label="Commits · 14 days" value={commits.reduce((a, b) => a + b, 0)}>
          <Sparkline format={v => `${v} commits`} data={commits.map((v, i) => ({ t: days[i] ?? '', v }))} />
        </StatTile>
      </Grid>
      <Grid item xs={12} sm={6} md={3}>
        <StatTile label="Builds · last run of each pipeline" value={failing === 0 ? <Good>All green</Good> : <Bad>{`${failing} failing`}</Bad>} delta={`${lastRuns.length} CI pipelines`} />
      </Grid>
      <Grid item xs={12} sm={6} md={3}>
        <StatTile label="Success rate · 14 days" value={okRate === undefined ? '—' : `${okRate} %`} delta={`${runs14.length} runs`} />
      </Grid>
      <Grid item xs={12} sm={6} md={3}>
        <StatTile
          label="Needs attention"
          value={failing + scanFails + gateFails === 0 ? <Good>Nothing</Good> : <Bad>{`${failing + scanFails + gateFails} items`}</Bad>}
          delta={`${failing} failing builds · ${scanFails} failed scans · ${gateFails} failed gates`}
        />
      </Grid>
    </Grid>
  );
};

/** Application → CI tab: real runs (GitHub Actions). */
export const RealCiTab = ({ entity }: { entity: Entity }) => {
  const { value: d, loading, error } = useInsights(entity);
  if (loading) return <Muted>Loading…</Muted>;
  if (error || !d?.exists) return <Muted>No pipeline data yet.</Muted>;
  const runs = (d.runs ?? []).filter(r => r.status === 'completed');
  const ok = runs.filter(r => r.conclusion === 'success').length;
  const durs = runs.map(r => r.durationSec ?? 0).sort((a, b) => a - b);
  const median = durs.length ? durs[Math.floor(durs.length / 2)] : undefined;
  const last = d.lastMainRun ?? d.runs?.[0];
  return (
    <Grid container spacing={2}>
      <Grid item xs={12} md={4}><StatTile label={`Success rate · last ${runs.length} runs`} value={runs.length ? `${Math.round((ok / runs.length) * 100)} %` : '—'} /></Grid>
      <Grid item xs={12} md={4}><StatTile label="Median duration" value={fmtDuration(median)} /></Grid>
      <Grid item xs={12} md={4}>
        <StatTile label="Last main run" value={!last ? '—' : last.conclusion === 'success' ? <Good>Success</Good> : <Bad>Failed</Bad>} delta={last ? `#${last.number} · ${ago(last.createdAt)}${d.failedStep ? ` · failed at: ${d.failedStep}` : ''}` : undefined} />
      </Grid>
      <Grid item xs={12}>
        <Box p={2} borderRadius={12} style={{ border: '1px solid rgba(128,128,128,0.25)' }}>
          <Typography variant="subtitle2" gutterBottom>Runs · duration and result (newest right)</Typography>
          <RunBars runs={d.runs ?? []} />
          <Box mt={2} style={{ fontSize: 13 }}>
            {(d.runs ?? []).slice(0, 10).map(r => (
              <Box key={r.id} display="flex" style={{ gap: 12, padding: '4px 0', borderTop: '1px solid rgba(128,128,128,0.15)' }}>
                <span style={{ width: 70 }}>{r.conclusion === 'success' ? <Good>ok</Good> : r.conclusion === 'failure' ? <Bad>fail</Bad> : <Muted>{r.status}</Muted>}</span>
                <Link href={r.url} target="_blank" rel="noopener" style={{ width: 50 }}>#{r.number}</Link>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
                <Muted>{r.event} · {r.actor}</Muted>
                <span style={{ width: 70, textAlign: 'right' }}>{fmtDuration(r.durationSec)}</span>
                <Muted>{ago(r.createdAt)}</Muted>
              </Box>
            ))}
          </Box>
        </Box>
      </Grid>
    </Grid>
  );
};

/** Application → Security tab: real scanner results + SonarQube security measures. */
export const RealSecurityTab = ({ entity }: { entity: Entity }) => {
  const { value: d, loading } = useInsights(entity);
  if (loading) return <Muted>Loading…</Muted>;
  const sc = d?.scanners ?? {};
  const s = d?.sonar;
  const rows: [string, string, StepResult | 'n/a'][] = [
    ['Gitleaks', 'secrets committed to the repo', 'gitleaks' in sc ? sc.gitleaks : 'n/a'],
    ['Semgrep', 'code security (SAST)', 'semgrep' in sc ? sc.semgrep : 'n/a'],
    ['Trivy', 'vulnerable dependencies', 'trivyDeps' in sc ? sc.trivyDeps : 'n/a'],
    ['Trivy', 'container image (OS + libraries)', 'trivyImage' in sc ? sc.trivyImage : 'n/a'],
  ];
  return (
    <Grid container spacing={2}>
      <Grid item xs={12} md={4}><StatTile label="SonarQube · vulnerabilities" value={s?.analysed ? s.vulnerabilities ?? 0 : '—'} /></Grid>
      <Grid item xs={12} md={4}><StatTile label="SonarQube · security hotspots to review" value={s?.analysed ? s.hotspots ?? 0 : '—'} /></Grid>
      <Grid item xs={12} md={4}><StatTile label="Scans failing · last main run" value={Object.values(sc).filter(v => v === 'failure').length} delta={d?.failedStep ? `stopped at: ${d.failedStep}` : undefined} /></Grid>
      <Grid item xs={12}>
        <Box p={2} borderRadius={12} style={{ border: '1px solid rgba(128,128,128,0.25)' }}>
          <Typography variant="subtitle2" gutterBottom>Scanners · result of the last run on main</Typography>
          {rows.map(([tool, what, r]) => (
            <Box key={tool + what} display="flex" alignItems="center" style={{ gap: 12, padding: '6px 0', borderTop: '1px solid rgba(128,128,128,0.15)' }}>
              <b style={{ width: 90 }}>{tool}</b>
              <span style={{ flex: 1 }}>{what}</span>
              {r === 'n/a' ? <Muted>not added</Muted> : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>{scan(r, r === 'success' ? 'passed' : r === 'failure' ? 'failed — see the run log' : 'not reached')}</span>}
            </Box>
          ))}
          {d?.lastMainRun && <Box mt={1}><Link href={d.lastMainRun.url} target="_blank" rel="noopener">Open run #{d.lastMainRun.number} on GitHub</Link></Box>}
        </Box>
      </Grid>
    </Grid>
  );
};
