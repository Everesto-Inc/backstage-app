/**
 * everesto import — bring an EXISTING repository of the org into a DevOps Space, on Loop v1.1.
 * ("Create pipeline" only creates new repos; this is the way in for repos that already exist, e.g. maas-backend.)
 *
 *   GET  /api/everesto/spaces/:space/importable           repos of the org that are in no space yet
 *   POST /api/everesto/spaces/:space/import  { repo, stack, tests, semgrep, sonarqube, dependabot, trivy }
 *
 * Nothing in the repo changes until a human merges the pull request:
 *   1. checks: repo exists, not archived, not a platform / gitops repo, not in a space yet
 *   2. SonarQube ON → project + project-only token → repo secret SONAR_TOKEN (so the PR's CI can analyse)
 *   3. branch backstage/onboard-loop + ONE commit: .github/workflows/ci.yml (Loop v1.1), catalog-info.yaml,
 *      sonar-project.properties, .github/dependabot.yml — and deletes the repo's other workflow files
 *   4. pull request → main (reused when it already exists: the import can be re-run safely)
 *   5. registry: <repo> → <space> (everesto-catalog/platform/apps.yaml) — THE source of permissions
 *   6. catalog: Location everesto-catalog/apps/<repo>.yaml (presence: optional — shows up once the PR is merged)
 *   7. public repo → secret scanning + push protection
 * The caller (everestoInsights) then runs the access sync for the space: teams, repo permissions, main ruleset.
 */
import { err } from './everestoCommon';
import { Config } from '@backstage/config';
import { gh, githubToken, sonarProvision } from './everestoActions';
import { OWNER, PROTECTED_SYSTEMS, allowed, commit, readFile } from './everestoManage';
import { ROLE } from './everestoRoles';
import { REGISTRY_REPO, readRegistry, registerApp } from './everestoRegistry';
import { LOOP, STACKS, Stack, Switches, ciYml, dependabotYml, runnerFor } from './everestoLoop';

export const IMPORT_BRANCH = 'backstage/onboard-loop';
/** Repos that are platform plumbing — never imported into a tenant space. */
const PLATFORM_REPOS = ['backstage-app', 'loop', 'gitops-backstage', 'everesto-catalog', '.github'];
const NAME = /^[a-z0-9][a-z0-9-]{0,99}$/;

export type ImportInput = Switches & { repo: string; stack: Stack; dependabot: boolean };

const importable = (r: any, registry: Record<string, string>) =>
  !r.archived && !r.fork && NAME.test(r.name) && !r.name.endsWith('-gitops')
  && !PLATFORM_REPOS.includes(r.name) && !PROTECTED_SYSTEMS.includes(r.name) && !registry[r.name];

/** Repos of the org that can be imported (in no space yet, not platform, not gitops). */
export async function importableRepos(config: Config) {
  const token = await githubToken(config, OWNER);
  const registry = await readRegistry(token, true);
  const all: any[] = [];
  for (let page = 1; page < 10; page++) {
    const r = await gh(token, 'GET', `/orgs/${OWNER}/repos?per_page=100&page=${page}&sort=full_name`);
    const list = (r.json ?? []) as any[];
    all.push(...list);
    if (list.length < 100) break;
  }
  return all.filter(r => importable(r, registry)).map(r => ({
    name: r.name as string, private: !!r.private, description: (r.description ?? '') as string,
    language: (r.language ?? '') as string, defaultBranch: r.default_branch as string,
  }));
}

/** Pure: catalog-info.yaml of an imported application. */
export function catalogInfo(repo: string, space: string, description: string, sw: ImportInput, hasDocs: boolean) {
  const a: string[] = [
    `    github.com/project-slug: ${OWNER}/${repo}`,
    ...(hasDocs ? ['    backstage.io/techdocs-ref: dir:.'] : []),
    '    everesto.live/ci-workflow: ci.yml',
    `    everesto.live/image: ghcr.io/${OWNER.toLowerCase()}/${repo}`,
    `    everesto.live/loop: ${LOOP.version}`,
    '    everesto.live/gitleaks: "on"',
    `    everesto.live/trivy: "${sw.trivy === 'report' ? 'report' : 'on'}"`,
    ...(sw.tests ? [] : ['    everesto.live/tests: "off"']),
    ...(sw.semgrep ? ['    everesto.live/semgrep: "on"'] : []),
    ...(sw.sonarqube ? [`    sonarqube.org/project-key: ${repo}`] : []),
    ...(sw.dependabot ? ['    everesto.live/dependabot: "on"'] : []),
  ];
  return `# Managed by Backstage (imported into DevOps Space ${space}). The space is decided by the platform registry, not by this file.
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: ${repo}
  description: ${JSON.stringify(description || `Application ${repo} of space ${space}`)}
  annotations:
${a.join('\n')}
spec:
  type: service
  lifecycle: experimental
  owner: ${space}
  system: ${space}
`;
}

