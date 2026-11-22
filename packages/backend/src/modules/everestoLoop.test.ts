import { parse } from 'yaml';
import { LOOP, ciYml, dependabotYml, isLoopV11, readSwitches, runnerFor, setSwitch } from './everestoLoop';

const SW = { tests: true, semgrep: false, sonarqube: true, trivy: 'enforce' as const };

describe('Loop v1.1 ci.yml', () => {
  const ci = ciYml('maas-backend', 'python', SW, runnerFor(true));

  it('is valid YAML calling pipeline.yml at the pinned release with the switches', () => {
    const y = parse(ci);
    expect(y.jobs.loop.uses).toBe(`Everesto-Inc/loop/.github/workflows/pipeline.yml@${LOOP.sha}`);
    expect(y.jobs.loop.with).toEqual({ stack: 'python', runner: 'ubuntu-24.04-arm', tests: true, semgrep: false, sonarqube: true, trivy: 'enforce' });
    expect(y.jobs.loop.secrets).toBe('inherit');
    expect(y.jobs.loop.permissions).toEqual({ contents: 'read', packages: 'write' });
    expect(isLoopV11(ci)).toBe(true);
  });

  it('keeps GitHub expressions literal', () => {
    expect(ci).toContain('group: ci-${{ github.ref }}');
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
});
