import { discoveryApiRef, fetchApiRef, useApi } from '@backstage/core-plugin-api';
import { Entity } from '@backstage/catalog-model';
import useAsync from 'react-use/esm/useAsync';

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
};

/** repo = Component name; for a gitops Resource "<repo>-gitops" → deploy info from <project>-gitops-cd/<app>/. */
export const insightsTarget = (e: Entity) => {
  const project = String(e.spec?.system ?? '');
  const repo = e.metadata.name.replace(/-gitops$/, '');
  const app = project && repo.startsWith(`${project}-`) ? repo.slice(project.length + 1) : repo;
  return { repo, project, app };
};

export const useInsights = (e: Entity | undefined, enabled = true) => {
  const discovery = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  return useAsync(async (): Promise<Insights | undefined> => {
    if (!e || !enabled) return undefined;
    const { repo, project, app } = insightsTarget(e);
    const base = await discovery.getBaseUrl('everesto');
    const res = await fetchApi.fetch(`${base}/pipeline/${encodeURIComponent(repo)}?project=${encodeURIComponent(project)}&app=${encodeURIComponent(app)}`);
    if (!res.ok) throw new Error(`insights HTTP ${res.status}`);
    return res.json();
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
