/**
 * Loop v1.1 — an app's ci.yml is ONE call of Everesto-Inc/loop/.github/workflows/pipeline.yml with switches.
 * Pure functions (no I/O): generate the file, read the switches, flip one switch. Tested in everestoLoop.test.ts.
 *
 *   jobs:
 *     loop:
 *       uses: Everesto-Inc/loop/.github/workflows/pipeline.yml@<sha> # v1.1.0
 *       with:
 *         stack: python
 *         tests: true
 *         semgrep: false
 *         sonarqube: true
 *         trivy: enforce
 *
 * v1.0 pipelines (stage by stage) keep working — everestoManage edits those the old way.
 */
import { err } from './everestoCommon';

/** The Loop release new and imported pipelines use — bump with each Loop release. */
export const LOOP = { sha: '4d70c4efcdad7bd522d60fe13d6c324a83fe0936', version: 'v1.1.2' } as const;

export type Stack = 'python' | 'java' | 'docker';
export const STACKS: Stack[] = ['python', 'java', 'docker'];
export type Trivy = 'enforce' | 'report';
export type Switches = { tests: boolean; semgrep: boolean; sonarqube: boolean; trivy: Trivy };
type BoolSwitch = 'tests' | 'semgrep' | 'sonarqube';

const USES = /uses: Everesto-Inc\/loop\/\.github\/workflows\/pipeline\.yml@([0-9a-f]{40}) # (\S+)/;
export const isLoopV11 = (ci: string | undefined) => !!ci && USES.test(ci);
export const loopRef = (ci: string) => {
  const m = ci.match(USES);
  return m ? { sha: m[1], version: m[2] } : undefined;
};

const MAIN_NEVER_CANCELLED = "  # pull requests: a newer push cancels the older run · main: every commit finishes (each one publishes an image)\n"
  + "  group: ci-${{ github.event_name == 'pull_request' && github.ref || github.sha }}";

/**
 * Pure: bring an existing v1.1.x ci.yml up to the current release — run by Edit pipeline on every save.
 *   - `secrets: inherit` → only SONAR_TOKEN (Semgrep: yaml.github-actions.security.secrets-inherit)
 *   - Loop v1.1.<old> → LOOP (same minor only; a new minor is an upgrade the team decides)
 *   - runs on main never cancelled (concurrency group per commit on main, per ref on pull requests)
 */
export function normalizeCi(ciIn: string) {
  let ci = ciIn;
  const done: string[] = [];
  if (/^ {4}secrets: inherit *$/m.test(ci)) {
    ci = ci.replace(/^ {4}secrets: inherit *$/m, '    secrets:\n      SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}   # only what Loop needs — never `inherit` (least privilege)');
    done.push('pass only SONAR_TOKEN to Loop (no more `secrets: inherit`)');
  }
  const oldGroup = /^ {2}group: ci-\$\{\{ github\.ref \}\} *$/m;
  if (oldGroup.test(ci)) {
    ci = ci.replace(oldGroup, MAIN_NEVER_CANCELLED);
    done.push('runs on main are never cancelled any more');
  }
  const ref = loopRef(ci);
  const minor = (v: string) => v.split('.').slice(0, 2).join('.');
  if (ref && ref.sha !== LOOP.sha && minor(ref.version) === minor(LOOP.version)) {
    ci = ci.replace(USES, `uses: Everesto-Inc/loop/.github/workflows/pipeline.yml@${LOOP.sha} # ${LOOP.version}`);
    done.push(`Loop ${ref.version} → ${LOOP.version}`);
  }
  return { ci, done };
}

/** Free GitHub arm64 runners are for public repos only — private repos build arm64 with QEMU on x86. */
export const runnerFor = (isPublic: boolean) => (isPublic ? 'ubuntu-24.04-arm' : 'ubuntu-latest');

/** The whole ci.yml of an application on Loop v1.1. */
/** Pure: the `test-command:` of an existing Loop ci.yml (kept when a repo is (re)imported). */
export function testCommandOf(ci: string | undefined): string | undefined {
  return ci?.match(/^ {6}test-command: *(.+?) *$/m)?.[1];
}

