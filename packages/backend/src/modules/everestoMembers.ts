/**
 * everesto members — add / remove a person in a DevOps Space role (real "Invite member").
 *
 *   add:    GitHub username must exist → everesto-catalog: User in platform/org.yaml (if new) + username in the
 *           space's role group (spaces/<space>.yaml) — ONE commit → GitHub: org invitation with the team, or team
 *           membership if already in the org.
 *   remove: username out of that role group (commit) → removed from that GitHub team (org account untouched).
 *
 * Who (givableRoles): owner (platform-team) every role, several at once · managers + entity managers: maintainers,
 * developers, viewers · maintainers: developers, viewers · developers / viewers: nobody.
 */
import { err } from './everestoCommon';
import { Config } from '@backstage/config';
import { gh, githubToken } from './everestoActions';
import { OWNER, commit, readFile } from './everestoManage';
import { findDoc, groupMembers, setGroupMembers } from './everestoYaml';

export const SPACE_ROLES = ['managers', 'maintainers', 'developers', 'viewers'] as const;
export type SpaceRole = (typeof SPACE_ROLES)[number];
const CATALOG = 'everesto-catalog';

/** Roles the caller may give or take in this space. */
export function givableRoles(refs: string[], space: string, entityOfSpace: string): SpaceRole[] {
  const has = (g: string) => refs.includes(`group:default/${g}`);
  if (has('platform-team')) return [...SPACE_ROLES]; // owner: every role
  if (has(`${space}-managers`) || (!!entityOfSpace && has(`${entityOfSpace}-admins`))) return ['maintainers', 'developers', 'viewers'];
  if (has(`${space}-maintainers`)) return ['developers', 'viewers'];
  return [];
}

/** May the caller give/take this role in this space? */
export function canManageRole(refs: string[], space: string, role: SpaceRole, entityOfSpace: string) {
  return givableRoles(refs, space, entityOfSpace).includes(role);
}

// group members are read/edited with a real YAML parser (comments + other documents untouched)
export { groupMembers, setGroupMembers } from './everestoYaml';

const userDoc = (name: string, login: string, email?: string, displayName?: string) => `---
apiVersion: backstage.io/v1alpha1
kind: User
metadata:
  name: ${name}                 # GitHub username ${login}
spec:
  profile:
    displayName: ${JSON.stringify(displayName || login)}${email ? `\n    email: ${email}` : ''}
  memberOf: []
`;

export async function addMember(config: Config, space: string, roles: SpaceRole[], login: string, email: string | undefined, displayName: string | undefined, who: string) {
  const token = await githubToken(config, OWNER);
  const u = await gh(token, 'GET', `/users/${encodeURIComponent(login)}`);
  if (!u.ok) throw err(404, `GitHub user "${login}" does not exist — they must create a GitHub account first`);
  const name = String(u.json.login).toLowerCase();
  const spaceFile = `spaces/${space}.yaml`;
  const spaceYaml = await readFile(token, CATALOG, spaceFile);
  if (!spaceYaml) throw err(404, `space ${space} not found in ${CATALOG}`);
  const org = (await readFile(token, CATALOG, 'platform/org.yaml')) ?? '';
  const files: { path: string; content: string }[] = [];
  const done: string[] = [];
  if (!findDoc(org, 'User', name)) {
    files.push({ path: 'platform/org.yaml', content: `${org.trimEnd()}\n${userDoc(name, u.json.login, email, displayName)}` });
    done.push(`user ${name} created in the catalog`);
  }
  const added = roles.filter(r => !groupMembers(spaceYaml, `${space}-${r}`).includes(name));
  const already = roles.filter(r => !added.includes(r));
  let next = spaceYaml;
  for (const r of added) next = setGroupMembers(next, `${space}-${r}`, m => [...m, name]);
  if (added.length) files.push({ path: spaceFile, content: next });
  if (!files.length) return { done: [`${name} already has ${roles.join(', ')} in ${space}`], warn: [] };
  await commit(token, CATALOG, `members: ${name} → ${added.map(r => `${space}-${r}`).join(', ')} (Backstage, by ${who})`, files);
  if (added.length) done.push(`${name} added as ${added.join(' + ')} of ${space}`);
  const warn: string[] = already.length ? [`already ${already.join(', ')} — unchanged`] : [];

  // GitHub: one team per role (viewers need none — public repos). Org member → team membership; else ONE invitation with all teams.
  const teams = await Promise.all(added.filter(r => r !== 'viewers').map(async r => ({ name: `${space}-${r}`, t: await gh(token, 'GET', `/orgs/${OWNER}/teams/${space}-${r}`) })));
  const isMember = (await gh(token, 'GET', `/orgs/${OWNER}/members/${name}`)).status === 204;
  const missing = teams.filter(x => !x.t.ok).map(x => x.name);
  if (missing.length) warn.push(`team ${missing.join(', ')} does not exist yet — the access sync creates it (every 30 min, or GitHub access → Apply)`);
  const existing = teams.filter(x => x.t.ok);
  if (isMember) {
    for (const x of existing) {
      const r = await gh(token, 'PUT', `/orgs/${OWNER}/teams/${x.name}/memberships/${name}`, { role: 'member' });
      if (r.ok) done.push(`GitHub team ${x.name}`); else warn.push(`GitHub team ${x.name}: HTTP ${r.status}`);
    }
  } else if (existing.length) {
    const r = await gh(token, 'POST', `/orgs/${OWNER}/invitations`, { invitee_id: u.json.id, role: 'direct_member', team_ids: existing.map(x => x.t.json.id) });
    if (r.ok) done.push(`GitHub invitation to ${OWNER} (teams ${existing.map(x => x.name).join(', ')}) — they accept it by email`);
    else if (r.status === 422) warn.push('GitHub invitation already pending — they must accept it; the access sync adds the teams afterwards');
    else warn.push(`GitHub invitation: HTTP ${r.status}`);
  } else if (!isMember && added.every(r => r === 'viewers')) {
    warn.push('viewers need no GitHub access (public repos) — no org invitation sent');
  }
  return { done, warn, user: name };
}

export async function removeMember(config: Config, space: string, role: SpaceRole, login: string, who: string) {
  const token = await githubToken(config, OWNER);
  const name = login.toLowerCase();
  const spaceFile = `spaces/${space}.yaml`;
  const spaceYaml = await readFile(token, CATALOG, spaceFile);
  if (!spaceYaml) throw err(404, `space ${space} not found`);
  if (!groupMembers(spaceYaml, `${space}-${role}`).includes(name)) return { done: [`${name} was not ${role} of ${space}`], warn: [] };
  const next = setGroupMembers(spaceYaml, `${space}-${role}`, m => m.filter(x => x !== name));
  await commit(token, CATALOG, `members: ${name} removed from ${space}-${role} (Backstage, by ${who})`, [{ path: spaceFile, content: next }]);
  const done = [`${name} removed from ${space}-${role}`];
  const r = await gh(token, 'DELETE', `/orgs/${OWNER}/teams/${space}-${role}/memberships/${name}`);
  if (r.ok) done.push(`removed from GitHub team ${space}-${role}`);
  return { done, warn: ['their GitHub account and org membership are kept (they may be in other spaces)'] };
}
