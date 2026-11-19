import { useEntity } from '@backstage/plugin-catalog-react';
import { InfoCard, Table } from '@backstage/core-components';
import { Box, Grid, Typography } from '@material-ui/core';
import CheckCircle from '@material-ui/icons/CheckCircle';
import ErrorIcon from '@material-ui/icons/Error';
import { SECURITY_TOOL_IDS, TOOLS, toolState } from './tools';
import { ToolLogo } from './ToolLogo';
import { STATUS, StatTile, Sparkline } from './charts';
import { days, metricsFor } from '../space/metrics';
import { useDemoData } from '../space/demo';
import { RealSecurityTab } from '../space/RealMetrics';

/**
 * Application → "Security": one place for all scanners (Gitleaks, Semgrep, Trivy,
 * Fortify, Nexus IQ, Dependabot). Only connected scanners report; others say "not added".
 * DUMMY findings — later read from SonarQube (SARIF imports) / each tool's API.
 */
export const SecurityTab = () => {
  const { entity } = useEntity();
  const demo = useDemoData();
  const m = metricsFor(entity);
  const scanners = TOOLS.filter(t => SECURITY_TOOL_IDS.includes(t.id));
  const on = (id: string) => toolState(entity, TOOLS.find(t => t.id === id)!).kind === 'connected';

  const findings = [
    on('semgrep') && { tool: 'Semgrep', sev: 'high', what: 'SQL injection — string-built query', where: 'src/main/java/…/OrderRepository.java:42', fix: 'use a prepared statement / named parameter' },
    on('trivy') && { tool: 'Trivy', sev: 'high', what: 'CVE in jackson-databind 2.15.0', where: 'pom.xml', fix: 'upgrade to 2.17.1 (Dependabot PR #12 open)' },
    on('trivy') && { tool: 'Trivy', sev: 'medium', what: 'CVE in base image libssl', where: 'Dockerfile (eclipse-temurin:21-jre)', fix: 'rebuild on latest base image' },
    on('sast') && { tool: 'Fortify', sev: 'high', what: 'Path manipulation', where: 'src/main/java/…/FileService.java:88', fix: 'normalise + whitelist the path' },
    on('deps') && { tool: 'Nexus IQ', sev: 'medium', what: 'Licence policy: GPL-3.0 dependency', where: 'some-lib 0.4', fix: 'replace with an Apache-2.0 alternative' },
  ].filter(Boolean) as { tool: string; sev: string; what: string; where: string; fix: string }[];

  if (!demo) return <RealSecurityTab entity={entity} />;
  let secretsValue = <span style={{ color: STATUS.good, display: 'inline-flex', alignItems: 'center', gap: 4 }}><CheckCircle /> None</span>;
  if (!on('secrets-scan')) secretsValue = <span style={{ fontSize: 18, opacity: 0.6 }}>not added</span>;
  else if (m.secretsFound) secretsValue = <span style={{ color: STATUS.critical }}>{m.secretsFound} found</span>;
  return (
    <Box>
      <Grid container spacing={2}>

        {demo && <><Grid item xs={12} md={4}>
          <StatTile
            label="Open high / critical"
            value={findings.filter(f => f.sev === 'high').length}
            delta="from connected scanners only"
          >
            <Sparkline data={days([9, 9, 8, 8, 7, 7, 6, 5, 5, 4, 4, findings.filter(f => f.sev === 'high').length])} />
          </StatTile>
        </Grid>
        <Grid item xs={12} md={4}>
          <StatTile
            label="Secrets in code (Gitleaks)"
            value={secretsValue}
            delta="a found secret always blocks the build"
          />
        </Grid>
        <Grid item xs={12} md={4}>
          <StatTile label="Fixable now" value={findings.filter(f => /upgrade|rebuild/.test(f.fix)).length} delta="have a fix version or rebuild available" />
        </Grid></>}

        <Grid item xs={12}>
          <InfoCard title="Scanners">
            <Box display="flex" flexWrap="wrap" style={{ gap: 24 }}>
              {scanners.map(t => {
                const st = toolState(entity, t);
                return (
                  <Box key={t.id} display="flex" alignItems="center" style={{ gap: 10, minWidth: 200 }}>
                    <ToolLogo tool={t} />
                    <Box>
                      <b>{t.name}</b>{' '}
                      <Typography component="span" variant="caption" color="textSecondary">{t.licence === 'enterprise' ? 'enterprise' : 'free'}</Typography>
                      <Typography variant="body2" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        {st.kind === 'connected' && <><CheckCircle style={{ fontSize: 14, color: STATUS.good }} /> scanning</>}
                        {st.kind === 'error' && <><ErrorIcon style={{ fontSize: 14, color: STATUS.critical }} /> unavailable</>}
                        {st.kind === 'missing' && <span style={{ opacity: 0.6 }}>not added</span>}
                      </Typography>
                    </Box>
                  </Box>
                );
              })}
            </Box>
          </InfoCard>
        </Grid>

        {demo && <Grid item xs={12}>
          <Table
            title="Fix these first"
            subtitle="Highest severity first · each with where and how to fix"
            options={{ search: false, paging: false, padding: 'dense' }}
            columns={[
              { title: 'Severity', field: 'sev', render: (r: any) => (
                <span style={{ color: r.sev === 'high' ? STATUS.critical : undefined, fontWeight: 600 }}>
                  {r.sev === 'high' ? '⚠ high' : 'medium'}
                </span>
              ) },
              { title: 'Finding', field: 'what' },
              { title: 'Where', field: 'where' },
              { title: 'How to fix', field: 'fix' },
              { title: 'Scanner', field: 'tool' },
            ]}
            data={findings.sort((a, b) => Number(b.sev === 'high') - Number(a.sev === 'high'))}
          />
        </Grid>}
      </Grid>
    </Box>
  );
};
