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
export const LOOP = { sha: 'e394b20eb4ff123bbb0a9362c5de98d756b32a22', version: 'v1.1.0' } as const;

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

/** Free GitHub arm64 runners are for public repos only — private repos build arm64 with QEMU on x86. */
export const runnerFor = (isPublic: boolean) => (isPublic ? 'ubuntu-24.04-arm' : 'ubuntu-latest');

/** The whole ci.yml of an application on Loop v1.1. */
export function ciYml(repo: string, stack: Stack, sw: Switches, runner: string) {
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
  group: ci-\${{ github.ref }}
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
      semgrep: ${sw.semgrep}
      sonarqube: ${sw.sonarqube}
      trivy: ${sw.trivy}
    secrets: inherit
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

/** Pure: the default Dependabot config for a stack (plus Docker + GitHub Actions updates). */
export function dependabotYml(stack: Stack) {
  const lang = ({ java: 'maven', python: 'pip' } as Record<string, string | undefined>)[stack];
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
  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: monthly }
    cooldown: { default-days: 7 }
`;
}
