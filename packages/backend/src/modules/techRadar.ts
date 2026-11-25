/**
 * Tech Radar data (backend for @backstage-community/plugin-tech-radar: GET /api/tech-radar/data).
 *
 * What the everesto.live golden paths support. Source: everesto-catalog/platform/tech-radar.yaml when it exists
 * (edit there, no rebuild — platform team), otherwise the default below. Cached 5 minutes.
 *   rings:  adopt = golden path · trial = works, use with care · assess = being evaluated · hold = don't start new work
 */
import { coreServices, createBackendPlugin } from '@backstage/backend-plugin-api';
import Router from 'express-promise-router';
import { parseDocument } from 'yaml';
import { githubToken } from './everestoActions';
import { readFile } from './everestoManage';

type Ring = 'adopt' | 'trial' | 'assess' | 'hold';
type Quadrant = 'languages' | 'platform' | 'tools' | 'practices';
type Entry = { id: string; title: string; quadrant: Quadrant; ring: Ring; description: string; url?: string; since?: string };

export const DEFAULT_ENTRIES: Entry[] = [
  // languages & frameworks
  { id: 'python', title: 'Python 3 + FastAPI', quadrant: 'languages', ring: 'adopt', description: 'Golden path: Create pipeline → Python. Skeleton with tests, Dockerfile, /health.' },
  { id: 'java', title: 'Java 21 + Spring Boot', quadrant: 'languages', ring: 'trial', description: 'Template available (Create pipeline → Java); fewer apps run it so far.' },
  { id: 'react', title: 'React 19 + Vite (web apps)', quadrant: 'languages', ring: 'trial', description: 'Create pipeline → React: TypeScript, Tailwind, TanStack Query, board design system, served by nginx. First app: agency-frontend.' },
  { id: 'typescript', title: 'TypeScript / React', quadrant: 'languages', ring: 'assess', description: 'No template yet — Backstage itself is TypeScript.' },
  { id: 'go', title: 'Go', quadrant: 'languages', ring: 'assess', description: 'Candidate for small services / CLIs; no template yet.' },
  // platform & infrastructure
  { id: 'k3s', title: 'K3s on OCI (ARM, linux/arm64)', quadrant: 'platform', ring: 'adopt', description: 'Where apps run. Images must be linux/arm64 (or multi-arch).' },
  { id: 'argocd', title: 'ArgoCD (GitOps, manual sync)', quadrant: 'platform', ring: 'adopt', description: 'Every deployment comes from <app>-gitops; syncs are manual on purpose.' },
  { id: 'infisical', title: 'Infisical + External Secrets', quadrant: 'platform', ring: 'adopt', description: 'Secrets live in Infisical; ESO puts them into the namespace. Never in git.' },
  { id: 'kustomize', title: 'Kustomize', quadrant: 'platform', ring: 'adopt', description: 'apps/dev, apps/prod in <app>-gitops.' },
  { id: 'helm', title: 'Helm charts for apps', quadrant: 'platform', ring: 'assess', description: 'Platform uses Helm; app deployments use Kustomize for now.' },
  { id: 'cronjob', title: 'Kubernetes CronJobs', quadrant: 'platform', ring: 'assess', description: 'Scheduled jobs — template being designed.' },
  { id: 'crosscloud-db', title: 'Database on another cloud', quadrant: 'platform', ring: 'hold', description: '~95 ms per query from Oracle → GCP. Prefer a database next to the app.' },
  { id: 'ansible-apps', title: 'Ansible / AWX for app deployments', quadrant: 'platform', ring: 'hold', description: 'Platform VMs only. Apps deploy with ArgoCD.' },
  // tools
  { id: 'loop', title: 'GitHub Actions + Loop stages', quadrant: 'tools', ring: 'adopt', description: 'Shared, pinned CI stages (Everesto-Inc/loop). Dependabot keeps them current.' },
  { id: 'trivy', title: 'Trivy', quadrant: 'tools', ring: 'adopt', description: 'Image + dependency scan in every build; blocks critical/high with a fix.' },
  { id: 'gitleaks', title: 'Gitleaks', quadrant: 'tools', ring: 'adopt', description: 'Secrets in code block the build.' },
  { id: 'sonarqube', title: 'SonarQube', quadrant: 'tools', ring: 'adopt', description: 'Quality gate + coverage; projects private per DevOps Space.' },
  { id: 'dependabot', title: 'Dependabot', quadrant: 'tools', ring: 'adopt', description: 'Weekly dependency PRs (cooldown 7 days).' },
  { id: 'semgrep', title: 'Semgrep', quadrant: 'tools', ring: 'trial', description: 'Code security scan — switch on per app (Edit pipeline).' },
  { id: 'grafana', title: 'Grafana / Prometheus / Loki', quadrant: 'tools', ring: 'assess', description: 'Platform monitoring; per-app dashboards and tenant isolation being designed.' },
  // practices
  { id: 'four-eyes', title: 'Pull requests with 1 approval', quadrant: 'practices', ring: 'adopt', description: 'main is PR-only; CI changes need a maintainer, prod a manager (CODEOWNERS).' },
  { id: 'promote-pr', title: 'Promote to prod by pull request', quadrant: 'practices', ring: 'adopt', description: 'prod tag := dev tag in a PR, approved by a manager.' },
  { id: 'scorecards', title: 'Scorecards (Bronze / Silver / Gold)', quadrant: 'practices', ring: 'adopt', description: 'Measurable standards per app — aim for Silver.' },
  { id: 'kubectl-apply', title: 'kubectl apply for apps', quadrant: 'practices', ring: 'hold', description: 'Everything goes through git + ArgoCD.' },
  { id: 'secrets-in-git', title: 'Secrets in repos or CI files', quadrant: 'practices', ring: 'hold', description: 'Use Infisical (Secrets tab). Gitleaks blocks them anyway.' },
];