export function ciYml(repo: string, stack: Stack, sw: Switches, runner: string, testCommand?: string) {
  return `# CI for ${repo} — managed by Backstage (Edit pipeline flips the switches below), built on Loop.
# Every run ends with a scanned linux/arm64 image: ghcr.io/everesto-inc/${repo} (pushed from main only).
# Gitleaks, Trivy scans and the image build always run. Add own jobs below with \`needs: loop\`.
name: CI

on:
  push:
    branches: [main]
    paths-ignore: ['docs/**', 'mkdocs.yml', 'catalog-info.yaml', '*.md']   # docs/settings only → no rebuild
  pull_request:
  workflow_dispatch:

concurrency:
  # pull requests: a newer push cancels the older run · main: every commit finishes (each one publishes an image)
  group: ci-\${{ github.event_name == 'pull_request' && github.ref || github.sha }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  loop:
    uses: Everesto-Inc/loop/.github/workflows/pipeline.yml@${LOOP.sha} # ${LOOP.version}
    with:
      stack: ${stack}
      runner: ${runner}
      tests: ${sw.tests}
${testCommand ? `      test-command: ${testCommand}\n` : ''}      semgrep: ${sw.semgrep}
      sonarqube: ${sw.sonarqube}
      trivy: ${sw.trivy}
    secrets:
      SONAR_TOKEN: \${{ secrets.SONAR_TOKEN }}   # only what Loop needs — never \`inherit\` (least privilege)
    permissions:
      contents: read
      packages: write        # push + keep the last 5 images in ghcr.io
`;
}

const lineRe = (key: string) => new RegExp(`^( {6})${key}: *(\\S+) *$`, 'm');

/** Current switches of a v1.1 ci.yml (missing key = Loop's default). */
export function readSwitches(ci: string): Switches {
  const get = (k: string) => ci.match(lineRe(k))?.[2];
  return {
    tests: get('tests') !== 'false',
    semgrep: get('semgrep') === 'true',
    sonarqube: get('sonarqube') === 'true',
    trivy: get('trivy') === 'report' ? 'report' : 'enforce',
  };
}

/** ci.yml with one switch set (added under `stack:` when missing). Everything else untouched. */
export function setSwitch(ci: string, key: BoolSwitch | 'trivy', value: boolean | Trivy): string {
  if (!isLoopV11(ci)) throw err(409, 'pipeline is not on Loop v1.1 — upgrade it first');
  const re = lineRe(key);
  if (re.test(ci)) return ci.replace(re, `$1${key}: ${value}`);
  const stack = lineRe('stack');
  if (!stack.test(ci)) throw err(409, 'ci.yml was changed by hand (no `stack:` in the Loop call) — edit it by hand');
  return ci.replace(stack, m => `${m}\n      ${key}: ${value}`);
}

/** Pure: the default Dependabot config for a stack (plus Docker + GitHub Actions updates).
 *  `npm`: the repo has a package.json (e.g. React on stack docker) → npm updates too. */
export function dependabotYml(stack: Stack, opts: { npm?: boolean } = {}) {
  const lang = ({ java: 'maven', python: 'pip' } as Record<string, string | undefined>)[stack] ?? (opts.npm ? 'npm' : undefined);
  return `version: 2
updates:
${lang ? `  - package-ecosystem: ${lang}
    directory: /
    schedule: { interval: weekly }
    cooldown: { default-days: 7 }   # don't propose versions younger than 7 days
    open-pull-requests-limit: 5
` : ''}  - package-ecosystem: docker
    directory: /
    schedule: { interval: weekly }
    cooldown: { default-days: 7 }
    ignore:   # base images: patch + security only — a new Python / Node / Java version is a deliberate, tested change
      - dependency-name: "*"
        update-types: ["version-update:semver-major", "version-update:semver-minor"]
  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: monthly }
    cooldown: { default-days: 7 }
`;
}
