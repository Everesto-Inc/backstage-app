/**
 * SonarQube access = the DevOps Space roles (part of the access sync, every 30 min).
 *
 *   groups      <space>-viewers / -developers / -maintainers / -managers  (created + members kept in sync)
 *   projects    every SonarQube project of the space's applications: PRIVATE, and only these groups have rights:
 *                 viewers, developers        → Browse + See source
 *                 maintainers, managers      → + Administer issues / hotspots / the project
 *               the default group sonar-users (= everyone logged in) loses its rights there → other spaces see nothing
 *   owner       platform-team members → sonar-administrators
 *
 * People are matched by GitHub login (SonarQube "Log in with GitHub"); someone who never logged in to SonarQube
 * yet is skipped with a note and picked up on the next run. SonarQube's own GitHub team sync must stay OFF.
 * Only the groups and projects above are touched — local accounts (admin) and platform projects are left alone.
 */
import { Config } from '@backstage/config';
import { sonarApi } from './everestoActions';
import type { Space } from './everestoAccess';

export const SONAR_ROLES = ['viewers', 'developers', 'maintainers', 'managers'] as const;
type SonarRole = (typeof SONAR_ROLES)[number];
const READ = ['user', 'codeviewer'];
const ADMIN = [...READ, 'issueadmin', 'securityhotspotadmin', 'admin'];
export const PERMISSIONS: Record<SonarRole, string[]> = { viewers: READ, developers: READ, maintainers: ADMIN, managers: ADMIN };
const ALL_PERMS = ADMIN;

/** Pure: who belongs in which SonarQube group (GitHub logins, lowercase). Higher roles are not repeated in lower groups. */
export function desiredGroups(space: Space): Record<string, string[]> {
  const m = space.members as Record<string, string[]>;
  return Object.fromEntries(SONAR_ROLES.map(r => [`${space.name}-${r}`, [...new Set((r === 'viewers' ? space.viewers : m[r]) ?? [])].sort()]));
}

/** Pure: permissions each group must have on every project of the space. */
export function desiredProjectPermissions(space: Space): Record<string, string[]> {
  return Object.fromEntries(SONAR_ROLES.map(r => [`${space.name}-${r}`, PERMISSIONS[r]]));
}

/** Pure: what to add/remove so `have` becomes `want` (group → items). */
export function diff(want: Record<string, string[]>, have: Record<string, string[]>) {
  const add: [string, string][] = [];
  const remove: [string, string][] = [];
  for (const [g, items] of Object.entries(want)) {
    for (const i of items) if (!(have[g] ?? []).includes(i)) add.push([g, i]);
    for (const i of have[g] ?? []) if (!items.includes(i)) remove.push([g, i]);
  }
  return { add, remove };
}

type Report = { actions: string[]; warnings: string[] };

