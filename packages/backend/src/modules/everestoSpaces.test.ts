import { FLOWERS, SPACE_NAME, addToAll, spaceNameProblem, spaceYaml } from './everestoSpaces';

describe('spaces', () => {
  it('name rules give a reason a person understands', () => {
    expect(spaceNameProblem('lotus', [])).toBeUndefined();
    expect(spaceNameProblem('Lotus', [])).toContain('lowercase');
    expect(spaceNameProblem('l', [])).toContain('2–24');
    expect(spaceNameProblem('platform', [])).toContain('reserved');
    expect(spaceNameProblem('orchid', ['orchid'])).toContain('already used');
  });

  it('every suggested flower is a valid name, no duplicates', () => {
    expect(FLOWERS.every(f => SPACE_NAME.test(f))).toBe(true);
    expect(new Set(FLOWERS).size).toBe(FLOWERS.length);
  });

  it('space file: System in the entity + team + 4 role groups', () => {
    const y = spaceYaml('sea-lily', 'blackbuck', 'payments team', 'jacer7');
    expect(y).toContain('kind: System\nmetadata:\n  name: sea-lily\n  title: DevOps Space – Sea Lily');
    expect(y).toContain('  domain: blackbuck');
    expect(y).toContain('  parent: blackbuck');
    for (const r of ['managers', 'maintainers', 'developers', 'viewers']) expect(y).toContain(`  name: sea-lily-${r}\n`);
    expect(y.split('\n---\n')).toHaveLength(7); // header comment + System + team + 4 roles
  });

  it('all.yaml: added after the last space, idempotent', () => {
    const all = 'spec:\n  targets:\n    - ./entities/blackbuck.yaml    # e\n    - ./spaces/orchid.yaml         # s\n    - ./templates/x.yaml\n';
    const out = addToAll(all, 'lotus');
    expect(out.split('\n')[4]).toMatch(/^ {4}- \.\/spaces\/lotus\.yaml +# space/);
    expect(addToAll(out, 'lotus')).toBe(out);
  });
});
