import { Raw, explainStatus } from './everestoStatus';
import { githubProblem } from './everestoPipeline';

const base: Raw = {
  env: 'dev', repo: 'python-backend', namespace: 'dev-python', clusterReadable: true, gitConfigured: true,
  argo: { exists: true, sync: 'Synced', health: 'Healthy', revision: 'abc1234', lastSyncPhase: 'Succeeded' },
  access: { ready: true }, store: { ready: true }, appSecret: { ready: true },
  pods: [{ phase: 'Running', ready: true, restarts: 0 }], replicas: 1, events: [],
  now: Date.parse('2026-11-19T20:30:00Z'),
};
const by = (steps: ReturnType<typeof explainStatus>) => Object.fromEntries(steps.map(s => [s.id, s]));

describe('explainStatus', () => {
  it('all green', () => {
    expect(explainStatus(base).every(s => s.state === 'ok')).toBe(true);
  });

  it("today's incident: no cluster login → tells you to renew, later steps not reached", () => {
    const s = by(explainStatus({
      ...base, access: { ready: false, reason: 'SecretSyncedError', refreshedAt: '2026-11-19T20:28:00Z' }, store: { ready: false },
      appSecret: { ready: false }, pods: [{ phase: 'CreateContainerConfigError', ready: false, restarts: 0 }],
      events: ['Failed: Error: secret "python-backend" not found'],
    }));
    expect(s.access.state).toBe('fail');
    expect(s.access.fix?.action).toBe('renew-access');
    expect(s.access.etaSec).toBe(180); // 2 of 5 minutes passed
    expect(s.store.state).toBe('off');
    expect(s.run.state).toBe('off');
  });

  it('login fixed, store not re-checked yet → wait, not fail', () => {
    const s = by(explainStatus({ ...base, store: { ready: false }, appSecret: { ready: false } }));
    expect(s.store.state).toBe('wait');
    expect(s.store.etaSec).toBe(300);
  });

  it('out of sync → manual sync with the ArgoCD link', () => {
    const s = by(explainStatus({ ...base, argo: { exists: true, sync: 'OutOfSync', health: 'Missing' }, appSecret: null, pods: [] }));
    expect(s.sync.state).toBe('wait');
    expect(s.sync.fix?.url).toBe('https://argocd.everesto.live/applications/argocd/dev-python-backend');
  });

  it('ArgoCD app not created yet → wait ~3 min', () => {
    const s = by(explainStatus({ ...base, argo: { exists: false }, access: null, store: null, appSecret: null, pods: [] }));
    expect(s.argo.state).toBe('wait');
    expect(s.argo.etaSec).toBe(180);
  });

  it.each([
    [{ phase: 'CrashLoopBackOff', ready: false, restarts: 5 }, 'logs', 'crashes'],
    [{ phase: 'Running', ready: false, restarts: 1, lastTermination: 'OOMKilled' }, 'edit-deployment', 'out of memory'],
    [{ phase: 'ImagePullBackOff', ready: false, restarts: 0 }, 'edit-deployment', 'cannot be downloaded'],
  ])('pod problem %o → specific explanation', (pod, action, text) => {
    const s = by(explainStatus({ ...base, pods: [pod] }));
    expect(s.run.state).toBe('fail');
    expect(s.run.fix?.action).toBe(action);
    expect(s.run.detail).toContain(text);
  });

  it('pending because no capacity', () => {
    const s = by(explainStatus({ ...base, pods: [{ phase: 'Pending', ready: false, restarts: 0 }], events: ['FailedScheduling: 0/3 nodes are available: 1 Insufficient memory'] }));
    expect(s.run.state).toBe('fail');
    expect(s.run.detail).toContain('no node has room');
  });

  it('prod not promoted yet', () => {
    const s = by(explainStatus({ ...base, env: 'prod', gitConfigured: false }));
    expect(s.git.state).toBe('off');
    expect(s.git.fix?.action).toBe('promote');
  });

  it('URL down while running → check the port', () => {
    const s = by(explainStatus({ ...base, url: { host: 'python-backend-dev.everesto.live', status: 502 } }));
    expect(s.url.state).toBe('fail');
    expect(s.url.fix?.text).toContain('port');
  });

  it('local dev (no cluster) → one honest line', () => {
    const steps = explainStatus({ ...base, clusterReadable: false });
    expect(steps.map(s => s.id)).toEqual(['git', 'cluster']);
  });
});

describe('githubProblem', () => {
  it('turns GitHub statuses into actions', () => {
    expect(githubProblem(200, 'x')).toBeUndefined();
    expect(githubProblem(404, 'x')).toContain('Delete application');
    expect(githubProblem(401, 'x')).toContain('platform team');
    expect(githubProblem(403, 'x')).toContain('rate limit');
    expect(githubProblem(503, 'x')).toContain('try again');
  });
});

describe('explainStatus guardrails', () => {
  const base2: Raw = {
    env: 'dev', repo: 'python-backend', namespace: 'dev-python', clusterReadable: true, gitConfigured: true,
    argo: { exists: true, sync: 'Synced', health: 'Progressing' }, access: { ready: true }, store: { ready: true }, appSecret: { ready: true },
    pods: [], replicas: 1,
  };
  it('quota used up → says so, with the fix', () => {
    const s = explainStatus({ ...base2, events: ['FailedCreate: pods "python-backend-x" is forbidden: exceeded quota: tenant-quota, requested: limits.memory=512Mi'] }).find(x => x.id === 'run')!;
    expect(s.state).toBe('fail');
    expect(s.detail).toContain('budget');
  });
  it('pod security → says so', () => {
    const s = explainStatus({ ...base2, events: ['FailedCreate: violates PodSecurity "baseline:latest": host namespaces'] }).find(x => x.id === 'run')!;
    expect(s.detail).toContain('pod security');
  });
});
