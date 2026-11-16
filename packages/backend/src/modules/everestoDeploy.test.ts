import { NS_KEY, applySecretsCmd, devHost, ns, setupCommands } from './everestoDeploy';

describe('setupCommands', () => {
  const steps = setupCommands('python-backend', 'orchid', false);

  it('is numbered in order and covers once / dev / prod', () => {
    expect(steps.map(s => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(new Set(steps.map(s => s.env))).toEqual(new Set(['once', 'dev', 'prod']));
  });

  it('uses the app, gitops repo and namespaces', () => {
    const all = steps.map(s => s.cmd).join('\n');
    expect(all).toContain('platform/tenants/orchid/python-backend.yaml');   // app-of-apps: no kubectl apply per app
    expect(all).toContain('application prod-python-backend');   // env-first ArgoCD names
    expect(all).toContain('-n dev-orchid');
    expect(all).toContain('-n prod-orchid');
    expect(all).toContain('application dev-python-backend');
  });

  it('never contains a secret — the ESO login is automatic (Infisical platform-eso → ESO)', () => {
    const login = steps.find(s => s.n === 2)!;
    expect(login.cmd).toContain('AUTOMATIC');
    expect(steps.map(s => s.cmd).join('\n')).not.toMatch(/clientSecret=/);
  });

  it('marks prod as not done yet until the first promote', () => {
    expect(steps.find(s => s.n === 7)!.title).toContain('(not done yet)');
    expect(setupCommands('python-backend', 'orchid', true).find(s => s.n === 7)!.title).not.toContain('(not done yet)');
  });
});

describe('applySecretsCmd', () => {
  it('forces the ESO sync and restarts only this app in this namespace', () => {
    expect(applySecretsCmd('python-backend', 'orchid', 'prod')).toBe(
      'sudo kubectl -n prod-orchid annotate externalsecret python-backend force-sync=$(date +%s) --overwrite\n' +
      'sudo kubectl -n prod-orchid rollout restart deployment python-backend',
    );
  });
});

describe('devHost', () => {
  it('is one level under dev.everesto.live (covered by the wildcard certificate)', () => {
    expect(devHost('python-backend')).toBe('python-backend.dev.everesto.live');
    expect(devHost('python-backend').split('.').length).toBe(4);
  });
});

describe('namespaces', () => {
  it('per app, env-first, short key: dev-python / prod-python', () => {
    expect(ns('python', 'dev')).toBe('dev-python');
    expect(ns('python', 'prod')).toBe('prod-python');
    expect(NS_KEY.test('python')).toBe(true);
    expect(NS_KEY.test('Python')).toBe(false);
    expect(NS_KEY.test('-x')).toBe(false);
  });
  it('setup commands use the app key when given', () => {
    const all = setupCommands('python-backend', 'orchid', false, 'python').map(s => s.cmd).join('\n');
    expect(all).toContain('-n dev-python');
    expect(all).not.toContain('dev-orchid');
  });
});
