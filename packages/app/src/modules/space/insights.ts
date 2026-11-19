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

/** The CI repo behind a card: the Component itself, or "<repo>" for its CD Resource "<repo>-gitops". */
export const insightsTarget = (e: Entity) => ({
  repo: e.metadata.name.replace(/-gitops$/, ''),
  project: String(e.spec?.system ?? ''),
});

/** Pipeline data URL of an app (SonarQube key from its annotation; '0' = SonarQube switched off). */
export const pipelinePath = (e: Entity) =>
  `/pipeline/${encodeURIComponent(insightsTarget(e).repo)}?sonar=${encodeURIComponent(e.metadata.annotations?.['sonarqube.org/project-key'] ?? '0')}`;

export const useInsights = (e: Entity | undefined, enabled = true) => {
  const api = useEveresto(); // human error messages (session expired, GitHub unreachable, …)
  return useAsyncRetry(async (): Promise<Insights | undefined> => {
    if (!e || !enabled) return undefined;
    return api('GET', pipelinePath(e));
  }, [e?.metadata.name, enabled]);
};

export const ago = (iso?: string) => {
  if (!iso) return '—';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

export const fmtDuration = (sec?: number) => {
  if (sec === undefined) return '—';
  return sec < 60 ? `${Math.round(sec)} s` : `${(sec / 60).toFixed(1)} min`;
};

/** The app's namespace per environment: dev-<key> / prod-<key> (key chosen at Create deployment; older: the space). */
export const nsOf = (e: Entity, env: 'dev' | 'prod') =>
  `${env}-${e.metadata.annotations?.['everesto.live/namespace'] ?? String(e.spec?.system ?? '')}`;
