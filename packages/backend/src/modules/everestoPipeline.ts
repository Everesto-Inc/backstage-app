/**
 * Pipeline data of ONE application for its cards (read-only): last CI runs (GitHub Actions), commits per day,
 * scanner results of the latest main run (Gitleaks / Semgrep / Trivy / SonarQube steps), SonarQube measures,
 * the deployed tag per environment (<repo>-gitops apps/<env>) and its ArgoCD status, code facts, last images.
 * GitHub via the GitHub App, SonarQube via sonarqube.apiKey. Cached by the router (everestoInsights).
 */
import { Config } from '@backstage/config';
import { gh, githubToken } from './everestoActions';
import { readFile } from './everestoManage';
import { kustomizeTag } from './everestoYaml';
import { argoApp } from './everestoK8s';

const OWNER = 'Everesto-Inc';
const DAYS = 14;

type Step = { name: string; conclusion: string | null };
const SCANNERS: Record<string, RegExp> = {
  gitleaks: /gitleaks/i,
  semgrep: /semgrep/i,
  trivyDeps: /vulnerable dependencies/i,
  trivyImage: /scan image/i,
  sonarqube: /quality gate/i,
  tests: /tests/i,
};

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const lastDays = () =>
  Array.from({ length: DAYS }, (_, i) => dayKey(new Date(Date.now() - (DAYS - 1 - i) * 864e5)));

