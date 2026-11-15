import { applySecretsCmd, setupCommands } from './everestoDeploy';

describe('setupCommands', () => {
  const steps = setupCommands('python-backend', 'orchid', false);

  it('is numbered in order and covers once / dev / prod', () => {
    expect(steps.map(s => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(new Set(steps.map(s => s.env))).toEqual(new Set(['once', 'dev', 'prod']));
  });

  it('uses the app, gitops repo and namespaces', () => {
    const all = steps.map(s => s.cmd).join('\n');
    expect(all).toContain('python-backend-gitops/main/argocd/argocd.yaml');
    expect(all).toContain('python-backend-gitops/main/argocd/argocd-prod.yaml');
    expect(all).toContain('-n orchid-dev');
    expect(all).toContain('-n orchid-prod');
    expect(all).toContain('application python-backend-dev');
  });

  it('never contains a real secret — only placeholders', () => {
    const login = steps.find(s => s.n === 2)!;
    expect(login.cmd).toContain("clientId='<CLIENT_ID>'");
    expect(login.cmd).toContain("clientSecret='<CLIENT_SECRET>'");
  });

  it('marks prod as not done yet until the first promote', () => {
    expect(steps.find(s => s.n === 7)!.title).toContain('(not done yet)');
    expect(setupCommands('python-backend', 'orchid', true).find(s => s.n === 7)!.title).not.toContain('(not done yet)');
  });
});

describe('applySecretsCmd', () => {
  it('forces the ESO sync and restarts only this app in this namespace', () => {
    expect(applySecretsCmd('python-backend', 'orchid', 'prod')).toBe(
      'sudo kubectl -n orchid-prod annotate externalsecret python-backend force-sync=$(date +%s) --overwrite\n' +
      'sudo kubectl -n orchid-prod rollout restart deployment python-backend',
    );
  });
});
