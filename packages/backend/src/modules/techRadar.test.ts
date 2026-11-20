import { DEFAULT_ENTRIES, parseEntries, radarResponse } from './techRadar';
import { TechRadarLoaderResponseParser } from '@backstage-community/plugin-tech-radar-common';

describe('tech radar', () => {
  it('the default radar is valid for the plugin (no fallback to lorem-ipsum data)', () => {
    const r = TechRadarLoaderResponseParser.safeParse(JSON.parse(JSON.stringify(radarResponse(DEFAULT_ENTRIES))));
    expect(r.success).toBe(true);
  });
  it('reads entries from YAML and skips invalid ones', () => {
    const e = parseEntries('entries:\n  - { id: rust, title: Rust, quadrant: languages, ring: assess }\n  - { id: x, title: X, quadrant: nope, ring: adopt }\n');
    expect(e?.map(x => x.id)).toEqual(['rust']);
    expect(parseEntries('entries: []')).toBeUndefined();
  });
});
