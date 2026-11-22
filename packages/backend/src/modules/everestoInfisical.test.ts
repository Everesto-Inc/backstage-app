import { findInfisicalProject, infisicalProject, legacyInfisicalProject } from './everestoInfisical';

const api = (names: string[]) => (async () => ({ ok: true, status: 200, json: { workspaces: names.map((name, i) => ({ id: `id${i}`, name })) } })) as any;

describe('Infisical project naming', () => {
  it('puts the DevOps space first so the project list groups by space', () => {
    expect(infisicalProject('orchid', 'maas-backend')).toBe('orchid-maas-backend-gitops');
    expect(infisicalProject('lily', 'shop')).toBe('lily-shop-gitops');
  });

  it('keeps the legacy name (before 2026-11-22)', () => {
    expect(legacyInfisicalProject('python-backend')).toBe('python-backend-gitops');
  });

  it('finds the new name first', async () => {
    const ws = await findInfisicalProject(api(['maas-backend-gitops', 'orchid-maas-backend-gitops']), 'orchid', 'maas-backend');
    expect(ws.name).toBe('orchid-maas-backend-gitops');
  });

  it('falls back to the legacy name so existing deployments keep working', async () => {
    const ws = await findInfisicalProject(api(['python-backend-gitops', 'platform-eso']), 'orchid', 'python-backend');
    expect(ws.name).toBe('python-backend-gitops');
  });

  it('does not match another space or another app', async () => {
    expect(await findInfisicalProject(api(['lily-maas-backend-gitops', 'orchid-maas-frontend-gitops']), 'orchid', 'maas-backend')).toBeUndefined();
  });
});
