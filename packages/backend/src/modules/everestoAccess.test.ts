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
