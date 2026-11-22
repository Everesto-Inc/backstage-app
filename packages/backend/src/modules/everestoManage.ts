/**
 * everesto manage — change or delete an existing application (Loop-based pipelines).
 *
 *   POST /api/everesto/apps/:repo/tools   { sonarqube?, semgrep?, dependabot?, tests?, trivy? }   owners + maintainers
 *     Loop v1.1 pipelines: flips the switch in the single Loop call (tests / trivy only exist there).
 *     Loop v1.0 pipelines: adds / removes the stage (below).
 *     → one commit in the app repo: ci.yml (Loop stage added/removed), catalog-info.yaml annotation,
 *       .github/dependabot.yml; SonarQube ON = create project + SONAR_TOKEN, OFF = DELETE project + secret.
 *       Gitleaks + Trivy (Loop guard + image scan) can't be switched off.
 *
 *   POST /api/everesto/apps/:repo/delete  { confirm: "<repo>" }                    owners only
 *     → SonarQube project, CD repo <repo>-gitops, catalog entry, and finally the GitHub repo (Actions + secrets go with it).
 *
 * Who: owner = platform-team (super admin, everything); maintainer = manager of one space (<space>-maintainers)
 * for tool changes) or be in platform-team. The repo's own catalog-info.yaml (read from GitHub, not
 * from the request) decides the project and the SonarQube key.
 */
import { err } from './everestoCommon';
import { Config } from '@backstage/config';
import { gh, githubToken, sonarProvision, sonarRemove } from './everestoActions';
import { ROLE } from './everestoRoles';

export { ROLE };
import { infisicalDelete } from './everestoInfisical';
import { component, setAnnotation } from './everestoYaml';
import { spaceOf, unregisterApp } from './everestoRegistry';
import { removeTenant } from './everestoTenants';
import { Trivy, isLoopV11, readSwitches, setSwitch } from './everestoLoop';

export const OWNER = 'Everesto-Inc';
const PLATFORM = 'group:default/platform-team';
/** Platform systems (domain platform): never deletable from Backstage — Backstage must not delete itself. */
export const PROTECTED_SYSTEMS = ['backstage', 'loop'];

