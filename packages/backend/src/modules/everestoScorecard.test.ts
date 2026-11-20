import { Facts, levelOf, scoreChecks, versionLess } from './everestoScorecard';

const perfect: Facts = {
  kind: 'ci', lastMainRun: 'success', scanners: { gitleaks: 'success', trivyDeps: 'success', trivyImage: 'success', semgrep: 'success' },
  sonar: { exists: true, analysed: true, coverage: 85 }, dependabot: true, dependabotPrAges: [2],
  loopUsed: 'v1.2.0', loopLatest: 'v1.2.0', docs: true, deployed: true,
  dev: { tag: 'sha-aaaaaaa', ageDays: 3 }, prod: { tag: 'sha-aaaaaaa', ageDays: 3 }, placeholders: { dev: 0, prod: 0 }, reviewers: 3,
};
const by = (f: Facts) => Object.fromEntries(scoreChecks(f).map(c => [c.id, c]));

describe('scorecard', () => {
  it('everything right → Gold, no fix hints', () => {
    const checks = scoreChecks(perfect);
    expect(levelOf(checks)).toBe('gold');
    expect(checks.every(c => c.fix === undefined)).toBe(true);
  });

  it('a failing scanner caps the app below Bronze, with the reason and the fix', () => {
    const f = { ...perfect, scanners: { ...perfect.scanners, trivyImage: 'failure' } };
    expect(levelOf(scoreChecks(f))).toBeUndefined();
    expect(by(f).vulns.detail).toContain('trivyImage');
    expect(by(f).vulns.fix).toContain('Security tab');
  });

  it('CHANGE_ME secrets break Bronze', () => {
    expect(by({ ...perfect, placeholders: { dev: 2, prod: 0 } }).secrets.state).toBe('fail');
  });

  it('low coverage → Bronze only', () => {
    expect(levelOf(scoreChecks({ ...perfect, sonar: { exists: true, analysed: true, coverage: 40 } }))).toBe('bronze');
  });

  it('old Loop, stale Dependabot PR, single person → Silver at most', () => {
    expect(levelOf(scoreChecks({ ...perfect, loopUsed: 'v1.1.9' }))).toBe('silver');
    expect(by({ ...perfect, dependabotPrAges: [20] }).deps.state).toBe('fail');
    expect(by({ ...perfect, reviewers: 1 }).fourEyes.state).toBe('fail');
  });

  it('prod far behind dev, or dev not deployed for a month → not fresh', () => {
    expect(by({ ...perfect, dev: { tag: 'sha-b', ageDays: 1 }, prod: { tag: 'sha-a', ageDays: 40 } }).fresh.state).toBe('fail');
    expect(by({ ...perfect, dev: { tag: 'sha-a', ageDays: 45 }, prod: undefined }).fresh.state).toBe('fail');
  });

  it('a repository without CI is judged only on what applies (n/a ≠ fail)', () => {
    const repoOnly: Facts = { kind: 'repo', scanners: {}, dependabot: false, dependabotPrAges: [], docs: true, deployed: false, reviewers: 2 };
    const c = by(repoOnly);
    expect(['ci', 'vulns', 'secrets', 'coverage', 'deps', 'loop', 'fresh'].every(id => c[id].state === 'na')).toBe(true);
    expect(levelOf(scoreChecks(repoOnly))).toBe('gold');
  });

  it('unknown is not a pass (no scan results yet)', () => {
    expect(by({ ...perfect, scanners: {} }).vulns.state).toBe('unknown');
    expect(levelOf(scoreChecks({ ...perfect, scanners: {} }))).toBeUndefined();
  });

  it('versions compare numerically', () => {
    expect(versionLess('v1.9.0', 'v1.10.0')).toBe(true);
    expect(versionLess('v2.0.0', 'v1.10.0')).toBe(false);
    expect(versionLess('v1.0', 'v1.0.0')).toBe(false);
  });
});
