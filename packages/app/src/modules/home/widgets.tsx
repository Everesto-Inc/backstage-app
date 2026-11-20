import { ReactElement } from 'react';
import { identityApiRef, useApi } from '@backstage/core-plugin-api';
import { Link, Progress } from '@backstage/core-components';
import { compatWrapper } from '@backstage/core-compat-api';
import { AnnouncementsCard } from '@backstage-community/plugin-announcements';
import { HomePageLayoutProps } from '@backstage/plugin-home-react/alpha';
import { Box, Chip, Grid, Typography } from '@material-ui/core';
import useAsync from 'react-use/esm/useAsync';
import { useEveresto } from '../space/api';
import { STATUS } from '../tools/charts';

/** Home page widgets + layout (lazy-loaded by homeModule). */

type Space = { space: string; title: string; entity: string; roles: string[]; apps: number; silverPlus: number; failingCi: number; toFix: number };
type Pr = { repo: string; number: number; title: string; url: string; author: string; updatedAt: string; draft: boolean };

const ROLE: Record<string, string> = { owner: 'Owner', managers: 'Manager', maintainers: 'Maintainer', developers: 'Developer', viewers: 'Viewer' };
const ago = (iso: string) => {
  const d = Math.floor((Date.now() - Date.parse(iso)) / 864e5);
  if (d > 0) return `${d} d ago`;
  const h = Math.floor((Date.now() - Date.parse(iso)) / 36e5);
  return h > 0 ? `${h} h ago` : 'just now';
};
const Muted = ({ children }: { children: React.ReactNode }) => <Typography variant="body2" color="textSecondary">{children}</Typography>;

export const MySpaces = () => {
  const api = useEveresto();
  const { value, loading, error } = useAsync(async (): Promise<{ owner: boolean; spaces: Space[] }> => api('GET', '/me/spaces'), []);
  if (loading) return <Progress />;
  if (error) return <Typography variant="body2" style={{ color: STATUS.critical }}>{error.message}</Typography>;
  const spaces = value?.spaces ?? [];
  if (!spaces.length) return <Muted>You are not in a DevOps Space yet — ask a manager of your team to add you (Members).</Muted>;
  return (
    <Box>
      {spaces.map(s => (
        <Box key={s.space} display="flex" alignItems="center" py={1} style={{ gap: 12, borderBottom: '1px solid rgba(128,128,128,0.15)', flexWrap: 'wrap' }}>
          <Box minWidth={180}>
            <Link to={`/catalog/default/system/${s.space}`} style={{ fontWeight: 700 }}>{s.title}</Link>
            <Typography variant="caption" color="textSecondary" component="div">entity {s.entity}</Typography>
          </Box>
          <Box display="flex" style={{ gap: 4, flexWrap: 'wrap' }}>
            {s.roles.map(r => <Chip key={r} size="small" label={ROLE[r] ?? r} />)}
          </Box>
          <Box ml="auto" textAlign="right">
            <Typography variant="body2">
              {s.apps} app{s.apps === 1 ? '' : 's'} · <Link to={`/catalog/default/system/${s.space}/scorecards`}>{s.silverPlus} at Silver+</Link>
            </Typography>
            {(s.failingCi > 0 || s.toFix > 0) && (
              <Typography variant="caption" style={{ color: s.failingCi ? STATUS.critical : STATUS.warning }}>
                {s.failingCi ? `${s.failingCi} CI failing · ` : ''}{s.toFix} check{s.toFix === 1 ? '' : 's'} to fix
              </Typography>
            )}
          </Box>
        </Box>
      ))}
    </Box>
  );
};