/** …or any entity annotated everesto.live/protected: "true" (platform roots). */
export const isProtected = (catalogInfo: string) => /everesto\.live\/protected:\s*["']?true/.test(catalogInfo);

type File = { path: string; content: string | null }; // null = delete

export async function readFile(token: string, repo: string, path: string) {
  const r = await gh(token, 'GET', `/repos/${OWNER}/${repo}/contents/${path}?ref=main`);
  return r.ok ? Buffer.from(r.json.content, 'base64').toString('utf8') : undefined;
}

/** One commit with several file changes (null content = delete). */
export async function commit(token: string, repo: string, message: string, files: File[], branch = 'main') {
  const ref = await gh(token, 'GET', `/repos/${OWNER}/${repo}/git/ref/heads/${branch}`);
  const head = ref.json.object.sha;
  const base = (await gh(token, 'GET', `/repos/${OWNER}/${repo}/git/commits/${head}`)).json.tree.sha;
  const tree = await gh(token, 'POST', `/repos/${OWNER}/${repo}/git/trees`, {
    base_tree: base,
    tree: files.map(f => (f.content === null
      ? { path: f.path, mode: '100644', type: 'blob', sha: null }
      : { path: f.path, mode: '100644', type: 'blob', content: f.content })),
  });
  if (!tree.ok) throw new Error(`GitHub: cannot build commit (${tree.status})`);
  const c = await gh(token, 'POST', `/repos/${OWNER}/${repo}/git/commits`, { message, tree: tree.json.sha, parents: [head] });
  const upd = await gh(token, 'PATCH', `/repos/${OWNER}/${repo}/git/refs/heads/${branch}`, { sha: c.json.sha });
  if (!upd.ok) throw new Error(`GitHub: cannot push to ${branch} (${upd.status})`);
  return String(c.json.sha).slice(0, 7);
}

/** What the repo says about itself (catalog-info.yaml) — never trust the request for this. */
export async function appInfo(token: string, repo: string) {
  const info = await readFile(token, repo, 'catalog-info.yaml');
  if (!info) throw err(404, 'not a Backstage application (no catalog-info.yaml)');
  // The SPACE comes from the platform's app registry — never from the repo itself (anyone who can merge into the
  // repo could otherwise claim another space and use that space's roles). Not registered → nobody but the owner acts.
  const project = await spaceOf(token, repo);
  if (!project) throw err(409, `${repo} is not registered with a DevOps Space — ask the platform team`);
  const c = component(info);
  const sonarKey = c?.annotations['sonarqube.org/project-key'];
  return { info, project, sonarKey, app: repo.startsWith(`${project}-`) ? repo.slice(project.length + 1) : repo };
}

export const allowed = (refs: string[], project: string, roles: string[]) =>
  refs.includes(PLATFORM) || roles.some(r => refs.includes(`group:default/${project}-${r}`));

// ---------- tool switches ----------

const STEP = {
  sonarqube: (sha: string, v: string) =>
    `      - name: Quality gate (SonarQube)\n        uses: Everesto-Inc/loop/stages/sonarqube@${sha} # ${v}\n        with: { token: '\${{ secrets.SONAR_TOKEN }}' }\n`,
  semgrep: (sha: string, v: string) =>
    `      - name: Code security (Semgrep)\n        uses: Everesto-Inc/loop/stages/semgrep@${sha} # ${v}\n`,
};
const STEP_RE = {
  sonarqube: /\n? {6}- name: Quality gate \(SonarQube\)\n(?: {8}.*\n)*/,
  semgrep: /\n? {6}- name: Code security \(Semgrep\)\n(?: {8}.*\n)*/,
};
const ANNOTATION_KEY = { sonarqube: 'sonarqube.org/project-key', semgrep: 'everesto.live/semgrep', dependabot: 'everesto.live/dependabot' } as const;
const ANNOTATION_VALUE = { sonarqube: (repo: string) => repo, semgrep: () => 'on', dependabot: () => 'on' };
const dependabotYml = (stack: string) => `version: 2
updates:
  - package-ecosystem: ${stack === 'java' ? 'maven' : 'pip'}
    directory: /
    schedule: { interval: weekly }
    cooldown: { default-days: 7 }   # don't propose versions younger than 7 days
    open-pull-requests-limit: 5
  - package-ecosystem: docker
    directory: /
    schedule: { interval: weekly }
    cooldown: { default-days: 7 }
  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: monthly }
    cooldown: { default-days: 7 }
`;

/**
 * Pure: add/remove the Semgrep / SonarQube Loop stages in ci.yml and their annotations in catalog-info.yaml.
 * Removing then adding a stage gives back the identical file (tested in everestoManage.test.ts).
 */
export function editCiTools(
  ciIn: string, catalogIn: string, change: ToolChange, has: { semgrep: boolean; sonarqube: boolean },
  repo: string, sha: string, version: string,
) {
  let ci = ciIn;
  let catalog = catalogIn;
  const done: string[] = [];
  for (const tool of ['semgrep', 'sonarqube'] as const) {
    const want = change[tool];
    if (want === undefined || want === has[tool]) continue;
    if (want) {
      const anchor = /(\n {6}- name: Build \+ scan image \(Trivy\))/;
      if (!anchor.test(ci)) throw err(409, 'ci.yml was changed by hand (no "Build + scan image (Trivy)" step) — add the stage by hand');
      ci = ci.replace(anchor, `\n${STEP[tool](sha, version)}$1`);
      catalog = setAnnotation(catalog, 'Component', undefined, ANNOTATION_KEY[tool], ANNOTATION_VALUE[tool](repo));
    } else {
      ci = ci.replace(STEP_RE[tool], '\n');
      catalog = setAnnotation(catalog, 'Component', undefined, ANNOTATION_KEY[tool], undefined);
    }
    done.push(`${want ? 'add' : 'remove'} ${tool}`);
  }
  return { ci: ci.replaceAll(/\n{3,}/g, '\n\n'), catalog, done };
}

export type ToolChange = Partial<Record<'sonarqube' | 'semgrep' | 'dependabot' | 'tests', boolean>> & { trivy?: Trivy };

/** Pure: Loop v1.1 — flip switches in ci.yml + the matching catalog annotations. */
export function editCiSwitches(ciIn: string, catalogIn: string, change: ToolChange, repo: string) {
  const has = readSwitches(ciIn);
  let ci = ciIn;
  let catalog = catalogIn;
  const done: string[] = [];
  for (const tool of ['tests', 'semgrep', 'sonarqube'] as const) {
    const want = change[tool];
    if (want === undefined || want === has[tool]) continue;
    ci = setSwitch(ci, tool, want);
    catalog = tool === 'tests'
      ? setAnnotation(catalog, 'Component', undefined, 'everesto.live/tests', want ? undefined : 'off') // UI shows the switch
      : setAnnotation(catalog, 'Component', undefined, ANNOTATION_KEY[tool], want ? ANNOTATION_VALUE[tool](repo) : undefined);
    done.push(`${want ? 'add' : 'remove'} ${tool}`);
  }
  if (change.trivy && change.trivy !== has.trivy) {
    ci = setSwitch(ci, 'trivy', change.trivy);
    catalog = setAnnotation(catalog, 'Component', undefined, 'everesto.live/trivy', change.trivy === 'report' ? 'report' : 'on');
    done.push(`trivy ${change.trivy}`);
  }
  return { ci, catalog, done, has };
}

export async function setTools(config: Config, repo: string, change: ToolChange, refs: string[], who: string) {
  const token = await githubToken(config, OWNER);
  const { info, project, sonarKey } = await appInfo(token, repo);
  if (!allowed(refs, project, [...ROLE.CREATE])) {
    throw err(403, `only maintainers/managers of ${project} can change its tools`);
  }
  let ci = await readFile(token, repo, '.github/workflows/ci.yml');
  if (!ci) throw err(409, 'no .github/workflows/ci.yml — pipeline is not built on Loop');
  const stack = ci.match(/stack: (\w+)/)?.[1] ?? 'python';
  let catalog = info;
  const files: File[] = [];
  const done: string[] = [];
  const dependabotOn = (await readFile(token, repo, '.github/dependabot.yml')) !== undefined;
  const after: (() => Promise<void>)[] = []; // deletions run only after the commit landed
  let has: { sonarqube: boolean; semgrep: boolean; dependabot: boolean };

  if (isLoopV11(ci)) {
    const edited = editCiSwitches(ci, catalog, change, repo);
    ci = edited.ci;
    catalog = edited.catalog;
    done.push(...edited.done);
    has = { sonarqube: edited.has.sonarqube, semgrep: edited.has.semgrep, dependabot: dependabotOn };
  } else {
    const loop = ci.match(/Everesto-Inc\/loop\/stages\/install@([0-9a-f]{40}) # (\S+)/);
    if (!loop) throw err(409, 'pipeline is not built on Loop — edit ci.yml by hand');
    if (change.tests !== undefined || change.trivy !== undefined) throw err(409, 'tests / Trivy switches need Loop v1.1 — this pipeline is on Loop v1.0');
    const [, sha, version] = loop;
    has = { sonarqube: STEP_RE.sonarqube.test(ci), semgrep: STEP_RE.semgrep.test(ci), dependabot: dependabotOn };
    const edited = editCiTools(ci, catalog, change, has, repo, sha, version);
    ci = edited.ci;
    catalog = edited.catalog;
    done.push(...edited.done);
  }

  if (change.dependabot !== undefined && change.dependabot !== has.dependabot) {
    files.push({ path: '.github/dependabot.yml', content: change.dependabot ? dependabotYml(stack) : null });
    catalog = setAnnotation(catalog, 'Component', undefined, ANNOTATION_KEY.dependabot, change.dependabot ? 'on' : undefined);
    done.push(`${change.dependabot ? 'add' : 'remove'} dependabot`);
  }
  if (!done.length) return { changed: false, done };

  // SonarQube ON: project + token BEFORE the commit, so the CI run it triggers can analyse.
  if (change.sonarqube === true && !has.sonarqube) {
    await sonarProvision(config, OWNER, repo, repo, [project]);
    const props = await readFile(token, repo, 'sonar-project.properties');
    files.push({
      path: 'sonar-project.properties',
      content: props ? props.replace(/^sonar\.projectKey=.*$/m, `sonar.projectKey=${repo}`) : `sonar.projectKey=${repo}\n`,
    });
  }
  if (change.sonarqube === false && has.sonarqube) {
    const key = sonarKey ?? repo;
    after.push(() => sonarRemove(config, OWNER, repo, key));
    done.push(`deleted SonarQube project ${key} + secret SONAR_TOKEN`);
  }

  files.push({ path: '.github/workflows/ci.yml', content: ci }, { path: 'catalog-info.yaml', content: catalog });
  const commitSha = await commit(token, repo, `pipeline: ${done.filter(d => !d.startsWith('deleted')).join(', ')} (Backstage, by ${who})`, files);
  for (const f of after) await f();
  return { changed: true, done, commit: commitSha };
}

// ---------- delete application ----------

export async function deleteApp(
  config: Config, repo: string, refs: string[],
  unregister: (repo: string) => Promise<void>,
) {
  const token = await githubToken(config, OWNER);
  const { info, project, sonarKey } = await appInfo(token, repo);
  if (PROTECTED_SYSTEMS.includes(project) || isProtected(info)) throw err(403, `${repo} is part of the platform (${project}) — it cannot be deleted from Backstage`);
  if (!allowed(refs, project, [...ROLE.PROD])) { // managers (incl. entity managers) + owner
    throw err(403, `only managers of ${project} (or the owner) can delete applications`);
  }
  const done: string[] = [];
  const warn: string[] = [];

  if (sonarKey) {
    await sonarRemove(config, OWNER, repo, sonarKey).then(
      () => done.push(`SonarQube project ${sonarKey}`),
      e => warn.push(String(e)),
    );
  }

  // CD: repo <repo>-gitops (ArgoCD apps <repo>-dev / -prod remove their pods via finalizer)
  const gitops = `${repo}-gitops`;
  const hasCd = (await gh(token, 'GET', `/repos/${OWNER}/${gitops}`)).ok;
  if (hasCd) {
    const d = await gh(token, 'DELETE', `/repos/${OWNER}/${gitops}`);
    if (d.ok) done.push(`GitHub repo ${OWNER}/${gitops} (CD)`);
    else warn.push(`could not delete ${gitops} (${d.status})`);
    await removeTenant(token, project, repo, 'Backstage').then(
      () => done.push('ArgoCD apps, secret stores and ESO login: removed from git — ArgoCD deletes them within ~3 min'),
      e => warn.push(`tenant file not removed: ${e}`));
    const inf = await infisicalDelete(config, project, repo);
    done.push(...inf.done);
    warn.push(...inf.warn);
  }

  await unregister(repo).then(() => done.push('catalog entry'), e => warn.push(`catalog: ${e}`));

  const del = await gh(token, 'DELETE', `/repos/${OWNER}/${repo}`);
  if (!del.ok) throw new Error(`GitHub: cannot delete repo ${repo} (${del.status}) — done so far: ${done.join(', ')}`);
  done.push(`GitHub repo ${OWNER}/${repo} (with its Actions + secrets)`);
  await unregisterApp(token, repo, 'Backstage').then(() => done.push('app registry entry'), e => warn.push(`registry: ${e}`));

  warn.push(`container images ghcr.io/everesto-inc/${repo} — delete in GitHub → Packages (the GitHub App can't)`);
  return { done, warn };
}
