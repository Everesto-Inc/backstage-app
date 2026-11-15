/**
 * everesto access sync — Backstage (catalog groups) is the source of truth; GitHub is made to match.
 *
 * Per DevOps space <space> (System labelled everesto.live/level=space):
 *   GitHub teams  <space>-developers  → push     on the space's CI repos (Components)
 *                 <space>-maintainers → maintain on CI repos, push on its <app>-gitops repos
 *   (owner = platform-team = GitHub org owners — no per-space owner team)
 *   Nobody gets admin → nobody can delete a repo or change branch protection.
 *   Users not yet in the org are INVITED (with their team). Users removed from a Backstage group are removed
 *   from that GitHub TEAM (not from the org — they may belong to other spaces).
 *   Ruleset "everesto-main" on every space repo: main only via pull request, no force-push, no deletion.
 *   Bypass: the Backstage GitHub App (it commits gitops/tool changes) and org admins (break-glass).
 * Platform repos (domain platform) are never touched.
 */
import { Config } from '@backstage/config';
import { gh, githubToken } from './everestoActions';
import { OWNER } from './everestoManage';

type Perm = 'pull' | 'push' | 'maintain';
const ROLES = ['developers', 'maintainers'] as const; // owner = platform-team = org owners
const RULESET = 'everesto-main';

export type AccessReport = { dryRun: boolean; actions: string[]; warnings: string[] };

type Space = {
  name: string;
  members: Record<(typeof ROLES)[number], string[]>;
  ciRepos: string[];
  gitopsRepos: string[];
};

const slugOf = (e: any) => String(e.metadata?.annotations?.['github.com/project-slug'] ?? '').split('/')[1];

const ENTITY_ADMIN = /^group:default\/([a-z0-9-]+)-admins$/;

/** Entity admins act as maintainers of every space of their entity: add those maintainer groups to the refs. */
export async function expandEntityAdmins(refs: string[], spacesOf: (entity: string) => Promise<string[]>) {
  const extra: string[] = [];
  for (const r of refs) {
    const m = r.match(ENTITY_ADMIN);
    if (!m) continue;
    for (const space of await spacesOf(m[1])) extra.push(`group:default/${space}-maintainers`);
  }
  return [...new Set([...refs, ...extra])];
}

/** Read spaces, role groups and repos from the catalog. */
export async function readSpaces(getEntities: (filter: Record<string, string>) => Promise<any[]>): Promise<Space[]> {
  const systems = await getEntities({ kind: 'System', 'metadata.labels.everesto.live/level': 'space' });
  const groups = await getEntities({ kind: 'Group', 'spec.type': 'role' });
  const entityAdmins = await getEntities({ kind: 'Group', 'metadata.labels.everesto.live/role': 'entity-admin' });
  const comps = await getEntities({ kind: 'Component' });
  const res = await getEntities({ kind: 'Resource' });
  return systems.map(sys => {
    const name = sys.metadata.name as string;
    const members = Object.fromEntries(ROLES.map(r => [r,
      ((groups.find(g => g.metadata.name === `${name}-${r}`)?.spec?.members ?? []) as string[]).map(m => m.replace(/^user:(default\/)?/, '').toLowerCase()),
    ])) as Space['members'];
    // entity admins of this space's entity are maintainers here too
    const admins = ((entityAdmins.find(g => g.metadata.name === `${sys.spec?.domain}-admins`)?.spec?.members ?? []) as string[])
      .map(m => m.replace(/^user:(default\/)?/, '').toLowerCase());
    members.maintainers = [...new Set([...members.maintainers, ...admins])];
    const inSpace = (e: any) => e.spec?.system === name && e.metadata?.annotations?.['everesto.live/protected'] !== 'true';
    return {
      name,
      members,
      ciRepos: comps.filter(inSpace).map(slugOf).filter(Boolean),
      gitopsRepos: res.filter(e => inSpace(e) && e.spec?.type === 'gitops').map(slugOf).filter(Boolean),
    };
  });
}

/** Desired team permission per repo kind. */
export const permissionFor = (role: (typeof ROLES)[number], kind: 'ci' | 'gitops'): Perm | undefined => {
  if (kind === 'ci') return role === 'developers' ? 'push' : 'maintain';
  return role === 'developers' ? undefined : 'push'; // gitops changes go through Backstage; devs read (public)
};

export const rulesetBody = (appId: number) => ({
  name: RULESET,
  target: 'branch',
  enforcement: 'active',
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  rules: [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    {
      type: 'pull_request',
      parameters: {
        required_approving_review_count: 0, // PR required; approvals can be raised per space later
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
      },
    },
  ],
  bypass_actors: [
    { actor_id: appId, actor_type: 'Integration', bypass_mode: 'always' }, // Backstage GitHub App
    { actor_id: 1, actor_type: 'OrganizationAdmin', bypass_mode: 'always' }, // org owners: break-glass
  ],
});

