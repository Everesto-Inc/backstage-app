import { parse } from 'yaml';
import { LOOP, ciYml, dependabotYml, isLoopV11, normalizeCi, readSwitches, runnerFor, setSwitch, testCommandOf } from './everestoLoop';

const SW = { tests: true, semgrep: false, sonarqube: true, trivy: 'enforce' as const };

describe('Loop v1.1 ci.yml', () => {
  const ci = ciYml('maas-backend', 'python', SW, runnerFor(true));

  it('is valid YAML calling pipeline.yml at the pinned release with the switches', () => {
    const y = parse(ci);
    expect(y.jobs.loop.uses).toBe(`Everesto-Inc/loop/.github/workflows/pipeline.yml@${LOOP.sha}`);
    expect(y.jobs.loop.with).toEqual({ stack: 'python', runner: 'ubuntu-24.04-arm', tests: true, semgrep: false, sonarqube: true, trivy: 'enforce' });
    expect(y.jobs.loop.secrets).toEqual({ SONAR_TOKEN: '${{ secrets.SONAR_TOKEN }}' });
    expect(ci).not.toContain('secrets: inherit');
    expect(y.jobs.loop.permissions).toEqual({ contents: 'read', packages: 'write' });
    expect(isLoopV11(ci)).toBe(true);
  });

  it('keeps GitHub expressions literal', () => {
    expect(ci).toContain("group: ci-${{ github.event_name == 'pull_request' && github.ref || github.sha }}");
  });

  it('private repos build on x86 (arm runners are free for public repos only)', () => {
    expect(runnerFor(false)).toBe('ubuntu-latest');
  });

  it('reads the switches back', () => {
    expect(readSwitches(ci)).toEqual(SW);
  });

  it('flips one switch and nothing else', () => {
    const next = setSwitch(ci, 'semgrep', true);
    expect(readSwitches(next)).toEqual({ ...SW, semgrep: true });
    expect(next.replace('semgrep: true', 'semgrep: false')).toBe(ci);
    expect(readSwitches(setSwitch(ci, 'trivy', 'report')).trivy).toBe('report');
  });

  it('adds a missing switch under stack:', () => {
    const noTests = ci.replace(/\n {6}tests: true/, '');
    expect(readSwitches(setSwitch(noTests, 'tests', false)).tests).toBe(false);
  });

  it('refuses a v1.0 pipeline', () => {
    expect(() => setSwitch('jobs:\n  guard:\n    uses: Everesto-Inc/loop/.github/workflows/guard.yml@x\n', 'tests', true)).toThrow(/v1.1/);
  });
});

describe('dependabotYml', () => {
  it('has the language ecosystem only when there is one', () => {
    expect(parse(dependabotYml('python')).updates.map((u: any) => u['package-ecosystem'])).toEqual(['pip', 'docker', 'github-actions']);
    expect(parse(dependabotYml('docker')).updates.map((u: any) => u['package-ecosystem'])).toEqual(['docker', 'github-actions']);
  });
  it('adds npm for a Node / React repo on the docker stack (package.json)', () => {
    expect(parse(dependabotYml('docker', { npm: true })).updates.map((u: any) => u['package-ecosystem'])).toEqual(['npm', 'docker', 'github-actions']);
    expect(parse(dependabotYml('java', { npm: true })).updates[0]['package-ecosystem']).toBe('maven'); // the stack's own wins
  });
  it('never proposes a new Python / Node / Java version of a base image', () => {
    const docker = parse(dependabotYml('python')).updates.find((u: any) => u['package-ecosystem'] === 'docker');
    expect(docker.ignore).toEqual([{ 'dependency-name': '*', 'update-types': ['version-update:semver-major', 'version-update:semver-minor'] }]);
  });
});

describe('normalizeCi', () => {
  const OLD = 'e394b20eb4ff123bbb0a9362c5de98d756b32a22';
  const old = ciYml('maas-backend', 'python', SW, 'ubuntu-latest')
    .replace(/ {4}secrets:\n {6}SONAR_TOKEN:.*\n/, '    secrets: inherit\n')
    .replace(`@${LOOP.sha} # ${LOOP.version}`, `@${OLD} # v1.1.0`)
    .replace(/^ {2}# pull requests:.*\n {2}group: .*$/m, '  group: ci-${{ github.ref }}');
  it('replaces secrets: inherit and bumps the v1.1 patch release', () => {
    const r = normalizeCi(old);
    expect(parse(r.ci).jobs.loop.secrets).toEqual({ SONAR_TOKEN: '${{ secrets.SONAR_TOKEN }}' });
    expect(r.ci).toContain(`pipeline.yml@${LOOP.sha} # ${LOOP.version}`);
    expect(r.done).toEqual(['pass only SONAR_TOKEN to Loop (no more `secrets: inherit`)', 'runs on main are never cancelled any more', `Loop v1.1.0 → ${LOOP.version}`]);
    expect(r.ci).toBe(ciYml('maas-backend', 'python', SW, 'ubuntu-latest'));
    expect(readSwitches(r.ci)).toEqual(SW);
  });
  it('leaves a current file alone', () => {
    const cur = ciYml('a', 'python', SW, 'ubuntu-latest');
    expect(normalizeCi(cur)).toEqual({ ci: cur, done: [] });
  });
  it('never jumps to another minor version', () => {
    const other = ciYml('a', 'python', SW, 'ubuntu-latest').replace(`# ${LOOP.version}`, '# v1.2.0');
    expect(normalizeCi(other).done).toEqual([]);
  });
});

describe('test-command survives a (re)import', () => {
  const own = ciYml('agency-frontend', 'docker', SW, runnerFor(true), 'bash ci/test.sh   # typecheck + tests');
  it('is read from an existing Loop ci.yml', () => {
    expect(testCommandOf(own)).toBe('bash ci/test.sh   # typecheck + tests');
    expect(testCommandOf(ciYml('x', 'python', SW, runnerFor(true)))).toBeUndefined();
    expect(testCommandOf(undefined)).toBeUndefined();
  });
  it('is written back into the generated ci.yml (valid YAML, right place)', () => {
    const y = parse(ciYml('agency-frontend', 'docker', SW, runnerFor(true), testCommandOf(own)));
    expect(y.jobs.loop.with['test-command']).toBe('bash ci/test.sh');
    expect(Object.keys(y.jobs.loop.with)).toEqual(['stack', 'runner', 'tests', 'test-command', 'semgrep', 'sonarqube', 'trivy']);
  });
});
