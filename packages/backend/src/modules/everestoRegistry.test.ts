import { baseRepo, parseRegistry, setRegistryEntry } from './everestoRegistry';
import { guardEntity, repoOfTarget } from './everestoCatalogGuard';

const REG = `# Which DevOps Space owns which repository — written by Backstage only.
apps:
  python-backend: orchid   # first app
  loop: loop
`;

describe('app registry', () => {
  it('reads repo → space, ignores junk', () => {
    expect(parseRegistry(REG)).toEqual({ 'python-backend': 'orchid', loop: 'loop' });
    expect(parseRegistry('apps:\n  "Bad Name": x\n  ok: "../etc"\n')).toEqual({});
    expect(parseRegistry(undefined)).toEqual({});
  });
  it('adds / removes an entry, comments kept', () => {
    const added = setRegistryEntry(REG, 'java-api', 'lily');
    expect(parseRegistry(added)).toEqual({ 'python-backend': 'orchid', loop: 'loop', 'java-api': 'lily' });
    expect(added).toContain('# first app');
    expect(parseRegistry(setRegistryEntry(added, 'java-api', undefined))).toEqual(parseRegistry(REG));
  });
  it('the -gitops twin belongs to the same space', () => {
    expect(baseRepo('python-backend-gitops')).toBe('python-backend');
  });
});

describe('catalog guard', () => {
  const registry = { 'python-backend': 'orchid' };
  const app = (system: string, kind = 'Component') => ({ apiVersion: 'backstage.io/v1alpha1', kind, metadata: { name: 'python-backend' }, spec: { type: 'service', owner: system, system } });

  it('ATTACK: a repo claiming another space is put back into its registered space', () => {
    const out = guardEntity(app('lily'), repoOfTarget('https://github.com/Everesto-Inc/python-backend/blob/main/catalog-info.yaml'), registry);
    expect(out.entity.spec?.system).toBe('orchid');
    expect(out.entity.spec?.owner).toBe('orchid');
    expect(out.changedFrom).toBe('lily');
  });
  it('the -gitops Resource in the same file follows the app', () => {
    expect(guardEntity(app('lily', 'Resource'), 'python-backend', registry).entity.spec?.system).toBe('orchid');
  });
  it('honest entities and the platform catalog are untouched', () => {
    expect(guardEntity(app('orchid'), 'python-backend', registry).changedFrom).toBeUndefined();
    expect(guardEntity(app('backstage'), 'everesto-catalog', registry).entity.spec?.system).toBe('backstage');
    expect(guardEntity({ ...app('lily'), kind: 'Group' }, 'python-backend', registry).entity.spec?.system).toBe('lily');
  });
  it('repo from location target', () => {
    expect(repoOfTarget('https://github.com/Everesto-Inc/Python-Backend/tree/main/catalog-info.yaml')).toBe('python-backend');
    expect(repoOfTarget('https://github.com/someone-else/x/blob/main/catalog-info.yaml')).toBeUndefined();
  });
});
