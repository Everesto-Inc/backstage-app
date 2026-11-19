import { useEveresto } from './api';
import { Entity } from '@backstage/catalog-model';
import useAsyncRetry from 'react-use/esm/useAsyncRetry';

/** Real pipeline data from the backend (packages/backend/src/modules/everestoInsights.ts). */
export type StepResult = 'success' | 'failure' | 'skipped' | 'cancelled' | null | undefined;

export type Run = {
  id: number;
  number: number;
  sha: string;
  branch: string;
  event: string;
  actor: string;
  title: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  durationSec?: number;
  url: string;
};

export type Insights = {
  exists: boolean;
  problem?: string; // GitHub could not answer for this repo (not found, no access, rate limit…) — plain words
  repoUrl?: string;
  runs?: Run[];
  lastMainRun?: Run;
  failedStep?: string;
  scanners?: Partial<Record<'gitleaks' | 'semgrep' | 'trivyDeps' | 'trivyImage' | 'sonarqube' | 'tests', StepResult>>;
  commitsPerDay?: { day: string; count: number }[];
  sonar?: {
    exists: boolean;
    analysed?: boolean;
    lastAnalysis?: string;
    gate?: string;
    coverage?: number;
    newCoverage?: number;
    bugs?: number;
    vulnerabilities?: number;
    codeSmells?: number;
    hotspots?: number;
    newIssues?: number;
    url?: string;
    error?: string;
  };
  lastDeploy?: { at: string; message: string; url: string };
  envs?: Partial<Record<"dev" | "prod", { tag?: string; at?: string; message?: string; url?: string }>>;
  gitopsRepo?: string;
  argo?: Partial<Record<'dev' | 'prod', {
    exists: boolean; sync?: string; health?: string; revision?: string;
    lastSyncAt?: string; lastSyncPhase?: string; lastSyncMessage?: string; images?: string[];
  } | null>>;
  code?: {
    visibility: string; defaultBranch: string; pushedAt: string;
    openPulls: { number: number; title: string; author: string; createdAt: string; url: string; draft: boolean }[];
    languages: { name: string; pct: number }[];
    lastCommits: { sha: string; message: string; author: string; at: string; url: string }[];
  };
  images?: { tag: string; at: string; title: string; url: string }[];
};

/** repo = Component name; for a gitops Resource "<repo>-gitops" → deploy info from <project>-gitops-cd/<app>/. */
export const insightsTarget = (e: Entity) => {
  const project = String(e.spec?.system ?? '');
  const repo = e.metadata.name.replace(/-gitops$/, '');
  const app = project && repo.startsWith(`${project}-`) ? repo.slice(project.length + 1) : repo;
  return { repo, project, app };
};

export const useInsights = (e: Entity | undefined, enabled = true) => {
  const api = useEveresto(); // human error messages (session expired, GitHub unreachable, …)
  return useAsyncRetry(async (): Promise<Insights | undefined> => {
    if (!e || !enabled) return undefined;
    const { repo, project, app } = insightsTarget(e);
    // SonarQube switched off (annotation absent) → backend skips it, no stale measures
    const sonar = e.metadata.annotations?.['sonarqube.org/project-key'] ?? '0';
    return api('GET', `/pipeline/${encodeURIComponent(repo)}?project=${encodeURIComponent(project)}&app=${encodeURIComponent(app)}&sonar=${encodeURIComponent(sonar)}`);
  }, [e?.metadata.name, enabled]);
};

export const ago = (iso?: string) => {
  if (!iso) return '—';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

export const fmtDuration = (sec?: number) =>
  sec === undefined ? '—' : sec < 60 ? `${Math.round(sec)} s` : `${(sec / 60).toFixed(1)} min`;

/** The app's namespace per environment: dev-<key> / prod-<key> (key chosen at Create deployment; older: the space). */
export const nsOf = (e: Entity, env: 'dev' | 'prod') =>
  `${env}-${e.metadata.annotations?.['everesto.live/namespace'] ?? String(e.spec?.system ?? '')}`;