const RINGS = [
  { id: 'adopt', name: 'ADOPT', color: '#5BA300', description: 'Golden path — supported by templates and the platform team.' },
  { id: 'trial', name: 'TRIAL', color: '#009EB0', description: 'Works and is supported; fewer apps use it so far.' },
  { id: 'assess', name: 'ASSESS', color: '#C7BA00', description: 'Being evaluated — talk to the platform team first.' },
  { id: 'hold', name: 'HOLD', color: '#E09B96', description: "Don't start new work with it." },
];
const QUADRANTS = [
  { id: 'languages', name: 'Languages & frameworks' },
  { id: 'platform', name: 'Platform & infrastructure' },
  { id: 'tools', name: 'Tools' },
  { id: 'practices', name: 'Practices' },
];

/** Pure: entries → the response the Tech Radar plugin expects. */
export function radarResponse(entries: Entry[]) {
  return {
    rings: RINGS,
    quadrants: QUADRANTS,
    entries: entries.map(e => ({
      id: e.id, key: e.id, title: e.title, quadrant: e.quadrant, description: e.description,
      links: e.url ? [{ url: e.url, title: 'More' }] : [],
      timeline: [{ moved: 0, ringId: e.ring, date: e.since ?? '2026-11-20', description: e.description }],
    })),
  };
}

/** Pure: entries from tech-radar.yaml (`entries: [{ id, title, quadrant, ring, description }]`); invalid ones skipped. */
export function parseEntries(text: string | undefined): Entry[] | undefined {
  if (!text) return undefined;
  const list = (parseDocument(text).toJS()?.entries ?? []) as any[];
  const ok = list.filter(e => e?.id && e?.title && QUADRANTS.some(q => q.id === e.quadrant) && RINGS.some(r => r.id === e.ring));
  return ok.length ? ok.map(e => ({ id: String(e.id), title: String(e.title), quadrant: e.quadrant, ring: e.ring, description: String(e.description ?? ''), url: e.url, since: e.since })) : undefined;
}

export const techRadarPlugin = createBackendPlugin({
  pluginId: 'tech-radar',
  register(env) {
    env.registerInit({
      deps: { http: coreServices.httpRouter, config: coreServices.rootConfig, logger: coreServices.logger },
      async init({ http, config, logger }) {
        let cache: { at: number; data: unknown } | undefined;
        const router = Router();
        router.get('/data', async (_req, res) => {
          if (!cache || Date.now() - cache.at > 5 * 60_000) {
            let entries = DEFAULT_ENTRIES;
            try {
              entries = parseEntries(await readFile(await githubToken(config, 'Everesto-Inc'), 'everesto-catalog', 'platform/tech-radar.yaml')) ?? DEFAULT_ENTRIES;
            } catch (e) { logger.warn(`tech radar: using defaults (${e})`); }
            cache = { at: Date.now(), data: radarResponse(entries) };
          }
          res.json(cache.data);
        });
        http.use(router);
      },
    });
  },
});
