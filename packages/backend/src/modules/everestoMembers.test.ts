import { canManageRole, groupMembers, setGroupMembers } from './everestoMembers';

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

describe('canManageRole', () => {
  it('owner may set every role', () => {
    expect(canManageRole(['group:default/platform-team'], 'orchid', 'managers', 'blackbuck')).toBe(true);
  });
  it('managers and entity managers add developers/viewers, not maintainers/managers', () => {
    for (const refs of [['group:default/orchid-managers'], ['group:default/blackbuck-admins']]) {
      expect(canManageRole(refs, 'orchid', 'developers', 'blackbuck')).toBe(true);
      expect(canManageRole(refs, 'orchid', 'viewers', 'blackbuck')).toBe(true);
      expect(canManageRole(refs, 'orchid', 'maintainers', 'blackbuck')).toBe(false);
      expect(canManageRole(refs, 'orchid', 'managers', 'blackbuck')).toBe(false);
    }
  });
  it('maintainers and developers cannot manage members; no crossing spaces', () => {
    expect(canManageRole(['group:default/orchid-maintainers'], 'orchid', 'developers', 'blackbuck')).toBe(false);
    expect(canManageRole(['group:default/lily-managers'], 'orchid', 'developers', 'blackbuck')).toBe(false);
    expect(canManageRole(['group:default/okapi-admins'], 'orchid', 'developers', 'blackbuck')).toBe(false);
  });
});