const PrList = ({ items, empty, showAuthor }: { items: Pr[]; empty: string; showAuthor?: boolean }) => (
  items.length === 0 ? <Muted>{empty}</Muted> : (
    <Box>
      {items.map(p => (
        <Box key={p.url} py={0.75} style={{ borderBottom: '1px solid rgba(128,128,128,0.12)' }}>
          <Link to={p.url} target="_blank" rel="noopener">{p.title}</Link>{p.draft && <Chip size="small" label="draft" style={{ marginLeft: 6 }} />}
          <Typography variant="caption" color="textSecondary" component="div">
            {p.repo} #{p.number}{showAuthor ? ` · by ${p.author}` : ''} · updated {ago(p.updatedAt)}
          </Typography>
        </Box>
      ))}
    </Box>
  )
);

export const PullRequests = () => {
  const api = useEveresto();
  const { value, loading, error } = useAsync(async (): Promise<{ toReview: Pr[]; mine: Pr[] }> => api('GET', '/me/pull-requests'), []);
  if (loading) return <Progress />;
  if (error) return <Typography variant="body2" style={{ color: STATUS.critical }}>{error.message}</Typography>;
  return (
    <Box>
      <Typography variant="subtitle2">Waiting for your review ({value?.toReview.length ?? 0})</Typography>
      <PrList items={value?.toReview ?? []} empty="Nothing to review — main needs an approval from someone else, so reviews keep your team moving." showAuthor />
      <Box mt={2}><Typography variant="subtitle2">Your open pull requests ({value?.mine.length ?? 0})</Typography></Box>
      <PrList items={value?.mine ?? []} empty="No open pull requests." />
    </Box>
  );
};

const TOOLS = [
  { label: 'ArgoCD', url: 'https://argocd.everesto.live', hint: 'deployments, Sync' },
  { label: 'SonarQube', url: 'https://sonar.everesto.live', hint: 'code quality of your apps' },
  { label: 'Infisical', url: 'https://infisical.everesto.live', hint: 'secrets (use the Secrets tab first)' },
  { label: 'GitHub · Everesto-Inc', url: 'https://github.com/Everesto-Inc', hint: 'code, pull requests' },
  { label: 'Tech Radar', url: '/tech-radar', hint: 'what the platform supports' },
  { label: 'Announcements', url: '/announcements', hint: 'all platform news' },
];

export const PlatformTools = () => (
  <Box>
    {TOOLS.map(t => (
      <Box key={t.label} py={0.75} display="flex" alignItems="baseline" style={{ gap: 8 }}>
        <Link to={t.url} {...(t.url.startsWith('http') ? { target: '_blank', rel: 'noopener' } : {})} style={{ fontWeight: 600 }}>{t.label}</Link>
        <Typography variant="caption" color="textSecondary">{t.hint}</Typography>
      </Box>
    ))}
  </Box>
);

const greeting = () => {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  return h < 18 ? 'Good afternoon' : 'Good evening';
};

export const HomeLayout = ({ widgets }: HomePageLayoutProps) => {
  const identityApi = useApi(identityApiRef);
  const { value: profile } = useAsync(() => identityApi.getProfileInfo(), []);
  const by = (name: string): ReactElement | null => widgets.find(w => w.name === name)?.component ?? null;
  const cell = (el: ReactElement | null, md: 5 | 6 | 7 = 6) => (el ? <Grid item xs={12} md={md}>{el}</Grid> : null);
  return (
    <Box p={3}>
      <Typography variant="h4">{greeting()}{profile?.displayName ? `, ${profile.displayName.split(' ')[0]}` : ''}</Typography>
      <Typography variant="body1" color="textSecondary" style={{ marginBottom: 24 }}>
        everesto.live developer portal — your spaces, reviews and platform news.
      </Typography>
      <Grid container spacing={3}>
        {cell(by('everesto-spaces'), 7)}
        <Grid item xs={12} md={5}>{compatWrapper(<AnnouncementsCard title="Announcements" max={3} />)}</Grid>
        {cell(by('everesto-prs'), 7)}
        {cell(by('everesto-tools'), 5)}
        {cell(by('HomePageRecentlyVisited'))}
        {cell(by('HomePageStarredEntities'))}
      </Grid>
    </Box>
  );
};