export async function syncSonarAccess(config: Config, spaces: Space[], dryRun: boolean, owners: string[]): Promise<Report> {
  const out: Report = { actions: [], warnings: [] };
  let api: ReturnType<typeof sonarApi>;
  try { api = sonarApi(config); } catch { out.warnings.push('SonarQube: not configured — skipped'); return out; }
  const { call } = api;
  const act = async (what: string, fn: () => Promise<{ ok: boolean; status: number }>) => {
    out.actions.push(`SonarQube: ${what}`);
    if (dryRun) return;
    const r = await fn();
    if (!r.ok) out.warnings.push(`SonarQube: ${what} failed (HTTP ${r.status})`);
  };

  // users who logged in with GitHub: github login (lowercase) → SonarQube user
  const users = await call('GET', '/api/v2/users-management/users?pageSize=500&active=true');
  if (!users.ok) { out.warnings.push(`SonarQube: cannot list users (HTTP ${users.status}) — is the token an admin token?`); return out; }
  const byGithub = new Map<string, { id: string; login: string }>();
  for (const u of (users.json?.users ?? []) as any[]) {
    if (u.externalProvider === 'github' && u.externalLogin) byGithub.set(String(u.externalLogin).toLowerCase(), { id: u.id, login: u.login });
  }
  if (!byGithub.size) out.warnings.push('SonarQube: nobody has logged in with GitHub yet (or GitHub login is not enabled) — memberships follow after the first login');

  const groupId = async (name: string, create: boolean): Promise<string | undefined> => {
    const r = await call('GET', `/api/v2/authorizations/groups?q=${encodeURIComponent(name)}&pageSize=50`);
    const g = ((r.json?.groups ?? []) as any[]).find(x => x.name === name);
    if (g) return g.id;
    if (!create) return undefined;
    await act(`create group ${name}`, () => call('POST', '/api/v2/authorizations/groups', { name, description: 'Managed by Backstage (DevOps Space role) — do not edit by hand' }));
    if (dryRun) return undefined;
    const again = await call('GET', `/api/v2/authorizations/groups?q=${encodeURIComponent(name)}&pageSize=50`);
    return ((again.json?.groups ?? []) as any[]).find(x => x.name === name)?.id;
  };

  const syncMembers = async (group: string, logins: string[], create = true) => {
    const id = await groupId(group, create);
    const want = logins.filter(l => byGithub.has(l));
    const notYet = logins.filter(l => !byGithub.has(l));
    if (notYet.length && byGithub.size) out.warnings.push(`SonarQube: ${notYet.join(', ')} (${group}) — after their first SonarQube login`);
    if (!id) { for (const l of want) out.actions.push(`SonarQube: add ${l} to ${group}`); return; }
    const mem = await call('GET', `/api/v2/authorizations/group-memberships?groupId=${id}&pageSize=500`);
    const memberships = (mem.json?.groupMemberships ?? []) as { id: string; userId: string }[];
    const loginOfUser = new Map([...byGithub.entries()].map(([gh, u]) => [u.id, gh]));
    const have = memberships.map(m => loginOfUser.get(m.userId) ?? `#${m.userId}`);
    const { add, remove } = diff({ [group]: want }, { [group]: have });
    for (const [, l] of add) await act(`add ${l} to ${group}`, () => call('POST', '/api/v2/authorizations/group-memberships', { groupId: id, userId: byGithub.get(l)!.id }));
    for (const [, l] of remove) {
      if (l.startsWith('#')) continue; // a non-GitHub account in a managed group: left alone (warned below)
      const m = memberships.find(x => loginOfUser.get(x.userId) === l)!;
      await act(`remove ${l} from ${group}`, () => call('DELETE', `/api/v2/authorizations/group-memberships/${m.id}`));
    }
    if (have.some(l => l.startsWith('#'))) out.warnings.push(`SonarQube: ${group} has a non-GitHub account — remove it by hand if unwanted`);
  };

  // owner → sonar-administrators (never removes anyone there: the local admin account must stay)
  const adminsId = await groupId('sonar-administrators', false);
  if (adminsId) {
    const mem = await call('GET', `/api/v2/authorizations/group-memberships?groupId=${adminsId}&pageSize=500`);
    const ids = new Set(((mem.json?.groupMemberships ?? []) as any[]).map(m => m.userId));
    for (const o of owners) {
      const u = byGithub.get(o);
      if (u && !ids.has(u.id)) await act(`add ${o} to sonar-administrators (owner)`, () => call('POST', '/api/v2/authorizations/group-memberships', { groupId: adminsId, userId: u.id }));
    }
  }

  for (const space of spaces) {
    for (const [group, logins] of Object.entries(desiredGroups(space))) await syncMembers(group, logins);

    for (const key of space.sonarProjects ?? []) {
      const proj = await call('GET', `/api/projects/search?projects=${encodeURIComponent(key)}`);
      const p = ((proj.json?.components ?? []) as any[])[0];
      if (!p) { out.warnings.push(`SonarQube: project ${key} (${space.name}) does not exist yet — created by its first CI run`); continue; }
      if (p.visibility !== 'private') await act(`make ${key} private`, () => api.post('/api/projects/update_visibility', { project: key, visibility: 'private' }));
      const perms = await call('GET', `/api/permissions/groups?projectKey=${encodeURIComponent(key)}&ps=100`);
      const have = Object.fromEntries(((perms.json?.groups ?? []) as any[]).map(g => [g.name, (g.permissions ?? []) as string[]]));
      const want: Record<string, string[]> = { ...desiredProjectPermissions(space), 'sonar-users': [] };
      const { add, remove } = diff(want, have);
      for (const [g, perm] of add) await act(`${key}: give ${g} ${perm}`, () => api.post('/api/permissions/add_group', { projectKey: key, groupName: g, permission: perm }));
      for (const [g, perm] of remove) {
        if (!ALL_PERMS.includes(perm)) continue;
        await act(`${key}: take ${perm} from ${g}`, () => api.post('/api/permissions/remove_group', { projectKey: key, groupName: g, permission: perm }));
      }
    }
  }
  return out;
}