/** Pure: optional catalog Location for an imported repo (no error while catalog-info.yaml is not merged yet). */
export const locationYaml = (repo: string, branch: string) => `# Imported application ${repo} — written by Backstage "Import repository".
# presence: optional → no error until the import pull request (which adds catalog-info.yaml) is merged.
apiVersion: backstage.io/v1alpha1
kind: Location
metadata:
  name: app-${repo}
spec:
  type: url
  presence: optional
  target: https://github.com/${OWNER}/${repo}/blob/${branch}/catalog-info.yaml
`;

/** Pure: all.yaml with ./apps/<repo>.yaml added to spec.targets (unchanged when already there). */
export function addTarget(allYaml: string, repo: string) {
  const line = `./apps/${repo}.yaml`;
  if (allYaml.includes(line)) return allYaml;
  const lines = allYaml.split('\n');
  const start = lines.findIndex(l => /^\s*targets:\s*$/.test(l));
  if (start < 0) throw err(502, 'everesto-catalog/all.yaml has no spec.targets');
  let last = start;
  for (let i = start + 1; i < lines.length && /^\s+- /.test(lines[i]); i++) last = i;
  const indent = lines[last].match(/^(\s+)- /)?.[1] ?? '    ';
  lines.splice(last + 1, 0, `${indent}- ${line}   # imported application (Backstage)`);
  return lines.join('\n');
}

