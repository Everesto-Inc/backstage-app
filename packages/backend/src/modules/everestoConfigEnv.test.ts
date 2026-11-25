import { checkConfigVars, editableReason, readConfigEnv, setConfigEnv } from './everestoConfigEnv';
import { deployment } from './everestoManifests';

const base = { secrets: [], port: 8080, memoryMi: 128, replicas: 1, healthPath: '/healthz' };
const gen = (config: { name: string; value: string }[]) => deployment('web', 'ghcr.io/everesto-inc/web', 'orchid', 'dev', { ...base, config });

describe('config env of a generated deployment', () => {
  it('reads the env block (also hand-written lines with a trailing comment)', () => {
    expect(readConfigEnv(gen([{ name: 'API_URL', value: 'https://a-dev.everesto.live' }, { name: 'LOG_LEVEL', value: 'info' }])))
      .toEqual([{ name: 'API_URL', value: 'https://a-dev.everesto.live' }, { name: 'LOG_LEVEL', value: 'info' }]);
    expect(readConfigEnv(gen([]))).toEqual([]);
    const hand = gen([]).replace('          envFrom:', '          env:   # config\n            - { name: API_URL, value: "https://x" }   # comment\n          envFrom:');
    expect(readConfigEnv(hand)).toEqual([{ name: 'API_URL', value: 'https://x' }]);
  });

  it('replaces / adds / removes the block right before envFrom, round-trips quotes', () => {
    const y = setConfigEnv(gen([{ name: 'OLD', value: '1' }]), [{ name: 'A', value: 'say "hi"' }, { name: 'B', value: '' }]);
    expect(readConfigEnv(y)).toEqual([{ name: 'A', value: 'say "hi"' }, { name: 'B', value: '' }]);
    expect(y).not.toContain('OLD');
    expect(y.indexOf('          env:')).toBeLessThan(y.indexOf('          envFrom:'));
    const none = setConfigEnv(y, []);
    expect(none).not.toContain('          env:');
    expect(none).toBe(gen([]));
    expect(setConfigEnv(gen([]), [{ name: 'X', value: 'y' }])).toBe(setConfigEnv(gen([{ name: 'Z', value: '1' }]), [{ name: 'X', value: 'y' }]));
  });

  it('only edits the generated single-container shape', () => {
    expect(editableReason(gen([]))).toBeUndefined();
    expect(editableReason(`${gen([])}---\n${gen([])}`)).toMatch(/single/);
    expect(editableReason(gen([]).replace('          envFrom:\n', ''))).toMatch(/envFrom/);
  });

  it('validates names, duplicates and values', () => {
    expect(checkConfigVars([{ name: 'A_1', value: 'x' }])).toEqual([{ name: 'A_1', value: 'x' }]);
    expect(() => checkConfigVars([{ name: 'bad', value: '' }])).toThrow(/invalid variable name/);
    expect(() => checkConfigVars([{ name: 'A', value: '' }, { name: 'A', value: '' }])).toThrow(/twice/);
    expect(() => checkConfigVars([{ name: 'A', value: 'a\nb' }])).toThrow(/one line/);
    expect(() => checkConfigVars('nope')).toThrow(/list/);
  });
});
