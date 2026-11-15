/**
 * everesto manage — change or delete an existing application (Loop-based pipelines).
 *
 *   POST /api/everesto/apps/:repo/tools   { sonarqube?, semgrep?, dependabot? }   owners + maintainers
 *     → one commit in the app repo: ci.yml (Loop stage added/removed), catalog-info.yaml annotation,
 *       .github/dependabot.yml; SonarQube ON = create project + SONAR_TOKEN, OFF = DELETE project + secret.
 *       Gitleaks + Trivy (Loop guard + image scan) can't be switched off.
 *
 *   POST /api/everesto/apps/:repo/delete  { confirm: "<repo>" }                    owners only
 *     → SonarQube project, CD repo <repo>-gitops, catalog entry, and finally the GitHub repo (Actions + secrets go with it).
 *
 * Who: the signed-in user must own the app's project (group <project>-owners, + <project>-maintainers
 * for tool changes) or be in platform-team. The repo's own catalog-info.yaml (read from GitHub, not
 * from the request) decides the project and the SonarQube key.
 */
import { Config } from '@backstage/config';
import { gh, githubToken, sonarProvision, sonarRemove } from './everestoActions';
import { infisicalDelete } from './everestoDeploy';

export const OWNER = 'Everesto-Inc';
const PLATFORM = 'group:default/platform-team';
/** Platform systems (domain platform): never deletable from Backstage — Backstage must not delete itself. */
export const PROTECTED_SYSTEMS = ['backstage', 'loop'];

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
  if (!info) throw Object.assign(new Error('not a Backstage application (no catalog-info.yaml)'), { status: 404 });
  const project = info.match(/^\s+system:\s*([a-z0-9-]+)/m)?.[1];
  const sonarKey = info.match(/sonarqube\.org\/project-key:\s*([A-Za-z0-9_.:-]+)/)?.[1];
  if (!project) throw Object.assign(new Error('catalog-info.yaml has no spec.system'), { status: 409 });
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
const ANNOTATION = {
  sonarqube: (repo: string) => `    sonarqube.org/project-key: ${repo}\n`,
  semgrep: () => `    everesto.live/semgrep: "on"\n`,
  dependabot: () => `    everesto.live/dependabot: "on"\n`,
};
const ANNOTATION_RE = {
  sonarqube: /^ {4}sonarqube\.org\/project-key:.*\n/m,
  semgrep: /^ {4}everesto\.live\/semgrep:.*\n/m,
  dependabot: /^ {4}everesto\.live\/dependabot:.*\n/m,
};
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

export type ToolChange = Partial<Record<'sonarqube' | 'semgrep' | 'dependabot', boolean>>;

export async function setTools(config: Config, repo: string, change: ToolChange, refs: string[], who: string) {
  const token = await githubToken(config, OWNER);
  const { info, project, sonarKey } = await appInfo(token, repo);
  if (!allowed(refs, project, ['owners', 'maintainers'])) {
    throw Object.assign(new Error(`only owners/maintainers of ${project} can change its tools`), { status: 403 });
  }
  let ci = await readFile(token, repo, '.github/workflows/ci.yml');
  const loop = ci?.match(/Everesto-Inc\/loop\/stages\/install@([0-9a-f]{40}) # (\S+)/);
  if (!ci || !loop) throw Object.assign(new Error('pipeline is not built on Loop — edit ci.yml by hand'), { status: 409 });
  const [, sha, version] = loop;
  const stack = ci.match(/stack: (\w+)/)?.[1] ?? 'python';
  let catalog = info;
  const files: File[] = [];
  const done: string[] = [];
  const has = {
    sonarqube: STEP_RE.sonarqube.test(ci),
    semgrep: STEP_RE.semgrep.test(ci),
    dependabot: (await readFile(token, repo, '.github/dependabot.yml')) !== undefined,
  };
  const after: (() => Promise<void>)[] = []; // deletions run only after the commit landed

  for (const tool of ['semgrep', 'sonarqube'] as const) {
    const want = change[tool];
    if (want === undefined || want === has[tool]) continue;
    if (want) {
      ci = ci.replace(/(\n {6}- name: Build \+ scan image \(Trivy\))/, `\n${STEP[tool](sha, version)}$1`);
      catalog = catalog.replace(/(^ {4}everesto\.live\/image:.*\n)/m, `$1${ANNOTATION[tool](repo)}`);
    } else {
      ci = ci.replace(STEP_RE[tool], '\n');
      catalog = catalog.replace(ANNOTATION_RE[tool], '');
    }
    done.push(`${want ? 'add' : 'remove'} ${tool}`);
  }
  ci = ci.replace(/\n{3,}/g, '\n\n');

  if (change.dependabot !== undefined && change.dependabot !== has.dependabot) {
    files.push({ path: '.github/dependabot.yml', content: change.dependabot ? dependabotYml(stack) : null });
    catalog = change.dependabot
      ? catalog.replace(/(^ {4}everesto\.live\/image:.*\n)/m, `$1${ANNOTATION.dependabot()}`)
      : catalog.replace(ANNOTATION_RE.dependabot, '');
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
  const { project, sonarKey } = await appInfo(token, repo);
  if (PROTECTED_SYSTEMS.includes(project)) throw Object.assign(new Error(`${repo} is part of the platform (${project}) — it cannot be deleted from Backstage`), { status: 403 });
  if (!allowed(refs, project, ['owners'])) {
    throw Object.assign(new Error(`only owners of ${project} can delete its applications`), { status: 403 });
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
    warn.push(`run on the control plane (Backstage has no cluster access) — removes dev + prod pods, the secret stores and the (now invalid) ESO login: sudo kubectl -n argocd delete application ${repo}-dev ${repo}-prod --ignore-not-found && sudo kubectl delete clustersecretstore infisical-${repo}-dev infisical-${repo}-prod --ignore-not-found && sudo kubectl -n external-secrets delete secret infisical-${repo}-auth --ignore-not-found`);
    const inf = await infisicalDelete(config, repo);
    done.push(...inf.done);
    warn.push(...inf.warn);
  }

  await unregister(repo).then(() => done.push('catalog entry'), e => warn.push(`catalog: ${e}`));

  const del = await gh(token, 'DELETE', `/repos/${OWNER}/${repo}`);
  if (!del.ok) throw new Error(`GitHub: cannot delete repo ${repo} (${del.status}) — done so far: ${done.join(', ')}`);
  done.push(`GitHub repo ${OWNER}/${repo} (with its Actions + secrets)`);

  warn.push(`container images ghcr.io/everesto-inc/${repo} — delete in GitHub → Packages (the GitHub App can't)`);
  return { done, warn };
}
