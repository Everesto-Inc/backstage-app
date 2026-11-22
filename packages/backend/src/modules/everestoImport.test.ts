import { parse } from 'yaml';
import { addTarget, catalogInfo, locationYaml, prBody } from './everestoImport';
import { LOOP } from './everestoLoop';

const IN = { repo: 'maas-backend', stack: 'python' as const, tests: false, semgrep: false, sonarqube: true, dependabot: true, trivy: 'enforce' as const };

describe('import: catalog-info.yaml', () => {
  it('puts the app in the space with the Loop annotations', () => {
    const y = parse(catalogInfo('maas-backend', 'orchid', 'MaaS API', IN, false));
    expect(y.spec).toMatchObject({ owner: 'orchid', system: 'orchid', type: 'service' });
    expect(y.metadata.annotations).toMatchObject({
      'github.com/project-slug': 'Everesto-Inc/maas-backend',
      'everesto.live/image': 'ghcr.io/everesto-inc/maas-backend',
      'everesto.live/loop': LOOP.version,
      'everesto.live/trivy': 'on',
      'sonarqube.org/project-key': 'maas-backend',
      'everesto.live/dependabot': 'on',
    });
    expect(y.metadata.annotations['everesto.live/semgrep']).toBeUndefined();
    expect(y.metadata.annotations['everesto.live/tests']).toBe('off');
    expect(y.metadata.annotations['backstage.io/techdocs-ref']).toBeUndefined();
  });
  it('marks Trivy report mode', () => {
    expect(parse(catalogInfo('a', 'orchid', '', { ...IN, trivy: 'report' }, true)).metadata.annotations['everesto.live/trivy']).toBe('report');
  });
});

describe('import: catalog location', () => {
  it('is optional until the PR is merged', () => {
    const y = parse(locationYaml('maas-backend', 'main'));
    expect(y.spec).toEqual({ type: 'url', presence: 'optional', target: 'https://github.com/Everesto-Inc/maas-backend/blob/main/catalog-info.yaml' });
  });
  const ALL = 'kind: Location\nspec:\n  targets:\n    - ./platform/org.yaml   # x\n    - ./spaces/orchid.yaml\n';
  it('adds the target once, with the same indentation, keeping the rest', () => {
    const once = addTarget(ALL, 'maas-backend');
    expect(parse(once).spec.targets).toEqual(['./platform/org.yaml', './spaces/orchid.yaml', './apps/maas-backend.yaml']);
    expect(addTarget(once, 'maas-backend')).toBe(once);
    expect(once).toContain('# x');
  });
});

describe('import: pull request text', () => {
  it('lists switches and the removed workflows', () => {
    const body = prBody('maas-backend', 'orchid', IN, ['.github/workflows/backend-ci.yml'], true);
    expect(body).toContain('`.github/workflows/backend-ci.yml`');
    expect(body).toContain('replaced (old version stays in git history)');
    expect(body).toContain('SonarQube | on');
  });
});
