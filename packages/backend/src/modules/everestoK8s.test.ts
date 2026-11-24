import { APP_LABEL, belongsTo, mergeByName } from './everestoK8s';

describe('everestoK8s app lookup', () => {
  it('finds single-container apps by app=<repo> and multi-service apps by everesto.live/app=<repo>', () => {
    expect(belongsTo({ app: 'python-backend' }, 'python-backend')).toBe(true);
    expect(belongsTo({ app: 'edge-gateway', [APP_LABEL]: 'agency-backend' }, 'agency-backend')).toBe(true);
    expect(belongsTo({ app: 'edge-gateway' }, 'agency-backend')).toBe(false);
    expect(belongsTo({ [APP_LABEL]: 'other' }, 'agency-backend')).toBe(false);
    expect(belongsTo(undefined, 'agency-backend')).toBe(false);
  });

  it('merges the two label queries by name', () => {
    const a = { items: [{ metadata: { name: 'x' } }, { metadata: { name: 'y' } }] };
    const b = { items: [{ metadata: { name: 'y' } }, { metadata: { name: 'z' } }] };
    expect(mergeByName(a, b)!.items.map(o => o.metadata.name)).toEqual(['x', 'y', 'z']);
    expect(mergeByName(undefined, b)!.items).toHaveLength(2);
    expect(mergeByName(undefined, undefined)).toBeUndefined(); // not readable at all
  });
});
