/**
 * everesto members — add / remove a person in a DevOps Space role (real "Invite member").
 *
 *   add:    GitHub username must exist → everesto-catalog: User in platform/org.yaml (if new) + username in the
 *           space's role group (spaces/<space>.yaml) — ONE commit → GitHub: org invitation with the team, or team
 *           membership if already in the org.
 *   remove: username out of that role group (commit) → removed from that GitHub team (org account untouched).
 *
 * Who: owner (platform-team) any role · managers / entity managers of the space: developers + viewers only.
 */
import { Config } from '@backstage/config';
import { gh, githubToken } from './everestoActions';
import { OWNER, commit, readFile } from './everestoManage';

export const SPACE_ROLES = ['managers', 'maintainers', 'developers', 'viewers'] as const;
export type SpaceRole = (typeof SPACE_ROLES)[number];
const CATALOG = 'everesto-catalog';
const err = (status: number, message: string) => Object.assign(new Error(message), { status });

/** May the caller give/take this role in this space? */
export function canManageRole(refs: string[], space: string, role: SpaceRole, entityOfSpace: string) {
  if (refs.includes('group:default/platform-team')) return true; // owner: every role
  const manager = refs.includes(`group:default/${space}-managers`) || (!!entityOfSpace && refs.includes(`group:default/${entityOfSpace}-admins`));
  return manager && (role === 'developers' || role === 'viewers'); // Manager / Maintainer ticks: owner only
}

/** Pure: current members of group <group>. */
export function groupMembers(yamlText: string, group: string): string[] {
  let cur: string[] = [];
  setGroupMembers(yamlText, group, m => {
    cur = m;
    return m;
  });
  return cur;
}

/** Pure: set the members list of group <group> in a multi-document YAML file (keeps everything else as-is). */
export function setGroupMembers(yamlText: string, group: string, change: (m: string[]) => string[]) {
  const docs = yamlText.split(/\n---\n/);
  let found = false;
  const out = docs.map(doc => {
    if (!new RegExp(`^ {2}name: ${group}\\s*$`, 'm').test(doc) || !/^kind: Group$/m.test(doc)) return doc;
    found = true;
    const m = doc.match(/^ {2}members: \[([^\]]*)\](.*)$/m);
    if (!m) return doc.replace(/^spec:\n/m, `spec:\n  members: [${change([]).join(', ')}]\n`);
    const cur = m[1].split(',').map(x => x.trim()).filter(Boolean);
    return doc.replace(m[0], `  members: [${change(cur).join(', ')}]${m[2]}`);
  });
  if (!found) throw err(404, `group ${group} not found in the catalog`);
  return out.join('\n---\n');
}

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

export async function addMember(config: Config, space: string, role: SpaceRole, login: string, email: string | undefined, displayName: string | undefined, who: string) {
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
  if (!new RegExp(`^ {2}name: ${name}\\s`, 'm').test(org)) {
    files.push({ path: 'platform/org.yaml', content: `${org.trimEnd()}\n${userDoc(name, u.json.login, email, displayName)}` });
    done.push(`user ${name} created in the catalog`);
  }
  if (!groupMembers(spaceYaml, `${space}-${role}`).includes(name)) {
    files.push({ path: spaceFile, content: setGroupMembers(spaceYaml, `${space}-${role}`, m => [...m, name]) });
  }
  if (!files.length) return { done: [`${name} is already ${role} of ${space}`], warn: [] };
  await commit(token, CATALOG, `members: ${name} → ${space}-${role} (Backstage, by ${who})`, files);
  done.push(`${name} added to ${space}-${role}`);

  // GitHub: team membership or org invitation (with the team)
  const warn: string[] = [];
  const team = `${space}-${role}`;
  const t = await gh(token, 'GET', `/orgs/${OWNER}/teams/${team}`);
  const isMember = (await gh(token, 'GET', `/orgs/${OWNER}/members/${name}`)).status === 204;
  if (role === 'viewers') {
    if (!isMember) warn.push('viewers need no GitHub access (public repos) — no org invitation sent');
  } else if (isMember && t.ok) {
    const r = await gh(token, 'PUT', `/orgs/${OWNER}/teams/${team}/memberships/${name}`, { role: 'member' });
    if (r.ok) done.push(`GitHub team ${team}`); else warn.push(`GitHub team ${team}: HTTP ${r.status}`);
  } else if (!isMember) {
    const r = await gh(token, 'POST', `/orgs/${OWNER}/invitations`, { invitee_id: u.json.id, role: 'direct_member', ...(t.ok ? { team_ids: [t.json.id] } : {}) });
    if (r.ok) done.push(`GitHub invitation to ${OWNER}${t.ok ? ` (team ${team})` : ''} — they accept it by email`);
    else if (r.status === 422) warn.push('GitHub invitation already pending — they must accept it');
    else warn.push(`GitHub invitation: HTTP ${r.status}`);
  } else {
    warn.push(`team ${team} does not exist yet — run GitHub access → Apply once`);
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
