import { useState } from 'react';
import { alertApiRef, useApi } from '@backstage/core-plugin-api';
import {
  Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Link,
  MenuItem, Radio, RadioGroup, TextField, Typography,
} from '@material-ui/core';
import useAsync from 'react-use/esm/useAsync';
import { useEveresto } from './api';
import { BusyBar, BusyButton, SLOW_HINT } from './Busy';
import { STATUS } from '../tools/charts';

/**
 * Import repository — bring an EXISTING repo of the org into this space, on Loop v1.1.
 * Backend: GET /spaces/:space/importable · POST /spaces/:space/import → opens a pull request in the repo
 * (nothing changes until it is merged), registers the repo with the space, SonarQube, team access.
 */
type Repo = { name: string; private: boolean; description: string; language: string; defaultBranch: string };
type Result = { done: string[]; warn: string[]; prUrl: string };
const STACK_OF: Record<string, string> = { Python: 'python', Java: 'java' };

export const ImportRepoDialog = ({ project, open, onClose }: { project: string; open: boolean; onClose: () => void }) => {
  const api = useEveresto();
  const alertApi = useApi(alertApiRef);
  const repos = useAsync(async (): Promise<Repo[]> => (open ? (await api('GET', `/spaces/${project}/importable`)).repos : []), [open, project]);
  const [repo, setRepo] = useState('');
  const [stack, setStack] = useState('python');
  const [tests, setTests] = useState(true);
  const [semgrep, setSemgrep] = useState(false);
  const [sonarqube, setSonarqube] = useState(true);
  const [dependabot, setDependabot] = useState(true);
  const [trivy, setTrivy] = useState<'enforce' | 'report'>('enforce');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | undefined>();

  const pick = (name: string) => {
    setRepo(name);
    const lang = repos.value?.find(r => r.name === name)?.language ?? '';
    setStack(STACK_OF[lang] ?? 'docker');
  };
  const close = () => { setRepo(''); setResult(undefined); setTrivy('enforce'); onClose(); };
  const submit = async () => {
    setBusy(true);
    try {
      setResult(await api('POST', `/spaces/${project}/import`, { repo, stack, tests, semgrep, sonarqube, dependabot, trivy }));
    } catch (e: any) {
      alertApi.post({ message: `Import failed: ${e.message}`, severity: 'error' });
    } finally { setBusy(false); }
  };
  const access = result?.done.filter(d => d.startsWith('access: ')).map(d => d.slice(8)) ?? [];
  const steps = result?.done.filter(d => !d.startsWith('access: ')) ?? [];

  return (
    <Dialog open={open} onClose={busy ? undefined : close} maxWidth="sm" fullWidth>
      <DialogTitle>{result ? `Pull request opened · ${repo}` : `Import repository into ${project}`}</DialogTitle>
      <DialogContent>
        <BusyBar busy={busy} hint={`${SLOW_HINT} (SonarQube, pull request, registration, team access)`} />
        {result ? (
          <>
            <Typography variant="body1" paragraph>
              <b>Next:</b> review and merge the pull request — nothing changes in <code>{repo}</code> before that.{' '}
              <Link href={result.prUrl} target="_blank" rel="noopener">Open the pull request →</Link>
            </Typography>
            <Typography variant="subtitle2">✓ Done</Typography>
            <Box component="ul" pl={3} m={0} style={{ lineHeight: 1.8 }}>{steps.map(d => <li key={d}>{d}</li>)}</Box>
            {access.length > 0 && (
              <>
                <Typography variant="subtitle2" style={{ marginTop: 8 }}>Access applied (GitHub teams, main protection)</Typography>
                <Box component="ul" pl={3} m={0} style={{ lineHeight: 1.8 }}>{access.map(d => <li key={d}>{d}</li>)}</Box>
              </>
            )}
            {result.warn.map(w => <Typography key={w} variant="body2" style={{ color: STATUS.warning, marginTop: 4 }}>⚠ {w}</Typography>)}
            <Typography variant="body2" color="textSecondary" style={{ marginTop: 12 }}>
              After the merge: the app appears in {project} within a few minutes, CI publishes the image, then use <b>Create deployment</b>.
            </Typography>
          </>
        ) : (
          <>
            <Typography variant="body2" color="textSecondary" paragraph>
              For a repository that already exists in Everesto-Inc (e.g. transferred from a personal account). Backstage opens a
              <b> pull request</b> that replaces its CI with Loop — you review and merge it. Every run then ends with a scanned image in ghcr.io.
            </Typography>
            {repos.loading && <BusyBar busy hint="Loading the organisation's repositories…" />}
            {repos.error && <Typography style={{ color: STATUS.critical }}>{repos.error.message}</Typography>}
            {repos.value && (
              <TextField select fullWidth variant="outlined" size="small" label="Repository" value={repo} onChange={e => pick(e.target.value)}
                helperText={repos.value.length ? 'Repositories that are in no space yet' : 'No repository to import — every repo is already in a space'}>
                {repos.value.map(r => (
                  <MenuItem key={r.name} value={r.name}>
                    {r.name}{r.language ? ` · ${r.language}` : ''}{r.private ? ' · private' : ''}{r.description ? ` — ${r.description.slice(0, 50)}` : ''}
                  </MenuItem>
                ))}
              </TextField>
            )}
            <TextField select fullWidth variant="outlined" size="small" label="Stack" value={stack} onChange={e => setStack(e.target.value)} style={{ marginTop: 16 }}
              helperText="docker = any language: the Dockerfile does the work (Node, Go, …); tests via your own test command later">
              <MenuItem value="python">Python</MenuItem>
              <MenuItem value="java">Java (Maven)</MenuItem>
              <MenuItem value="docker">Docker only</MenuItem>
            </TextField>
            <Box mt={2}>
              <Typography variant="subtitle2">Pipeline switches (change later in Edit pipeline)</Typography>
              <FormControlLabel control={<Checkbox color="primary" checked={tests} onChange={e => setTests(e.target.checked)} />}
                label={<span><b>Tests + coverage</b> <Typography component="span" variant="caption" color="textSecondary">turn off if the repo has no working tests yet</Typography></span>} />
              <FormControlLabel control={<Checkbox color="primary" checked={sonarqube} onChange={e => setSonarqube(e.target.checked)} />}
                label={<span><b>SonarQube</b> <Typography component="span" variant="caption" color="textSecondary">quality gate — creates the project + SONAR_TOKEN</Typography></span>} />
              <FormControlLabel control={<Checkbox color="primary" checked={semgrep} onChange={e => setSemgrep(e.target.checked)} />}
                label={<span><b>Semgrep</b> <Typography component="span" variant="caption" color="textSecondary">code security</Typography></span>} />
              <FormControlLabel control={<Checkbox color="primary" checked={dependabot} onChange={e => setDependabot(e.target.checked)} />}
                label={<span><b>Dependabot</b> <Typography component="span" variant="caption" color="textSecondary">upgrade pull requests</Typography></span>} />
            </Box>
            <Box mt={1}>
              <Typography variant="subtitle2">Trivy (always scans)</Typography>
              <RadioGroup row value={trivy} onChange={e => setTrivy(e.target.value as 'enforce' | 'report')}>
                <FormControlLabel value="enforce" control={<Radio color="primary" />} label="Enforce — vulnerabilities fail the build" />
                <FormControlLabel value="report" control={<Radio color="primary" />} label="Report only" />
              </RadioGroup>
              {trivy === 'report' && <Typography variant="caption" style={{ color: STATUS.warning }}>Report only: findings are shown but never block — the scorecard flags it. Use while fixing an existing backlog.</Typography>}
            </Box>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={busy}>{result ? 'Close' : 'Cancel'}</Button>
        {!result && (
          <BusyButton color="primary" variant="contained" disableElevation busy={busy} busyLabel="Importing…" disabled={!repo} onClick={submit}>
            Import
          </BusyButton>
        )}
      </DialogActions>
    </Dialog>
  );
};
