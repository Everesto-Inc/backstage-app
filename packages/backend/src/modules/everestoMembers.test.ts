import { canManageRole, givableRoles, groupMembers, setGroupMembers } from './everestoMembers';

const SPACE = `apiVersion: backstage.io/v1alpha1
kind: System
metadata:
  name: orchid
---
apiVersion: backstage.io/v1alpha1
kind: Group
metadata:
  name: orchid-managers
spec:
  type: role
  members: [adminbob575]
---
apiVersion: backstage.io/v1alpha1
kind: Group
metadata:
  name: orchid-developers
spec:
  type: role
  children: []
  members: []
`;

describe('setGroupMembers / groupMembers', () => {
  it('adds to the right group only', () => {
    const out = setGroupMembers(SPACE, 'orchid-developers', m => [...m, 'nanu']);
    expect(groupMembers(out, 'orchid-developers')).toEqual(['nanu']);
    expect(groupMembers(out, 'orchid-managers')).toEqual(['adminbob575']);
  });
  it('removes and keeps the rest of the file', () => {
    const out = setGroupMembers(SPACE, 'orchid-managers', m => m.filter(x => x !== 'adminbob575'));
    expect(groupMembers(out, 'orchid-managers')).toEqual([]);
    expect(out).toContain('name: orchid-developers');
  });
  it('fails on an unknown group', () => {
    expect(() => setGroupMembers(SPACE, 'lotus-developers', m => m)).toThrow(/not found/);
  });
});

describe('who may give which role', () => {
  it('owner: every role', () => {
    expect(givableRoles(['group:default/platform-team'], 'orchid', 'blackbuck')).toEqual(['managers', 'maintainers', 'developers', 'viewers']);
  });
  it('managers and entity managers: maintainers, developers, viewers — not managers', () => {
    for (const refs of [['group:default/orchid-managers'], ['group:default/blackbuck-admins']]) {
      expect(canManageRole(refs, 'orchid', 'maintainers', 'blackbuck')).toBe(true);
      expect(canManageRole(refs, 'orchid', 'developers', 'blackbuck')).toBe(true);
      expect(canManageRole(refs, 'orchid', 'viewers', 'blackbuck')).toBe(true);
      expect(canManageRole(refs, 'orchid', 'managers', 'blackbuck')).toBe(false);
    }
  });
  it('maintainers: developers and viewers only', () => {
    expect(givableRoles(['group:default/orchid-maintainers'], 'orchid', 'blackbuck')).toEqual(['developers', 'viewers']);
  });
  it('developers, viewers and other spaces/entities: nothing', () => {
    expect(givableRoles(['group:default/orchid-developers', 'group:default/orchid-viewers'], 'orchid', 'blackbuck')).toEqual([]);
    expect(givableRoles(['group:default/lily-managers'], 'orchid', 'blackbuck')).toEqual([]);
    expect(givableRoles(['group:default/okapi-admins'], 'orchid', 'blackbuck')).toEqual([]);
  });
});
