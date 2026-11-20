import { useState } from 'react';
import { Entity } from '@backstage/catalog-model';
import { EntityRefLink, useEntity } from '@backstage/plugin-catalog-react';
import { InfoCard, Progress } from '@backstage/core-components';
import { Box, Button, Tooltip, Typography } from '@material-ui/core';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';
import { STATUS } from '../tools/charts';
import { useEveresto } from './api';

/**
 * Scorecards: measurable standards per application (backend everestoScorecard).
 *   Bronze = safe · Silver = maintained · Gold = exemplary. A level counts when all its checks and those below pass.
 */
type Level = 'bronze' | 'silver' | 'gold';
type State = 'pass' | 'fail' | 'na' | 'unknown';
type Check = { id: string; title: string; level: Level; state: State; detail: string; fix?: string };
type Card = { repo: string; space: string; kind: 'ci' | 'repo'; level: Level | null; checks: Check[]; at: string; error?: string };

const LEVELS: Level[] = ['bronze', 'silver', 'gold'];
const LEVEL_LABEL: Record<Level, string> = { bronze: 'Bronze · safe', silver: 'Silver · maintained', gold: 'Gold · exemplary' };
const LEVEL_COLOR: Record<Level, string> = { bronze: '#b87333', silver: '#8e98a3', gold: '#c99a06' };
const ICON: Record<State, string> = { pass: '✓', fail: '✕', na: '–', unknown: '?' };
const COLOR: Record<State, string> = { pass: STATUS.good, fail: STATUS.critical, na: 'inherit', unknown: STATUS.warning };
const SHORT: Record<string, string> = {
  ci: 'CI', vulns: 'Findings', secrets: 'Secrets', coverage: 'Coverage', deps: 'Deps', docs: 'Docs', loop: 'Loop', fresh: 'Fresh', fourEyes: '4 eyes',
};

export const LevelBadge = ({ level }: { level: Level | null }) => (
  <span style={{
    fontSize: 12, fontWeight: 700, padding: '2px 10px', borderRadius: 999, whiteSpace: 'nowrap',
    color: level ? '#fff' : 'inherit', background: level ? LEVEL_COLOR[level] : 'rgba(128,128,128,0.18)',
  }}>
    {level ? LEVEL_LABEL[level] : 'No level yet'}
  </span>
);

const nextLevel = (c: Card) => LEVELS[c.level ? LEVELS.indexOf(c.level) + 1 : 0];

/** Application page → "Scorecard" card. */
export const ScorecardCard = () => {
  const { entity } = useEntity();
  const api = useEveresto();
  const [fresh, setFresh] = useState(0);
  const data = useAsyncRetry(async (): Promise<Card> =>
    api('GET', `/apps/${encodeURIComponent(entity.metadata.name)}/scorecard${fresh ? '?fresh=1' : ''}`), [entity.metadata.name, fresh]);
  const c = data.value;
  const next = c && nextLevel(c);
  const blocking = c && next ? c.checks.filter(x => LEVELS.indexOf(x.level) <= LEVELS.indexOf(next) && (x.state === 'fail' || x.state === 'unknown')) : [];

  return (
    <InfoCard title="Scorecard" action={<Button size="small" disabled={data.loading} onClick={() => setFresh(f => f + 1)} style={{ margin: 8 }}>Re-check</Button>}>
      {data.loading && !c && <Progress />}
      {data.error && <Typography variant="body2" style={{ color: STATUS.critical }}>{data.error.message}</Typography>}
      {c && (
        <>
          <Box display="flex" alignItems="center" style={{ gap: 12 }} mb={1.5}>
            <LevelBadge level={c.level} />
            <Typography variant="body2" color="textSecondary">
              {next ? `Next: ${LEVEL_LABEL[next].split(' ·')[0]} — ${blocking.length} check${blocking.length === 1 ? '' : 's'} to fix` : 'Top level reached'}
            </Typography>
          </Box>
          {LEVELS.map(l => (
            <Box key={l} mb={1}>
              <Typography variant="caption" style={{ fontWeight: 700, color: LEVEL_COLOR[l], textTransform: 'uppercase', letterSpacing: 0.5 }}>{l}</Typography>
              {c.checks.filter(x => x.level === l).map(x => (
                <Box key={x.id} display="flex" py={0.5} style={{ gap: 10, opacity: x.state === 'na' ? 0.5 : 1 }}>
                  <Box width={18} style={{ color: COLOR[x.state], fontWeight: 700, textAlign: 'center' }}>{ICON[x.state]}</Box>
                  <Box minWidth={0}>
                    <Typography variant="body2" style={{ fontWeight: 600 }}>{x.title}</Typography>
                    <Typography variant="caption" color="textSecondary" component="div">{x.detail}</Typography>
                    {x.fix && <Typography variant="caption" component="div">→ {x.fix}</Typography>}
                  </Box>
                </Box>
              ))}
            </Box>
          ))}
          <Typography variant="caption" color="textSecondary">Checked {new Date(c.at).toLocaleString()} · refreshed every 10 min</Typography>
        </>
      )}
    </InfoCard>
  );
};

