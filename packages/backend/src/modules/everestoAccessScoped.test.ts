import { ConfigReader } from '@backstage/config';
import { Space, syncGithubAccess } from './everestoAccess';
import { gh } from './everestoActions';

// GitHub is faked: every call is recorded, nothing leaves the test.
jest.mock('./everestoActions', () => ({ gh: jest.fn(), githubToken: jest.fn(async () => 'token') }));
jest.mock('./everestoManage', () => ({ OWNER: 'Everesto-Inc', commit: jest.fn(), readFile: jest.fn(async () => undefined) }));

const ghMock = gh as jest.MockedFunction<typeof gh>;
const config = new ConfigReader({ integrations: { github: [{ host: 'github.com', apps: [{ appId: '1', clientId: 'x', clientSecret: 'x', privateKey: 'x', webhookSecret: 'x' }] }] } });

const space = (name: string, member: string): Space => ({
  name,
  members: { developers: [member], maintainers: [], managers: [] },
  ciRepos: [`${name}-app`],
  gitopsRepos: [],
} as unknown as Space);

beforeEach(() => {
  ghMock.mockReset();
  ghMock.mockImplementation(async (_t: string, method: string, path: string) => {
    if (method === 'GET' && /\/orgs\/[^/]+\/teams\/[^/]+$/.test(path)) return { ok: true, status: 200, json: { id: 1 } } as any;
    if (method === 'GET' && path.includes('/contents/')) return { ok: false, status: 404, json: undefined } as any; // ArgoCD file missing → would write it
    return { ok: true, status: 200, json: [] } as any;
  });
});

describe('access sync limited to one space (after a member change)', () => {
  it('touches only that space\'s teams and repos', async () => {
    const report = await syncGithubAccess(config, [space('orchid', 'alice'), space('lily', 'bob')], true, ['owner'], 'orchid');
    const paths = ghMock.mock.calls.map(c => String(c[2]));
    expect(paths.some(p => p.includes('orchid-'))).toBe(true);
    expect(paths.some(p => p.includes('lily-'))).toBe(false);
    expect(report.actions.some(a => a.includes('lily-'))).toBe(false);
  });

  it('still writes the ArgoCD roles of ALL spaces (a subset would drop the others)', async () => {
    const report = await syncGithubAccess(config, [space('orchid', 'alice'), space('lily', 'bob')], true, ['owner'], 'orchid');
    expect(report.actions.find(a => a.includes('ArgoCD roles'))).toContain('orchid, lily');
  });

  it('skips the platform-team part (full runs only)', async () => {
    await syncGithubAccess(config, [space('orchid', 'alice')], true, ['owner'], 'orchid');
    expect(ghMock.mock.calls.some(c => String(c[2]).includes('/teams/platform-team'))).toBe(false);
  });

  it('a full run (no space given) covers every space', async () => {
    await syncGithubAccess(config, [space('orchid', 'alice'), space('lily', 'bob')], true, ['owner']);
    const paths = ghMock.mock.calls.map(c => String(c[2]));
    expect(paths.some(p => p.includes('orchid-'))).toBe(true);
    expect(paths.some(p => p.includes('lily-'))).toBe(true);
    expect(paths.some(p => p.includes('/teams/platform-team'))).toBe(true);
  });

  it('dry run changes nothing (only GETs)', async () => {
    await syncGithubAccess(config, [space('orchid', 'alice')], true, ['owner'], 'orchid');
    expect(ghMock.mock.calls.every(c => c[1] === 'GET')).toBe(true);
  });
});
