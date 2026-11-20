/**
 * Scorecards — measurable standards per application, from data Backstage already has (CI, scanners, SonarQube,
 * Dependabot, Loop, docs, deployments, Infisical, the space's members). Pure scoring here; facts are collected by
 * collectFacts() and cached by the router.
 *
 *   Bronze  safe:          CI green · no critical findings · secrets complete
 *   Silver  maintained:    + test coverage · dependencies kept up to date · docs
 *   Gold    exemplary:     + latest Loop · fresh deployment · four eyes possible
 *
 * A level counts when every check of that level and below passes (n/a = not relevant for this app).
 */
import { Config } from '@backstage/config';
import { gh, githubToken } from './everestoActions';
import { OWNER, readFile } from './everestoManage';
import { pipelineInsights } from './everestoPipeline';
import { secretPlaceholders } from './everestoDeploy';

export type Level = 'bronze' | 'silver' | 'gold';
export type CheckState = 'pass' | 'fail' | 'na' | 'unknown';
export type Check = { id: string; title: string; level: Level; state: CheckState; detail: string; fix?: string };

export type Facts = {
  kind: 'ci' | 'repo';                       // repo = repository only (no CI, no image)
  lastMainRun?: 'success' | 'failure' | 'running' | 'none';
  scanners: Record<string, string>;          // gitleaks / semgrep / trivyDeps / trivyImage → success | failure | …
  sonar?: { exists: boolean; analysed?: boolean; coverage?: number };
  dependabot: boolean;
  dependabotPrAges: number[];                // days open, Dependabot PRs only
  loopUsed?: string;                         // e.g. v1.0.0 (undefined = pipeline not on Loop)
  loopLatest?: string;
  docs: boolean;
  deployed: boolean;
  dev?: { tag?: string; ageDays?: number };
  prod?: { tag?: string; ageDays?: number };
  placeholders?: { dev?: number; prod?: number }; // secrets still CHANGE_ME (undefined = unknown)
  reviewers: number;                         // people who can review in the space (developers+)
};

export const COVERAGE_MIN = 60;
export const DEP_PR_MAX_DAYS = 14;
export const DEV_MAX_DAYS = 30;
export const PROD_BEHIND_MAX_DAYS = 14;

const LEVELS: Level[] = ['bronze', 'silver', 'gold'];

/** Pure: the value of the first case whose condition holds (instead of nested ternaries). */
const pick = <T>(cases: Array<[unknown, T]>, otherwise: T): T => {
  const hit = cases.find(([cond]) => !!cond);
  return hit ? hit[1] : otherwise;
};

