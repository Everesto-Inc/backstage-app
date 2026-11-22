/** Infisical client for deployments: one project <space>-<repo>-gitops per application, identity eso-<repo>. */
import { Config } from '@backstage/config';
import { Env } from './everestoManifests';
import { err } from './everestoCommon';
// ---------- Infisical ----------

export async function infisical(config: Config) {
  const url = config.getOptionalString('infisical.url');
  const clientId = config.getOptionalString('infisical.clientId');
  const clientSecret = config.getOptionalString('infisical.clientSecret');
  let orgId = config.getOptionalString('infisical.organizationId')?.trim(); // tolerate a pasted trailing '/'
  while (orgId?.endsWith('/')) orgId = orgId.slice(0, -1);
  if (!url || !clientId || !clientSecret || !orgId) {
    throw err(409, 'Backstage is not connected to Infisical yet (identity backstage-platform) — nothing was created. Secrets are required for a deployment.');
  }
  const login = await (await fetch(`${url}/api/v1/auth/universal-auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId, clientSecret }),
  })).json() as any;
  if (!login.accessToken) throw err(502, 'Infisical: login of backstage-platform failed — nothing was created');
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${login.accessToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
    return { ok: res.ok, status: res.status, json };
  };
  return { url, orgId, api };
}

// ---------- project naming ----------
// Infisical has no folders/tags for projects, so the DevOps space goes FIRST in the name:
// the project list then groups by space (search "orchid" → all of orchid's applications).
/** Infisical project of an application (since 2026-11-22): <space>-<repo>-gitops, e.g. orchid-maas-backend-gitops. */
export const infisicalProject = (space: string, repo: string) => `${space}-${repo}-gitops`;
/** Name used before 2026-11-22 — still recognised, so existing deployments (python-backend-gitops) keep working. */
export const legacyInfisicalProject = (repo: string) => `${repo}-gitops`;

type Api = Awaited<ReturnType<typeof infisical>>['api'];
/** The application's Infisical project: new name first, then the legacy one. undefined = none yet. */
export async function findInfisicalProject(api: Api, space: string, repo: string): Promise<any | undefined> {
  const all = ((await api('GET', '/api/v1/workspace')).json?.workspaces ?? []) as any[];
  return all.find(w => w.name === infisicalProject(space, repo)) ?? all.find(w => w.name === legacyInfisicalProject(repo));
}

/** Infisical project <space>-<repo>-gitops (one per application) + its secrets in <env>. Returns slug and (only when new) the ESO identity login. */
export async function infisicalSetup(config: Config, space: string, repo: string, env: Env, secrets: { name: string; value?: string }[]) {
  const { url, orgId, api } = await infisical(config);
  let ws = await findInfisicalProject(api, space, repo); // existing (new or legacy name) → reused as is
  if (!ws) {
    const project = infisicalProject(space, repo);
    const created = await api('POST', '/api/v2/workspace', { projectName: project, organizationId: orgId });
    if (!created.ok) throw err(502, `Infisical: cannot create project ${project} (${created.status})`);
    ws = created.json.project ?? created.json.workspace;
  }
  const project = ws.name as string;
  for (const s of secrets) {
    const r = await api('POST', `/api/v3/secrets/raw/${encodeURIComponent(s.name)}`, {
      workspaceId: ws.id, environment: env, secretPath: '/', secretValue: s.value || 'CHANGE_ME', type: 'shared',
    });
    if (!r.ok && !JSON.stringify(r.json ?? '').toLowerCase().includes('already exist')) throw err(502, `Infisical: cannot create secret ${s.name} (${r.status} ${JSON.stringify(r.json?.message ?? '')})`);
  }

  // ESO identity eso-<repo>: viewer on this Infisical project only
  const name = `eso-${repo}`;
  const ids = await api('GET', `/api/v2/organizations/${orgId}/identity-memberships`);
  const exists = (ids.json?.identityMemberships ?? []).some((m: any) => m.identity?.name === name);
  const base = { url, projectSlug: ws.slug as string, projectUrl: `${url}/project/${ws.id}/secrets/overview`, identity: name, project };
  if (exists) return base;
  const idRes = await api('POST', '/api/v1/identities', { name, organizationId: orgId, role: 'no-access' });
  if (!idRes.ok) throw err(502, `Infisical: cannot create identity ${name} (${idRes.status})`);
  const identityId = idRes.json.identity.id;
  const ua = await api('POST', `/api/v1/auth/universal-auth/identities/${identityId}`, {});
  const cs = await api('POST', `/api/v1/auth/universal-auth/identities/${identityId}/client-secrets`, { description: 'ESO (created by Backstage)' });
  const mem = await api('POST', `/api/v2/workspace/${ws.id}/identity-memberships/${identityId}`, { role: 'viewer' });
  if (!ua.ok || !cs.ok || !mem.ok) throw err(502, `Infisical: identity ${name} setup failed (${ua.status}/${cs.status}/${mem.status})`);
  return { ...base, clientId: ua.json.identityUniversalAuth?.clientId as string, clientSecret: cs.json.clientSecret as string };
}

/** Delete Infisical project <space>-<repo>-gitops (or its legacy name) + identity eso-<repo> (part of deleting the deployment). */
export async function infisicalDelete(config: Config, space: string, repo: string): Promise<{ done: string[]; warn: string[] }> {
  const done: string[] = [];
  const warn: string[] = [];
  let conn;
  try { conn = await infisical(config); } catch (e: any) { return { done, warn: [`Infisical not reachable — delete project ${infisicalProject(space, repo)} (or ${legacyInfisicalProject(repo)}) by hand (${e.message})`] }; }
  const { orgId, api } = conn;
  const ws = await findInfisicalProject(api, space, repo);
  if (ws) {
    const d = await api('DELETE', `/api/v1/workspace/${ws.id}`);
    if (d.ok) done.push(`Infisical project ${ws.name} (all its secrets)`); else warn.push(`could not delete Infisical project ${ws.name} (${d.status})`);
  }
  const ids = await api('GET', `/api/v2/organizations/${orgId}/identity-memberships`);
  const id = (ids.json?.identityMemberships ?? []).find((m: any) => m.identity?.name === `eso-${repo}`)?.identity?.id;
  if (id) {
    const d = await api('DELETE', `/api/v1/identities/${id}`);
    if (d.ok) done.push(`Infisical identity eso-${repo}`); else warn.push(`could not delete identity eso-${repo} (${d.status})`);
  }
  return { done, warn };
}

