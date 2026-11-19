import { useState } from 'react';
import { useEveresto } from './api';
import { alertApiRef, identityApiRef, useApi } from '@backstage/core-plugin-api';
import { Box, Button, Typography } from '@material-ui/core';
import useAsync from 'react-use/esm/useAsync';
import { STATUS } from '../tools/charts';

/**
 * Platform-team only: make GitHub match Backstage (teams per space role, org invitations, PR-only main,
 * nobody admin). Preview = dry run (changes nothing); Apply = do it. Backend: POST /api/everesto/access/sync.
 */
type Report = { dryRun: boolean; actions: string[]; warnings: string[] };

export const AccessSyncCard = () => {
  const identityApi = useApi(identityApiRef);
  const alertApi = useApi(alertApiRef);
  const { value: refs = [] } = useAsync(async () => (await identityApi.getBackstageIdentity()).ownershipEntityRefs, []);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<Report | undefined>();
  const api = useEveresto();
  if (!refs.includes('group:default/platform-team')) return null;

  const run = async (dryRun: boolean) => {
    setBusy(true);
    try {
      setReport(await api('POST', `/access/sync?dryRun=${dryRun ? '1' : '0'}`));
    } catch (e: any) { alertApi.post({ message: `Access sync failed: ${e.message}`, severity: 'error' }); } finally { setBusy(false); }
  };

  return (
    <Box mt={3} p={2} borderRadius={12} style={{ border: '1px solid rgba(128,128,128,0.25)' }}>
      <Typography variant="subtitle2">Access sync: GitHub, ArgoCD, SonarQube (all spaces) — platform admins</Typography>
      <Typography variant="body2" color="textSecondary">
        Makes GitHub match the members here: org invitation, team per role (developers: push · maintainers & managers: maintain ·
        nobody admin; owners = team platform-team), main only via pull request on every space repo, and the ArgoCD roles
        per space, and SonarQube: one group per role, the space's projects private and visible only to its members.
        Removing someone here removes them from the team. Runs by itself every 30 minutes.
      </Typography>
      <Box mt={1} display="flex" style={{ gap: 8 }}>
        <Button size="small" variant="outlined" disabled={busy} onClick={() => run(true)}>Preview (changes nothing)</Button>
        <Button size="small" variant="contained" color="primary" disableElevation disabled={busy || !report?.dryRun || report.actions.length === 0} onClick={() => run(false)}>
          Apply
        </Button>
      </Box>
      {report && (
        <Box mt={2}>
          <Typography variant="body2" style={{ fontWeight: 600 }}>
            {report.dryRun ? 'Preview' : 'Applied'} — {report.actions.length} change(s), {report.warnings.length} warning(s)
          </Typography>
          <Box component="ul" pl={3} m={0} style={{ lineHeight: 1.7, fontSize: 14 }}>
            {report.actions.map(a => <li key={a}>{a}</li>)}
            {report.warnings.map(w => <li key={w} style={{ color: STATUS.warning }}>⚠ {w}</li>)}
            {report.actions.length + report.warnings.length === 0 && <li>GitHub already matches Backstage.</li>}
          </Box>
        </Box>
      )}
    </Box>
  );
};