/** Pure: the PR description. */
export const prBody = (repo: string, space: string, sw: ImportInput, removed: string[], hadCatalog: boolean) => `## Onboard \`${repo}\` to DevOps Space **${space}** (Loop ${LOOP.version})

Opened by Backstage **Import repository**. Nothing changes until this is merged.

| | |
|---|---|
| Stack | \`${sw.stack}\` |
| Tests | ${sw.tests ? 'on' : 'off'} |
| Semgrep | ${sw.semgrep ? 'on' : 'off'} |
| SonarQube | ${sw.sonarqube ? 'on (project + SONAR_TOKEN already created)' : 'off'} |
| Trivy | ${sw.trivy}${sw.trivy === 'report' ? ' ⚠ findings do not fail the build' : ''} |
| Always | Gitleaks · Trivy scans · arm64 image → \`ghcr.io/${OWNER.toLowerCase()}/${repo}\` (pushed from main) |

**Files**
- \`.github/workflows/ci.yml\` — one Loop call with the switches above (Backstage → Edit pipeline flips them later)
- \`catalog-info.yaml\` — ${hadCatalog ? 'replaced (old version stays in git history)' : 'added'}
${sw.sonarqube ? '- `sonar-project.properties` — SonarQube project key\n' : ''}${sw.dependabot ? '- `.github/dependabot.yml` — upgrade PRs\n' : ''}${removed.length ? `- **removed** old workflows: ${removed.map(f => `\`${f}\``).join(', ')} (replaced by Loop — re-add own jobs to ci.yml with \`needs: loop\`)\n` : ''}
After merge: the app appears in ${space} in Backstage, CI publishes the image, then **Create deployment**.
`;

export async function importRepo(config: Config, space: string, input: ImportInput, refs: string[], who: string) {
  const { repo } = input;
  if (!NAME.test(space) || !NAME.test(repo)) throw err(400, 'invalid space or repo name');
  if (!STACKS.includes(input.stack)) throw err(400, `stack must be one of ${STACKS.join(', ')}`);
  if (!allowed(refs, space, [...ROLE.CREATE])) throw err(403, `only maintainers/managers of ${space} can import repositories`);
  const token = await githubToken(config, OWNER);

  // 1. checks
  const info = await gh(token, 'GET', `/repos/${OWNER}/${repo}`);
  if (info.status === 404) throw err(404, `${OWNER}/${repo} does not exist (transfer it to the org first)`);
  const registry = await readRegistry(token, true);
  if (registry[repo]) throw err(409, `${repo} already belongs to space ${registry[repo]}`);
  if (!importable(info.json, registry)) throw err(409, `${repo} cannot be imported (archived, fork, platform or gitops repo)`);
  const base = info.json.default_branch as string;
  // Everesto convention: `main`. Backstage reads catalog-info / builds from main, and Loop's ci.yml runs on push to main.
  if (base !== 'main') {
    throw err(409, `${repo}'s default branch is "${base}" — rename it to "main" first (GitHub → Settings → General → Default branch → ✏️; `
      + 'for a case-only change like Main → main, rename twice: Main → main-tmp → main). Nothing was changed.');
  }
  const done: string[] = [];
  const warn: string[] = [];

  // 2. SonarQube first: the PR's CI run needs SONAR_TOKEN
  if (input.sonarqube) {
    await sonarProvision(config, OWNER, repo, repo, [space]);
    done.push(`SonarQube project ${repo} + secret SONAR_TOKEN`);
  }

  // 3. branch (re)created from the default branch, one commit with all files
  const head = (await gh(token, 'GET', `/repos/${OWNER}/${repo}/git/ref/heads/${base}`)).json?.object?.sha;
  if (!head) throw err(502, `cannot read ${repo}@${base}`);
  const mk = await gh(token, 'POST', `/repos/${OWNER}/${repo}/git/refs`, { ref: `refs/heads/${IMPORT_BRANCH}`, sha: head });
  if (!mk.ok) {
    const reset = await gh(token, 'PATCH', `/repos/${OWNER}/${repo}/git/refs/heads/${IMPORT_BRANCH}`, { sha: head, force: true });
    if (!reset.ok) throw err(502, `cannot create branch ${IMPORT_BRANCH} (${mk.status}/${reset.status})`);
  }
  const workflows = ((await gh(token, 'GET', `/repos/${OWNER}/${repo}/contents/.github/workflows?ref=${base}`)).json ?? []) as any[];
  const removed = (Array.isArray(workflows) ? workflows : []).map(f => String(f.path)).filter(p => /\.ya?ml$/.test(p) && p !== '.github/workflows/ci.yml');
  const hadCatalog = (await gh(token, 'GET', `/repos/${OWNER}/${repo}/contents/catalog-info.yaml?ref=${base}`)).ok;
  const hasDocs = (await gh(token, 'GET', `/repos/${OWNER}/${repo}/contents/mkdocs.yml?ref=${base}`)).ok;
  const files: { path: string; content: string | null }[] = [
    { path: '.github/workflows/ci.yml', content: ciYml(repo, input.stack, input, runnerFor(!info.json.private)) },
    { path: 'catalog-info.yaml', content: catalogInfo(repo, space, String(info.json.description ?? ''), input, hasDocs) },
    ...removed.map(path => ({ path, content: null })),
  ];
  if (input.sonarqube) {
    const props = (await gh(token, 'GET', `/repos/${OWNER}/${repo}/contents/sonar-project.properties?ref=${base}`)).json?.content;
    const text = props ? Buffer.from(props, 'base64').toString('utf8') : '';
    files.push({ path: 'sonar-project.properties', content: /^sonar\.projectKey=/m.test(text) ? text.replace(/^sonar\.projectKey=.*$/m, `sonar.projectKey=${repo}`) : `sonar.projectKey=${repo}\n${text}` });
  }
  if (input.dependabot) files.push({ path: '.github/dependabot.yml', content: dependabotYml(input.stack) });
  await commit(token, repo, `onboard ${repo} to space ${space} on Loop ${LOOP.version} (Backstage, by ${who})`, files, IMPORT_BRANCH);
  done.push(`branch ${IMPORT_BRANCH}: ci.yml (Loop ${LOOP.version}), catalog-info.yaml${removed.length ? `, removed ${removed.length} old workflow(s)` : ''}`);

  // 4. pull request (reuse an open one)
  let pr = await gh(token, 'POST', `/repos/${OWNER}/${repo}/pulls`, {
    title: `Onboard to Backstage space ${space} (Loop ${LOOP.version})`, head: IMPORT_BRANCH, base, body: prBody(repo, space, input, removed, hadCatalog),
  });
  if (!pr.ok) {
    const open = await gh(token, 'GET', `/repos/${OWNER}/${repo}/pulls?state=open&head=${OWNER}:${IMPORT_BRANCH}`);
    pr = { ok: true, status: 200, json: (open.json ?? [])[0] };
    if (!pr.json) throw err(502, `cannot open the pull request in ${repo}`);
  }
  const prUrl = String(pr.json.html_url);
  done.push(`pull request: ${prUrl}`);

  // 5. registry — from now on the space's roles apply to this repo
  await registerApp(token, repo, space, who);
  done.push(`${repo} registered in space ${space}`);

  // 6. catalog location (optional until the PR is merged)
  const all = await readFile(token, REGISTRY_REPO, 'all.yaml');
  if (!all) {
    warn.push('everesto-catalog/all.yaml not readable — the app appears after "Register existing component" by hand');
  } else {
    await commit(token, REGISTRY_REPO, `catalog: imported app ${repo} (Backstage, by ${who})`, [
      { path: `apps/${repo}.yaml`, content: locationYaml(repo, base) },
      { path: 'all.yaml', content: addTarget(all, repo) },
    ]);
    done.push('catalog location added (the app appears in Backstage once the PR is merged)');
  }

  // 7. secret scanning (free on public repos only)
  if (!info.json.private) {
    const sec = await gh(token, 'PATCH', `/repos/${OWNER}/${repo}`, {
      security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } },
    });
    if (sec.ok) done.push('secret scanning + push protection'); else warn.push(`secret scanning not enabled (HTTP ${sec.status})`);
  }
  return { done, warn, prUrl };
}
