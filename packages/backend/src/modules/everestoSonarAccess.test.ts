import { desiredGroups, desiredProjectPermissions, diff } from './everestoSonarAccess';

const space = {
  name: 'orchid',
  members: { developers: ['nanu'], maintainers: ['babu'], managers: ['adminbob575', 'babu'] },
  viewers: ['vic'],
  ciRepos: [], gitopsRepos: [], sonarProjects: ['python-backend'],
};

describe('SonarQube access from space roles', () => {
  it('one group per role, members from the space', () => {
    expect(desiredGroups(space as any)).toEqual({
      'orchid-viewers': ['vic'], 'orchid-developers': ['nanu'], 'orchid-maintainers': ['babu'], 'orchid-managers': ['adminbob575', 'babu'],
    });
  });

  it('viewers/developers read; maintainers/managers administer', () => {
    const p = desiredProjectPermissions(space as any);
    expect(p['orchid-developers']).toEqual(['user', 'codeviewer']);
    expect(p['orchid-viewers']).toEqual(['user', 'codeviewer']);
    expect(p['orchid-maintainers']).toContain('admin');
    expect(p['orchid-managers']).toContain('issueadmin');
  });

  it('diff: adds what is missing, removes what is extra (sonar-users loses everything)', () => {
    const { add, remove } = diff(
      { 'orchid-developers': ['user', 'codeviewer'], 'sonar-users': [] },
      { 'orchid-developers': ['user'], 'sonar-users': ['user', 'codeviewer'], 'sonar-administrators': ['admin'] },
    );
    expect(add).toEqual([['orchid-developers', 'codeviewer']]);
    expect(remove).toEqual([['sonar-users', 'user'], ['sonar-users', 'codeviewer']]);
    // groups not managed by Backstage (sonar-administrators) are never touched
    expect(remove.some(([g]) => g === 'sonar-administrators')).toBe(false);
  });
});
