import { useState } from 'react';
import { useEveresto } from './api';
import { alertApiRef, identityApiRef, useApi } from '@backstage/core-plugin-api';
import { Box, Chip, Collapse, Typography } from '@material-ui/core';
import ExpandMore from '@material-ui/icons/ExpandMore';
import ExpandLess from '@material-ui/icons/ExpandLess';
import useAsync from 'react-use/esm/useAsync';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import { STATUS } from '../tools/charts';
import { ago } from './insights';
import { BusyBar, BusyButton } from './Busy';

/**
 * Platform-team only: "Access check" — an audit / repair tool. Day to day there is nothing to click:
 * adding or removing a member applies that space's access right away, and a full sync runs every 30 min.
 *   Check now          = dry run of a FULL sync (changes nothing) → differences grouped by system
 *   Fix differences    = apply exactly that full sync
 * Backend: GET /api/everesto/access/status · POST /api/everesto/access/sync?dryRun=1|0
 */
type Report = { dryRun: boolean; actions: string[]; warnings: string[] };
type LastRun = Report & { at: string; trigger: 'automatic' | 'manual' };
type System = 'GitHub' | 'ArgoCD' | 'SonarQube';
const SYSTEMS: System[] = ['GitHub', 'ArgoCD', 'SonarQube'];
const systemOf = (line: string): System => {
  if (/sonarqube/i.test(line)) return 'SonarQube';
  if (/argocd/i.test(line)) return 'ArgoCD';
  return 'GitHub';
};
const summary = (r: Report) => {
  const n = r.actions.length;
  const w = r.warnings.length;
  if (!r.dryRun) return `Fixed — ${n} change(s) applied, ${w} warning(s)`;
  if (n === 0 && w === 0) return '✓ Everything matches Backstage';
  return `Check — ${n} difference(s), ${w} warning(s)`;
};
const clean = (line: string) => line.replace(/^would /, '').replace(/^SonarQube: /, '');

const Group = ({ system, actions, warnings }: { system: System; actions: string[]; warnings: string[] }) => {
  const [open, setOpen] = useState(false);
  const n = actions.length + warnings.length;
  return (
    <Box py={0.75} style={{ borderTop: '1px solid rgba(128,128,128,0.15)' }}>
      <Box display="flex" alignItems="center" style={{ gap: 8, cursor: n ? 'pointer' : 'default' }} onClick={() => n && setOpen(o => !o)}>
        <b style={{ width: 90 }}>{system}</b>
        {n === 0
          ? <Typography variant="body2" style={{ color: STATUS.good }}>✓ matches</Typography>
          : <>
              {actions.length > 0 && <Chip size="small" label={`${actions.length} change${actions.length > 1 ? 's' : ''}`} />}
              {warnings.length > 0 && <Chip size="small" label={`${warnings.length} warning${warnings.length > 1 ? 's' : ''}`} style={{ color: STATUS.warning }} />}
              {open ? <ExpandLess fontSize="small" /> : <ExpandMore fontSize="small" />}
            </>}
      </Box>
      <Collapse in={open}>
        <Box component="ul" pl={3} m={0} mt={0.5} style={{ lineHeight: 1.7, fontSize: 14 }}>
          {actions.map(a => <li key={a}>{clean(a)}</li>)}
          {warnings.map(w => <li key={w} style={{ color: STATUS.warning }}>⚠ {clean(w)}</li>)}
        </Box>
      </Collapse>
    </Box>
  );
};

const Grouped = ({ report }: { report: Report }) => (
  <Box mt={1}>
    {SYSTEMS.map(s => (
      <Group key={s} system={s}
        actions={report.actions.filter(a => systemOf(a) === s)}
        warnings={report.warnings.filter(w => systemOf(w) === s)} />
    ))}
  </Box>
);

export const AccessSyncCard = () => {
  const identityApi = useApi(identityApiRef);
  const alertApi = useApi(alertApiRef);
  const { value: refs = [] } = useAsync(async () => (await identityApi.getBackstageIdentity()).ownershipEntityRefs, []);
  const isPlatform = refs.includes('group:default/platform-team');
  const api = useEveresto();
  const status = useAsyncRetry(async (): Promise<{ lastRun: LastRun | null; everyMinutes: number | null } | undefined> =>
    (isPlatform ? api('GET', '/access/status') : undefined), [isPlatform]);
  const [busy, setBusy] = useState<'check' | 'fix' | undefined>();
  const [report, setReport] = useState<Report | undefined>();
  if (!isPlatform) return null;

  const run = async (dryRun: boolean) => {
    setBusy(dryRun ? 'check' : 'fix');
    try {
      const r: Report = await api('POST', `/access/sync?dryRun=${dryRun ? '1' : '0'}`);
      setReport(r);
      if (!dryRun) {
        alertApi.post({ message: `Access fixed — ${r.actions.length} change(s) applied`, severity: 'success', display: 'transient' });
        status.retry();
      }
    } catch (e: any) { alertApi.post({ message: `Access ${dryRun ? 'check' : 'fix'} failed: ${e.message}`, severity: 'error' }); } finally { setBusy(undefined); }
  };
  const last = status.value?.lastRun;
  const differences = report ? report.actions.length : 0;

  return (
    <Box mt={3} p={2} borderRadius={12} style={{ border: '1px solid rgba(128,128,128,0.25)' }}>
      <Typography variant="subtitle2">Access check · GitHub, ArgoCD, SonarQube (all spaces) — platform admins</Typography>
      <Typography variant="body2" color="textSecondary">
        Nothing to do day to day: adding or removing a member applies that space's access right away, and a full sync runs
        {status.value?.everyMinutes ? ` every ${status.value.everyMinutes} minutes` : ' on a schedule'}. Use this to audit or repair.
      </Typography>

      <Box mt={1}>
        {status.loading && <BusyBar busy hint="Loading the last automatic sync…" />}
        {!status.loading && (last ? (
          <Typography variant="body2">
            Last sync <b>{ago(last.at)}</b> ({last.trigger}) — {last.actions.length === 0 && last.warnings.length === 0
              ? <span style={{ color: STATUS.good }}>everything matched</span>
              : <>{last.actions.length} change(s) applied{last.warnings.length ? <span style={{ color: STATUS.warning }}>, {last.warnings.length} warning(s)</span> : ''}</>}
          </Typography>
        ) : (
          <Typography variant="body2" color="textSecondary">No sync since Backstage started.</Typography>
        ))}
      </Box>

      <Box mt={1.5} display="flex" style={{ gap: 8 }}>
        <BusyButton size="small" variant="outlined" busy={busy === 'check'} busyLabel="Checking…" disabled={!!busy} onClick={() => run(true)}>
          Check now
        </BusyButton>
        {report?.dryRun && differences > 0 && (
          <BusyButton size="small" variant="contained" color="primary" disableElevation busy={busy === 'fix'} busyLabel="Fixing…" disabled={!!busy} onClick={() => run(false)}>
            Fix {differences} difference{differences > 1 ? 's' : ''}
          </BusyButton>
        )}
      </Box>
      <Box mt={1}><BusyBar busy={!!busy} hint={busy === 'fix' ? 'Applying changes in GitHub, ArgoCD and SonarQube…' : 'Comparing Backstage with GitHub, ArgoCD and SonarQube… (~30 s)'} /></Box>

      {report && !busy && (
        <Box mt={1}>
          <Typography variant="body2" style={{ fontWeight: 600 }}>{summary(report)}</Typography>
          <Grouped report={report} />
        </Box>
      )}
    </Box>
  );
};
