import { permissionFor, rulesetBody } from './everestoAccess';

describe('permissionFor', () => {
  it('developers push code, maintainers/owners maintain — nobody is admin', () => {
    expect(permissionFor('developers', 'ci')).toBe('push');
    expect(permissionFor('maintainers', 'ci')).toBe('maintain');
    for (const r of ['developers', 'maintainers'] as const) {
      for (const k of ['ci', 'gitops'] as const) expect(permissionFor(r, k)).not.toBe('admin');
    }
  });
  it('developers get no write on gitops (deployments go through Backstage)', () => {
    expect(permissionFor('developers', 'gitops')).toBeUndefined();
    expect(permissionFor('maintainers', 'gitops')).toBe('push');
  });
});

describe('rulesetBody', () => {
  const r = rulesetBody(123);
  it('protects the default branch: PR only, no force-push, no deletion', () => {
    expect(r.conditions.ref_name.include).toEqual(['~DEFAULT_BRANCH']);
    expect(r.rules.map(x => x.type).sort()).toEqual(['deletion', 'non_fast_forward', 'pull_request']);
    expect(r.enforcement).toBe('active');
  });
  it('only the Backstage app and org admins can bypass', () => {
    expect(r.bypass_actors).toEqual([
      { actor_id: 123, actor_type: 'Integration', bypass_mode: 'always' },
      { actor_id: 1, actor_type: 'OrganizationAdmin', bypass_mode: 'always' },
    ]);
  });
});

describe('expandEntityAdmins', () => {
  const spacesOf = async (entity: string) => (entity === 'blackbuck' ? ['orchid', 'lotus'] : []);
  it('makes an entity admin maintainer of every space of THAT entity', async () => {
    const refs = await (await import('./everestoAccess')).expandEntityAdmins(['group:default/blackbuck-admins'], spacesOf);
    expect(refs).toEqual(expect.arrayContaining(['group:default/orchid-maintainers', 'group:default/lotus-maintainers']));
  });
  it('adds nothing for other groups, and never crosses entities', async () => {
    const { expandEntityAdmins } = await import('./everestoAccess');
    expect(await expandEntityAdmins(['group:default/orchid-developers'], spacesOf)).toEqual(['group:default/orchid-developers']);
    expect(await expandEntityAdmins(['group:default/okapi-admins'], spacesOf)).toEqual(['group:default/okapi-admins']);
  });
});