export async function syncGithubAccess(config: Config, spaces: Space[], dryRun: boolean): Promise<AccessReport> {
  const token = await githubToken(config, OWNER);
  const appId = Number(config.getConfigArray('integrations.github')[0]?.getConfigArray('apps')[0]?.getString('appId'));
  const report: AccessReport = { dryRun, actions: [], warnings: [] };
  const act = async (what: string, fn: () => Promise<{ ok: boolean; status: number }>) => {
    if (dryRun) { report.actions.push(`would ${what}`); return; }
    const r = await fn();
    if (r.ok) report.actions.push(what);
    else report.warnings.push(`${what} → HTTP ${r.status}`);
  };

  const orgMembers = new Set<string>();
  for (let page = 1; page < 20; page++) {
    const r = await gh(token, 'GET', `/orgs/${OWNER}/members?per_page=100&page=${page}`);
    const list = (r.json ?? []) as any[];
    list.forEach(m => orgMembers.add(String(m.login).toLowerCase()));
    if (list.length < 100) break;
  }
  const pending = new Set(((await gh(token, 'GET', `/orgs/${OWNER}/invitations?per_page=100`)).json ?? [])
    .map((i: any) => String(i.login ?? '').toLowerCase()));

  for (const space of spaces) {
    for (const role of ROLES) {
      const team = `${space.name}-${role}`;
      // 1. team exists
      let t = await gh(token, 'GET', `/orgs/${OWNER}/teams/${team}`);
      if (t.status === 404) {
        await act(`create team ${team}`, () => gh(token, 'POST', `/orgs/${OWNER}/teams`, {
          name: team, privacy: 'closed', description: `DevOps space ${space.name} — ${role} (managed by Backstage)`,
        }));
        t = await gh(token, 'GET', `/orgs/${OWNER}/teams/${team}`);
      }
      const teamId = t.json?.id;

      // 2. repo permissions
      for (const [kind, repos] of [['ci', space.ciRepos], ['gitops', space.gitopsRepos]] as const) {
        const perm = permissionFor(role, kind);
        if (!perm) continue;
        for (const repo of repos) {
          const cur = await gh(token, 'GET', `/orgs/${OWNER}/teams/${team}/repos/${OWNER}/${repo}`, undefined);
          const has = cur.ok ? cur.json?.role_name : undefined;
          if (has !== perm) {
            await act(`team ${team}: ${perm} on ${repo}${has ? ` (was ${has})` : ''}`,
              () => gh(token, 'PUT', `/orgs/${OWNER}/teams/${team}/repos/${OWNER}/${repo}`, { permission: perm }));
          }
        }
      }

      // 3. members: invite or add; remove those no longer in the Backstage group
      const want = new Set(space.members[role]);
      const current = new Set<string>(teamId
        ? ((await gh(token, 'GET', `/orgs/${OWNER}/teams/${team}/members?per_page=100`)).json ?? []).map((m: any) => String(m.login).toLowerCase())
        : []);
      for (const user of want) {
        if (current.has(user)) continue;
        if (orgMembers.has(user)) {
          await act(`add ${user} to team ${team}`, () => gh(token, 'PUT', `/orgs/${OWNER}/teams/${team}/memberships/${user}`, { role: 'member' }));
        } else if (pending.has(user)) {
          report.warnings.push(`${user}: org invitation pending — accept it on github.com/orgs/${OWNER}/invitation`);
        } else {
          const u = await gh(token, 'GET', `/users/${user}`);
          if (!u.ok) { report.warnings.push(`${user}: no such GitHub user`); continue; }
          await act(`invite ${user} to ${OWNER} (team ${team})`, () => gh(token, 'POST', `/orgs/${OWNER}/invitations`, {
            invitee_id: u.json.id, role: 'direct_member', ...(teamId ? { team_ids: [teamId] } : {}),
          }));
          pending.add(user);
        }
      }
      for (const user of current) {
        if (!want.has(user)) {
          await act(`remove ${user} from team ${team} (no longer ${role} of ${space.name} in Backstage)`,
            () => gh(token, 'DELETE', `/orgs/${OWNER}/teams/${team}/memberships/${user}`));
        }
      }
    }

    // 4. ruleset on every repo of the space
    for (const repo of [...space.ciRepos, ...space.gitopsRepos]) {
      const list = await gh(token, 'GET', `/repos/${OWNER}/${repo}/rulesets`);
      if (!list.ok) { report.warnings.push(`${repo}: cannot read rulesets (HTTP ${list.status})`); continue; }
      if (!((list.json ?? []) as any[]).some(r => r.name === RULESET)) {
        await act(`protect main of ${repo} (PR only, no force-push, no deletion)`,
          () => gh(token, 'POST', `/repos/${OWNER}/${repo}/rulesets`, rulesetBody(appId)));
      }
    }
  }
  return report;
}