/** DevOps Space → "Scorecards" tab: every application × every check. */
export const SpaceScorecards = () => {
  const { entity } = useEntity();
  const api = useEveresto();
  const space = entity.metadata.name;
  const data = useAsyncRetry(async (): Promise<{ apps: Card[] }> => api('GET', `/spaces/${encodeURIComponent(space)}/scorecard`), [space]);
  if (data.loading && !data.value) return <Progress />;
  if (data.error) return <Typography style={{ color: STATUS.critical }}>{data.error.message}</Typography>;
  const apps = data.value?.apps ?? [];
  if (!apps.length) return <Typography color="textSecondary">No applications in this space yet.</Typography>;
  const ids = apps.find(a => a.checks)?.checks.map(x => x.id) ?? [];
  const silverPlus = apps.filter(a => a.level === 'silver' || a.level === 'gold').length;
  const cell = { padding: '8px 10px', borderBottom: '1px solid rgba(128,128,128,0.2)', textAlign: 'center' as const };

  return (
    <Box>
      <Box display="flex" alignItems="center" mb={2} style={{ gap: 16 }}>
        <Typography variant="h6">Scorecards</Typography>
        <Typography variant="body2" color="textSecondary">{silverPlus} of {apps.length} application{apps.length === 1 ? '' : 's'} at Silver or above</Typography>
        <Box ml="auto"><Button size="small" onClick={data.retry}>Refresh</Button></Box>
      </Box>
      <Box style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 14 }}>
          <thead>
            <tr>
              <th style={{ ...cell, textAlign: 'left' }}>Application</th>
              <th style={cell}>Level</th>
              {ids.map(id => <th key={id} style={cell}>{SHORT[id] ?? id}</th>)}
            </tr>
          </thead>
          <tbody>
            {apps.map(a => (
              <tr key={a.repo}>
                <td style={{ ...cell, textAlign: 'left' }}>
                  <EntityRefLink entityRef={{ kind: 'component', namespace: 'default', name: a.repo } as unknown as Entity}>{a.repo}</EntityRefLink>
                </td>
                <td style={cell}>{a.error ? <span style={{ color: STATUS.critical }}>error</span> : <LevelBadge level={a.level} />}</td>
                {ids.map(id => {
                  const x = a.checks?.find(k => k.id === id);
                  if (!x) return <td key={id} style={cell}>{a.error ? '' : '–'}</td>;
                  return (
                    <td key={id} style={cell}>
                      <Tooltip title={`${x.title}: ${x.detail}${x.fix ? ` → ${x.fix}` : ''}`}>
                        <span style={{ color: COLOR[x.state], fontWeight: 700, cursor: 'default', opacity: x.state === 'na' ? 0.5 : 1 }}>{ICON[x.state]}</span>
                      </Tooltip>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </Box>
      <Typography variant="caption" color="textSecondary" component="div" style={{ marginTop: 8 }}>
        ✓ passes · ✕ to fix (hover for how) · ? no data yet · – not relevant. Bronze = CI green, no critical findings, secrets set ·
        Silver = + coverage, dependencies, docs · Gold = + latest Loop, fresh deployment, four eyes.
      </Typography>
    </Box>
  );
};