async function sonarMeasures(config: Config, key: string) {
  const baseUrl = config.getOptionalString('sonarqube.baseUrl');
  const apiKey = config.getOptionalString('sonarqube.apiKey');
  if (!baseUrl || !apiKey) return undefined;
  const auth = `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
  const get = (path: string) => fetch(`${baseUrl}${path}`, { headers: { authorization: auth } });
  const metrics = 'alert_status,coverage,new_coverage,bugs,vulnerabilities,code_smells,security_hotspots,new_violations,ncloc';
  const res = await get(`/api/measures/component?component=${encodeURIComponent(key)}&metricKeys=${metrics}`);
  if (res.status === 404) return { exists: false };
  if (!res.ok) return { exists: true, error: `SonarQube HTTP ${res.status}` };
  const json: any = await res.json();
  const m: Record<string, string> = {};
  for (const x of json.component?.measures ?? []) m[x.metric] = x.value ?? x.period?.value;
  const analyses: any = await (await get(`/api/project_analyses/search?project=${encodeURIComponent(key)}&ps=1`)).json().catch(() => ({}));
  return {
    exists: true,
    analysed: Boolean(analyses.analyses?.length),
    lastAnalysis: analyses.analyses?.[0]?.date,
    gate: m.alert_status, // OK | ERROR | undefined
    coverage: m.coverage !== undefined ? Number(m.coverage) : undefined,
    newCoverage: m.new_coverage !== undefined ? Number(m.new_coverage) : undefined,
    bugs: m.bugs !== undefined ? Number(m.bugs) : undefined,
    vulnerabilities: m.vulnerabilities !== undefined ? Number(m.vulnerabilities) : undefined,
    codeSmells: m.code_smells !== undefined ? Number(m.code_smells) : undefined,
    hotspots: m.security_hotspots !== undefined ? Number(m.security_hotspots) : undefined,
    newIssues: m.new_violations !== undefined ? Number(m.new_violations) : undefined,
    url: `${baseUrl}/dashboard?id=${encodeURIComponent(key)}`,
  };
}

/** Pure: why GitHub did not answer for a repo, in words a developer can act on (undefined = fine). */
export function githubProblem(status: number, repo: string): string | undefined {
  if (status >= 200 && status < 300) return undefined;
  if (status === 404) return `Repository ${OWNER}/${repo} not found — deleted or renamed on GitHub? If it is gone, Edit → Delete application removes this card.`;
  if (status === 401) return 'Backstage cannot sign in to GitHub (GitHub App) — tell the platform team.';
  if (status === 403 || status === 429) return 'GitHub refused for now (rate limit or missing permission of the Backstage GitHub App) — try again in a few minutes; if it stays, tell the platform team.';
  if (status >= 500) return 'GitHub is having problems right now — try again in a few minutes.';
  return `GitHub answered HTTP ${status} — try again; if it stays, tell the platform team.`;
}

export async function pipelineInsights(config: Config, repo: string, sonarKey?: string) {
  const token = await githubToken(config, OWNER);
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();

  // the repo first: its REAL default branch (Everesto convention is `main`, imported repos may differ)
  const repoRes = await gh(token, 'GET', `/repos/${OWNER}/${repo}`);
  const problem = githubProblem(repoRes.status, repo);
  if (problem) return { exists: false, problem };
  const branch = String(repoRes.json?.default_branch ?? 'main');
  const [runsRes, commitsRes, prsRes, langRes] = await Promise.all([
    gh(token, 'GET', `/repos/${OWNER}/${repo}/actions/runs?per_page=30`),
    gh(token, 'GET', `/repos/${OWNER}/${repo}/commits?sha=${encodeURIComponent(branch)}&since=${since}&per_page=100`),
    gh(token, 'GET', `/repos/${OWNER}/${repo}/pulls?state=open&per_page=50`),
    gh(token, 'GET', `/repos/${OWNER}/${repo}/languages`),
  ]);
  // GitHub answers an error OBJECT (not a list) e.g. for an empty repo or unknown branch — never crash on it
  const list = (r: { json?: unknown }) => (Array.isArray(r.json) ? (r.json as any[]) : []);
  const langTotal = Object.values((langRes.json ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0) || 1;
  const code = repoRes.ok ? {
    visibility: repoRes.json.visibility as string,
    defaultBranch: branch,
    pushedAt: repoRes.json.pushed_at as string,
    openPulls: list(prsRes).map(p => ({ number: p.number, title: p.title, author: p.user?.login, createdAt: p.created_at, url: p.html_url, draft: p.draft })),
    languages: Object.entries((langRes.json ?? {}) as Record<string, number>).map(([name, bytes]) => ({ name, pct: Math.round((bytes / langTotal) * 100) })),
    lastCommits: list(commitsRes).slice(0, 8).map(c => ({
      sha: String(c.sha).slice(0, 7), message: String(c.commit?.message ?? '').split('\n')[0], author: c.author?.login ?? c.commit?.author?.name, at: c.commit?.committer?.date, url: c.html_url,
    })),
  } : undefined;
  if (runsRes.status === 404) return { exists: false };

  const runs = ((runsRes.json?.workflow_runs ?? []) as any[])
    .filter(r => r.name === 'CI')
    .map(r => ({
      id: r.id,
      number: r.run_number,
      sha: String(r.head_sha).slice(0, 7),
      branch: r.head_branch,
      event: r.event,
      actor: r.actor?.login,
      title: r.display_title,
      status: r.status,
      conclusion: r.conclusion,
      createdAt: r.created_at,
      durationSec: r.updated_at ? Math.max(0, (Date.parse(r.updated_at) - Date.parse(r.run_started_at ?? r.created_at)) / 1000) : undefined,
      url: r.html_url,
    }));

  // scanner results = step conclusions of the latest completed run on main
  const lastMain = ((runsRes.json?.workflow_runs ?? []) as any[]).find(
    r => r.name === 'CI' && r.head_branch === branch && r.status === 'completed',
  );
  const scanners: Record<string, string | null> = {};
  let failedStep: string | undefined;
  if (lastMain) {
    const jobs = await gh(token, 'GET', `/repos/${OWNER}/${repo}/actions/runs/${lastMain.id}/jobs`);
    // all jobs: Loop guard job (Gitleaks, Trivy deps) + ci job (tests, Semgrep, Sonar, image)
    const steps: Step[] = ((jobs.json?.jobs ?? []) as any[]).flatMap(j => j.steps ?? []);
    for (const [k, re] of Object.entries(SCANNERS)) {
      const st = steps.find(s => re.test(s.name));
      if (st) scanners[k] = st.conclusion; // success | failure | skipped | null(not reached)
    }
    failedStep = steps.find(s => s.conclusion === 'failure')?.name;
  }

  const perDay: Record<string, number> = Object.fromEntries(lastDays().map(d => [d, 0]));
  for (const c of list(commitsRes)) {
    const d = dayKey(new Date(c.commit?.committer?.date ?? c.commit?.author?.date));
    if (d in perDay) perDay[d] += 1;
  }

  // CD: <repo>-gitops — tag + last change per environment
  const envs: Record<string, { tag?: string; at?: string; message?: string; url?: string }> = {};
  const gitops = `${repo}-gitops`;
  for (const env of ['dev', 'prod']) {
    const k = await readFile(token, gitops, `apps/${env}/kustomization.yaml`);
    if (!k) continue;
    const dep = await gh(token, 'GET', `/repos/${OWNER}/${gitops}/commits?path=apps/${env}&per_page=1`);
    const c = dep.json?.[0];
    envs[env] = { tag: kustomizeTag(k), at: c?.commit?.committer?.date, message: c?.commit?.message?.split('\n')[0], url: c?.html_url };
  }
  // live ArgoCD status (read-only cluster access) — undefined outside the cluster or without RBAC
  const argo: Record<string, unknown> = {};
  for (const env of Object.keys(envs)) argo[env] = await argoApp(`${env}-${repo}`);
  const lastDeploy = envs.dev?.at ? { at: envs.dev.at, message: envs.dev.message ?? '', url: envs.dev.url ?? '' } : undefined;

  return {
    exists: true,
    repoUrl: `https://github.com/${OWNER}/${repo}`,
    runs,
    lastMainRun: runs.find(r => r.id === lastMain?.id),
    failedStep,
    scanners,
    commitsPerDay: lastDays().map(d => ({ day: d, count: perDay[d] })),
    // no sonar key: SonarQube switched off for this app → never show (old) measures
    sonar: sonarKey ? await sonarMeasures(config, sonarKey).catch(e => ({ exists: true, error: String(e) })) : { exists: false },
    lastDeploy,
    envs: Object.keys(envs).length ? envs : undefined,
    argo: Object.keys(argo).length ? argo : undefined,
    code,
    images: runs.filter(r => r.branch === 'main' && r.conclusion === 'success' && r.event !== 'pull_request').slice(0, 5)
      .map(r => ({ tag: `sha-${r.sha}`, at: r.createdAt, title: r.title, url: r.url })),
    gitopsRepo: Object.keys(envs).length ? `https://github.com/${OWNER}/${gitops}` : undefined,
  };
}

