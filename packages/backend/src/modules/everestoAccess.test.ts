import { argoRbacCsv, codeowners, expandEntityAdmins, permissionFor, rulesetBody } from './everestoAccess';

describe('permissionFor', () => {
  it('developers push code, maintainers/owners maintain — nobody is admin', () => {
    expect(permissionFor('developers', 'ci')).toBe('push');
    expect(permissionFor('maintainers', 'ci')).toBe('maintain');
    expect(permissionFor('managers', 'ci')).toBe('maintain');
    for (const r of ['developers', 'maintainers', 'managers'] as const) {
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
  it('four eyes: 1 approval, code owners, stale approvals dismissed, last pusher cannot approve', () => {
    const pr = (r.rules.find(x => x.type === 'pull_request') as any).parameters;
    expect(pr).toMatchObject({ required_approving_review_count: 1, require_code_owner_review: true, dismiss_stale_reviews_on_push: true, require_last_push_approval: true });
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
  it('makes an entity manager MANAGER of every space of THAT entity', async () => {
    const refs = await expandEntityAdmins(['group:default/blackbuck-admins'], spacesOf);
    expect(refs).toEqual(expect.arrayContaining(['group:default/orchid-managers', 'group:default/lotus-managers']));
  });
  it('adds nothing for other groups, and never crosses entities', async () => {
    expect(await expandEntityAdmins(['group:default/orchid-developers'], spacesOf)).toEqual(['group:default/orchid-developers']);
    expect(await expandEntityAdmins(['group:default/okapi-admins'], spacesOf)).toEqual(['group:default/okapi-admins']);
  });
});

describe('argoRbacCsv', () => {
  const csv = argoRbacCsv(['orchid']);
  const has = (line: string) => csv.split('\n').includes(line);
  it('developers (and maintainers): get everything, sync DEV only; managers sync prod too', () => {
    expect(has('p, role:orchid-developer, applications, sync, orchid/dev-*, allow')).toBe(true);
    expect(has('p, role:orchid-developer, applications, sync, orchid/*, allow')).toBe(false);
    expect(has('p, role:orchid-manager, applications, sync, orchid/*, allow')).toBe(true);
    expect(has('p, role:orchid-developer, applications, get, orchid/*, allow')).toBe(true);
    expect(csv).not.toMatch(/role:orchid-developer, applications, (delete|create)/);
  });
  it('maintainers may delete but not create; managers create, update, delete', () => {
    expect(has('p, role:orchid-maintainer, applications, delete, orchid/*, allow')).toBe(true);
    expect(csv).not.toMatch(/role:orchid-maintainer, applications, create/);
    expect(has('p, role:orchid-manager, applications, create, orchid/*, allow')).toBe(true);
  });
  it('maps GitHub teams to roles and owners to admin', () => {
    expect(has('g, Everesto-Inc:orchid-developers, role:orchid-developer')).toBe(true);
    expect(has('g, Everesto-Inc:platform-team, role:admin')).toBe(true);
    expect(csv).not.toContain('*/*');
  });
});

describe('codeowners', () => {
  it('CI repo: CI files and the catalog entry need a maintainer or manager', () => {
    const c = codeowners('orchid', 'ci');
    expect(c).toMatch(/^\/\.github\/ +@Everesto-Inc\/orchid-maintainers @Everesto-Inc\/orchid-managers$/m);
    expect(c).toMatch(/^\/catalog-info\.yaml +@Everesto-Inc\/orchid-maintainers/m);
  });
  it('gitops repo: prod needs a MANAGER (last match wins)', () => {
    const lines = codeowners('orchid', 'gitops').split('\n').filter(l => l && !l.startsWith('#'));
    expect(lines[0]).toMatch(/^\* +@Everesto-Inc\/orchid-maintainers/);
    expect(lines.find(l => l.startsWith('/apps/prod/'))).toMatch(/@Everesto-Inc\/orchid-managers$/);
    expect(lines.find(l => l.startsWith('/apps/prod/'))).not.toContain('maintainers');
  });
});
