import { allowed, editCiTools, isProtected } from './everestoManage';

const SHA = 'd288ef304e4f10102727004981f3855ba9fcccf1';
const CI = `jobs:
  ci:
    steps:
      - name: Tests + coverage
        uses: Everesto-Inc/loop/stages/install@${SHA} # v1.0.0
        with: { stack: python }

      - name: Code security (Semgrep)
        uses: Everesto-Inc/loop/stages/semgrep@${SHA} # v1.0.0

      - name: Quality gate (SonarQube)
        uses: Everesto-Inc/loop/stages/sonarqube@${SHA} # v1.0.0
        with: { token: '\${{ secrets.SONAR_TOKEN }}' }

      - name: Build + scan image (Trivy)
        id: image
        uses: Everesto-Inc/loop/stages/build-image@${SHA} # v1.0.0
`;
const CATALOG = `metadata:
  annotations:
    everesto.live/image: ghcr.io/everesto-inc/app
    sonarqube.org/project-key: app
    everesto.live/semgrep: "on"
spec:
  system: orchid
`;
const HAS = { semgrep: true, sonarqube: true };

describe('allowed', () => {
  it('lets platform-team do everything', () => {
    expect(allowed(['group:default/platform-team'], 'orchid', ['owners'])).toBe(true);
  });
  it('separates maintainer (create) from manager (prod)', () => {
    const maint = ['group:default/orchid-maintainers'];
    const mgr = ['group:default/orchid-managers'];
    expect(allowed(maint, 'orchid', ['managers', 'maintainers'])).toBe(true);
    expect(allowed(maint, 'orchid', ['managers'])).toBe(false);
    expect(allowed(mgr, 'orchid', ['managers'])).toBe(true);
    expect(allowed([...maint, ...mgr], 'orchid', ['managers'])).toBe(true); // both ticks = union
    expect(allowed(['group:default/orchid-developers'], 'orchid', ['managers', 'maintainers'])).toBe(false);
  });

  it('checks the role inside the project', () => {
    const refs = ['group:default/orchid-maintainers'];
    expect(allowed(refs, 'orchid', ['owners', 'maintainers'])).toBe(true);
    expect(allowed(refs, 'orchid', ['owners'])).toBe(false);
  });
  it('never crosses projects', () => {
    expect(allowed(['group:default/lotus-owners'], 'orchid', ['owners'])).toBe(false);
  });
});

describe('isProtected', () => {
  it('detects the platform annotation', () => {
    expect(isProtected('    everesto.live/protected: "true"\n')).toBe(true);
    expect(isProtected("    everesto.live/protected: 'true'\n")).toBe(true);
    expect(isProtected('    everesto.live/protected: "false"\n')).toBe(false);
    expect(isProtected(CATALOG)).toBe(false);
  });
});

describe('editCiTools', () => {
  it('removes SonarQube: step and annotation go, nothing else changes', () => {
    const r = editCiTools(CI, CATALOG, { sonarqube: false }, HAS, 'app', SHA, 'v1.0.0');
    expect(r.ci).not.toContain('Quality gate (SonarQube)');
    expect(r.ci).toContain('Code security (Semgrep)');
    expect(r.ci).toContain('Build + scan image (Trivy)');
    expect(r.ci).not.toMatch(/\n{3,}/);
    expect(r.catalog).not.toContain('sonarqube.org/project-key');
    expect(r.catalog).toContain('everesto.live/semgrep');
    expect(r.done).toEqual(['remove sonarqube']);
  });

  it('remove then add gives back the identical files', () => {
    const removed = editCiTools(CI, CATALOG, { sonarqube: false, semgrep: false }, HAS, 'app', SHA, 'v1.0.0');
    const back = editCiTools(removed.ci, removed.catalog, { sonarqube: true, semgrep: true }, { semgrep: false, sonarqube: false }, 'app', SHA, 'v1.0.0');
    expect(back.ci).toBe(CI);
    expect(back.done).toEqual(['add semgrep', 'add sonarqube']);
  });

  it('does nothing when the state already matches', () => {
    const r = editCiTools(CI, CATALOG, { sonarqube: true, semgrep: true }, HAS, 'app', SHA, 'v1.0.0');
    expect(r.ci).toBe(CI);
    expect(r.catalog).toBe(CATALOG);
    expect(r.done).toEqual([]);
  });
});