/** Pure: semver-ish compare of "v1.2.3" tags (missing parts = 0). */
export const versionLess = (a: string, b: string) => {
  const p = (v: string) => v.replace(/^v/, '').split('.').map(n => Number.parseInt(n, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
};

/** Pure: the checks of one application. */
export function scoreChecks(f: Facts): Check[] {
  const ci = f.kind === 'ci';
  const c = (id: string, title: string, level: Level, state: CheckState, detail: string, fix?: string): Check =>
    ({ id, title, level, state, detail, fix: state === 'fail' || state === 'unknown' ? fix : undefined });

  const failing = Object.entries(f.scanners).filter(([k, v]) => ['gitleaks', 'semgrep', 'trivyDeps', 'trivyImage'].includes(k) && v === 'failure').map(([k]) => k);
  const scanned = Object.keys(f.scanners).some(k => ['gitleaks', 'trivyDeps', 'trivyImage'].includes(k));
  const placeholders = (f.placeholders?.dev ?? 0) + (f.placeholders?.prod ?? 0);
  const stale = f.dependabotPrAges.filter(d => d > DEP_PR_MAX_DAYS).length;

  let ciState: CheckState = 'unknown';
  if (!ci) ciState = 'na';
  else if (f.lastMainRun === 'success') ciState = 'pass';
  else if (f.lastMainRun === 'failure') ciState = 'fail';
  else if (f.lastMainRun === 'none') ciState = 'fail';

  let vulnState: CheckState = 'na';
  if (ci) vulnState = pick<CheckState>([[!scanned, 'unknown'], [failing.length, 'fail']], 'pass');

  let secretsState: CheckState = 'na';
  if (f.deployed) secretsState = pick<CheckState>([[f.placeholders === undefined, 'unknown'], [placeholders, 'fail']], 'pass');

  let covState: CheckState = 'na';
  if (ci) {
    if (!f.sonar?.exists) covState = 'fail';
    else if (!f.sonar.analysed || f.sonar.coverage === undefined) covState = 'unknown';
    else covState = f.sonar.coverage >= COVERAGE_MIN ? 'pass' : 'fail';
  }

  let depState: CheckState = 'na';
  if (ci) depState = !f.dependabot || stale ? 'fail' : 'pass';

  let loopState: CheckState = 'na';
  if (ci) {
    if (!f.loopUsed) loopState = 'fail';
    else if (!f.loopLatest) loopState = 'unknown';
    else loopState = versionLess(f.loopUsed, f.loopLatest) ? 'fail' : 'pass';
  }

  let freshState: CheckState = 'na';
  let freshDetail = 'not deployed';
  if (f.deployed) {
    const devOld = (f.dev?.ageDays ?? Infinity) > DEV_MAX_DAYS;
    const prodBehind = !!f.prod?.tag && f.prod.tag !== f.dev?.tag && (f.dev?.ageDays ?? 0) < (f.prod.ageDays ?? 0) - PROD_BEHIND_MAX_DAYS;
    freshState = devOld || prodBehind ? 'fail' : 'pass';
    freshDetail = pick([
      [devOld, `dev last deployed ${f.dev?.ageDays ?? '?'} days ago (max ${DEV_MAX_DAYS})`],
      [prodBehind, `prod is ${f.prod?.tag} — more than ${PROD_BEHIND_MAX_DAYS} days behind dev ${f.dev?.tag}`],
    ], `dev ${f.dev?.tag ?? '?'}${f.prod?.tag ? ` · prod ${f.prod.tag}` : ''}`);
  }

  return [
    c('ci', 'CI green on main', 'bronze', ciState,
      ciState === 'na' ? 'repository without CI' : `last main run: ${f.lastMainRun ?? 'unknown'}`, 'Open the failed run (CI tab) and fix the failing step, or click Run build.'),
    c('vulns', 'No critical findings', 'bronze', vulnState,
      pick([[failing.length, `failing: ${failing.join(', ')}`], [vulnState === 'pass', 'Gitleaks, Trivy (and Semgrep if on) passed'], [vulnState === 'na', 'no CI']], 'no scan results yet'),
      'Security tab shows the finding and the fix (upgrade the dependency, rebuild the image, remove the secret).'),
    c('secrets', 'Secrets complete', 'bronze', secretsState,
      pick([[secretsState === 'na', 'not deployed'], [placeholders, `${placeholders} secret(s) still CHANGE_ME`], [secretsState === 'pass', 'all secrets set']], 'secret list not readable'),
      'Deployment → Secrets tab: set the values marked CHANGE_ME.'),
    c('coverage', `Test coverage ≥ ${COVERAGE_MIN} %`, 'silver', covState,
      pick([[covState === 'na', 'no CI'], [!f.sonar?.exists, 'SonarQube not switched on'], [f.sonar?.coverage === undefined, 'no analysis yet']], `coverage ${f.sonar?.coverage} %`),
      f.sonar?.exists ? 'Add tests — the SonarQube tab shows uncovered code.' : 'Edit the pipeline → switch SonarQube on.'),
    c('deps', 'Dependencies maintained', 'silver', depState,
      pick([[depState === 'na', 'no CI'], [!f.dependabot, 'Dependabot off'], [stale, `${stale} Dependabot PR(s) open > ${DEP_PR_MAX_DAYS} days`]],
        `Dependabot on${f.dependabotPrAges.length ? ` · ${f.dependabotPrAges.length} PR(s) open` : ''}`),
      f.dependabot ? 'Review and merge the open Dependabot pull requests.' : 'Edit the pipeline → switch Dependabot on.'),
    c('docs', 'Documentation', 'silver', f.docs ? 'pass' : 'fail',
      f.docs ? 'Tech Docs present' : 'no docs (mkdocs.yml)', 'Add docs/index.md and mkdocs.yml — shown in the Tech Docs tab.'),
    c('loop', 'Latest pipeline (Loop)', 'gold', loopState,
      pick([[loopState === 'na', 'no CI'], [!f.loopUsed, 'pipeline not built on Loop']], `uses ${f.loopUsed}${f.loopLatest ? ` · latest ${f.loopLatest}` : ''}`),
      f.loopUsed ? 'Accept the Dependabot PR that updates the Loop stages (or bump the version in ci.yml).' : 'Rebuild the pipeline on Loop (Create pipeline) to get the shared, maintained stages.'),
    c('fresh', 'Fresh deployment', 'gold', freshState, freshDetail,
      'Deploy a recent build to dev, then Promote to prod.'),
    c('fourEyes', 'Four eyes possible', 'gold', f.reviewers >= 2 ? 'pass' : 'fail',
      `${f.reviewers} person(s) in the space can review`, 'Add a second developer or maintainer in Members — main needs an approval from someone else.'),
  ];
}

/** Pure: the highest level whose checks (and all below) pass; n/a counts as passed. */
export function levelOf(checks: Check[]): Level | undefined {
  let reached: Level | undefined;
  for (const l of LEVELS) {
    const upTo = checks.filter(x => LEVELS.indexOf(x.level) <= LEVELS.indexOf(l));
    if (upTo.every(x => x.state === 'pass' || x.state === 'na')) reached = l; else break;
  }
  return reached;
}

// ---------- facts (I/O) ----------

let loopLatestCache: { at: number; v?: string } | undefined;
async function loopLatest(token: string) {
  if (loopLatestCache && Date.now() - loopLatestCache.at < 30 * 60_000) return loopLatestCache.v;
  const r = await gh(token, 'GET', `/repos/${OWNER}/loop/releases/latest`);
  let v = r.ok ? String(r.json?.tag_name ?? '') : '';
  if (!v) {
    const tags = await gh(token, 'GET', `/repos/${OWNER}/loop/tags?per_page=50`);
    v = ((tags.json ?? []) as any[]).map(t => String(t.name)).filter(n => /^v\d/.test(n)).sort((a, b) => (versionLess(a, b) ? 1 : -1))[0] ?? '';
  }
  loopLatestCache = { at: Date.now(), v: v || undefined };
  return loopLatestCache.v;
}

const days = (iso?: string) => (iso ? Math.floor((Date.now() - Date.parse(iso)) / 864e5) : undefined);

/** Gather the facts of one app (read-only). `reviewers` comes from the catalog (router). */
export async function collectFacts(config: Config, repo: string, sonarKey: string | undefined, kind: 'ci' | 'repo', reviewers: number): Promise<Facts> {
  const token = await githubToken(config, OWNER);
  const [ins, ciYml, mkdocs, dependabotYml, latest, deployed] = await Promise.all([
    kind === 'ci' ? pipelineInsights(config, repo, sonarKey) as Promise<any> : Promise.resolve(undefined),
    kind === 'ci' ? readFile(token, repo, '.github/workflows/ci.yml') : Promise.resolve(undefined),
    readFile(token, repo, 'mkdocs.yml'),
    kind === 'ci' ? readFile(token, repo, '.github/dependabot.yml') : Promise.resolve(undefined),
    kind === 'ci' ? loopLatest(token) : Promise.resolve(undefined),
    readFile(token, `${repo}-gitops`, 'deployment.json').then(Boolean),
  ]);
  const last = ins?.lastMainRun;
  let lastMainRun: Facts['lastMainRun'] = 'none';
  if (last) lastMainRun = pick<Facts['lastMainRun']>([[last.conclusion === 'success', 'success'], [last.status !== 'completed', 'running']], 'failure');
  const placeholders = deployed
    ? await Promise.all([secretPlaceholders(config, repo, 'dev'), ins?.envs?.prod ? secretPlaceholders(config, repo, 'prod') : Promise.resolve(0)])
      .then(([dev, prod]) => ({ dev, prod }), () => undefined)
    : undefined;
  return {
    kind,
    lastMainRun: kind === 'ci' ? lastMainRun : undefined,
    scanners: (ins?.scanners ?? {}) as Record<string, string>,
    sonar: ins?.sonar,
    dependabot: !!dependabotYml,
    dependabotPrAges: ((ins?.code?.openPulls ?? []) as any[]).filter(p => /dependabot/i.test(String(p.author))).map(p => days(p.createdAt) ?? 0),
    loopUsed: ciYml?.match(/Everesto-Inc\/loop\/stages\/[a-z-]+@[0-9a-f]{40} # (v[\d.]+)/)?.[1],
    loopLatest: latest,
    docs: !!mkdocs,
    deployed,
    dev: ins?.envs?.dev ? { tag: ins.envs.dev.tag, ageDays: days(ins.envs.dev.at) } : undefined,
    prod: ins?.envs?.prod ? { tag: ins.envs.prod.tag, ageDays: days(ins.envs.prod.at) } : undefined,
    placeholders,
    reviewers,
  };
}
