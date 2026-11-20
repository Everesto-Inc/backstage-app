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
import { membersOf } from './everestoCommon';
import { Config } from '@backstage/config';
import { gh, githubToken } from './everestoActions';
import { OWNER, commit, readFile } from './everestoManage';

type Perm = 'pull' | 'push' | 'maintain';
const ROLES = ['developers', 'maintainers', 'managers'] as const; // owner = platform-team = org owners
const RULESET = 'everesto-main';

export type AccessReport = { dryRun: boolean; actions: string[]; warnings: string[] };

export type Space = {
  name: string;
  members: Record<(typeof ROLES)[number], string[]>;
  ciRepos: string[];
  gitopsRepos: string[];
  viewers?: string[];        // read-only members (no GitHub team needed — repos are public)
  sonarProjects?: string[];  // SonarQube project keys of the space's applications
};

const slugOf = (e: any) => String(e.metadata?.annotations?.['github.com/project-slug'] ?? '').split('/')[1];

const ENTITY_ADMIN = /^group:default\/([a-z0-9-]+)-admins$/;

/** Entity admins act as maintainers of every space of their entity: add those maintainer groups to the refs. */
export async function expandEntityAdmins(refs: string[], spacesOf: (entity: string) => Promise<string[]>) {
  const extra: string[] = [];
  for (const r of refs) {
    const m = r.match(ENTITY_ADMIN);
    if (!m) continue;
    for (const space of await spacesOf(m[1])) extra.push(`group:default/${space}-managers`);
  }
  return [...new Set([...refs, ...extra])];
}

/** Read spaces, role groups and repos from the catalog. */
export async function readSpaces(getEntities: (filter: Record<string, string>) => Promise<any[]>, registry?: Record<string, string>): Promise<Space[]> {
  const systems = await getEntities({ kind: 'System', 'metadata.labels.everesto.live/level': 'space' });
  const groups = await getEntities({ kind: 'Group', 'spec.type': 'role' });
  const entityAdmins = await getEntities({ kind: 'Group', 'metadata.labels.everesto.live/role': 'entity-admin' });
  const comps = await getEntities({ kind: 'Component' });
  const res = await getEntities({ kind: 'Resource' });
  return systems.map(sys => {
    const name = sys.metadata.name as string;
    const members = Object.fromEntries(ROLES.map(r => [r,
      membersOf(groups.find(g => g.metadata.name === `${name}-${r}`)),
    ])) as Space['members'];
    // entity admins of this space's entity are maintainers here too
    const admins = ((entityAdmins.find(g => g.metadata.name === `${sys.spec?.domain}-admins`)?.spec?.members ?? []) as string[])
      .map(m => m.replace(/^user:(default\/)?/, '').toLowerCase());
    members.managers = [...new Set([...members.managers, ...admins])];
    // which repos belong to the space: the app registry (platform-controlled) — never the repo's own spec.system
    const repoOf = (e: any) => String(slugOf(e) ?? '').replace(/-gitops$/, '');
    const inSpace = (e: any) => (registry ? registry[repoOf(e)] === name : e.spec?.system === name)
      && e.metadata?.annotations?.['everesto.live/protected'] !== 'true';
    return {
      name,
      members,
      viewers: membersOf(groups.find(g => g.metadata.name === `${name}-viewers`)),
      sonarProjects: comps.filter(inSpace).map(e => e.metadata?.annotations?.['sonarqube.org/project-key']).filter(Boolean),
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
        required_approving_review_count: 1, // four eyes: nobody merges their own change alone
        dismiss_stale_reviews_on_push: true, // a new push needs a new approval
        require_code_owner_review: true, // CODEOWNERS: CI + catalog → maintainers, prod → managers
        require_last_push_approval: true, // whoever pushed last can't be the approver
        required_review_thread_resolution: false,
      },
    },
  ],
  bypass_actors: [
    { actor_id: appId, actor_type: 'Integration', bypass_mode: 'always' }, // Backstage GitHub App
    { actor_id: 1, actor_type: 'OrganizationAdmin', bypass_mode: 'always' }, // org owners: break-glass
  ],
});

/** Pure: GitHub's role names (team repo list) → the permission names the API takes. */
export const apiPermission = (roleName: string) => ({ write: 'push', read: 'pull' } as Record<string, string>)[roleName] ?? roleName;

/** Pure: CODEOWNERS of a space repo. Last matching line wins. Teams must have write access (they do: maintain / push). */
export function codeowners(space: string, kind: 'ci' | 'gitops') {
  const t = (r: string) => `@${OWNER}/${space}-${r}`;
  const head = `# Managed by Backstage (access sync) — do not edit: changes here are overwritten.\n# main needs 1 approval; for the paths below it must come from these teams.\n`;
  return kind === 'ci'
    ? `${head}/.github/            ${t('maintainers')} ${t('managers')}\n/catalog-info.yaml   ${t('maintainers')} ${t('managers')}\n`
    : `${head}*                    ${t('maintainers')} ${t('managers')}\n/apps/prod/          ${t('managers')}\n/argocd/argocd-prod.yaml ${t('managers')}\n/.github/            ${t('managers')}\n`;
}

export async function syncGithubAccess(config: Config, spaces: Space[], dryRun: boolean, platformTeam?: string[]): Promise<AccessReport> {
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

      // 2. repo permissions — current ones read once per team (GitHub names push "write", pull "read")
      const teamRepos = teamId ? ((await gh(token, 'GET', `/orgs/${OWNER}/teams/${team}/repos?per_page=100`)).json ?? []) as any[] : [];
      const repoPerms = new Map(teamRepos.map(r => [String(r.name), apiPermission(String(r.role_name ?? ''))]));
      for (const [kind, repos] of [['ci', space.ciRepos], ['gitops', space.gitopsRepos]] as const) {
        const perm = permissionFor(role, kind);
        if (!perm) continue;
        for (const repo of repos) {
          const has = repoPerms.get(repo);
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
      const existing = ((list.json ?? []) as any[]).find(r => r.name === RULESET);
      const want = rulesetBody(appId);
      if (!existing) {
        await act(`protect main of ${repo} (PR + 1 approval, code owners, no force-push, no deletion)`,
          () => gh(token, 'POST', `/repos/${OWNER}/${repo}/rulesets`, want));
      } else {
        const cur = await gh(token, 'GET', `/repos/${OWNER}/${repo}/rulesets/${existing.id}`);
        const pr = ((cur.json?.rules ?? []) as any[]).find(r => r.type === 'pull_request')?.parameters ?? {};
        const wantPr = (want.rules.find(r => r.type === 'pull_request') as any).parameters;
        if (Object.keys(wantPr).some(k => pr[k] !== wantPr[k])) {
          await act(`update main protection of ${repo} (1 approval, code owners, stale approvals dismissed)`,
            () => gh(token, 'PUT', `/repos/${OWNER}/${repo}/rulesets/${existing.id}`, want));
        }
      }
      // CODEOWNERS: who must approve which paths (written by the GitHub App — it bypasses the ruleset)
      const kind = space.gitopsRepos.includes(repo) ? 'gitops' : 'ci';
      const owners = codeowners(space.name, kind);
      const have = await readFile(token, repo, '.github/CODEOWNERS');
      if (have !== owners) {
        await act(`${have === undefined ? 'add' : 'update'} .github/CODEOWNERS in ${repo} (${kind === 'gitops' ? 'prod → managers' : 'CI + catalog → maintainers'})`,
          async () => { await commit(token, repo, 'CODEOWNERS: reviewers per path (Backstage access sync)', [{ path: '.github/CODEOWNERS', content: owners }]); return { ok: true, status: 200 }; });
      }
    }
  }
  // owners: GitHub team platform-team (ArgoCD role:admin via Dex groups)
  if (platformTeam) {
    let t = await gh(token, 'GET', `/orgs/${OWNER}/teams/platform-team`);
    if (t.status === 404) {
      await act('create team platform-team (owners)', () => gh(token, 'POST', `/orgs/${OWNER}/teams`, { name: 'platform-team', privacy: 'secret', description: 'Platform owners (managed by Backstage)' }));
      t = await gh(token, 'GET', `/orgs/${OWNER}/teams/platform-team`);
    }
    const cur = new Set<string>(t.ok ? ((await gh(token, 'GET', `/orgs/${OWNER}/teams/platform-team/members?per_page=100`)).json ?? []).map((m: any) => String(m.login).toLowerCase()) : []);
    for (const u of platformTeam) {
      if (!cur.has(u) && orgMembers.has(u)) await act(`add ${u} to team platform-team`, () => gh(token, 'PUT', `/orgs/${OWNER}/teams/platform-team/memberships/${u}`, { role: 'member' }));
    }
  }

  // ArgoCD roles: gitops-backstage/platform/argocd-config/argocd-rbac-cm.yaml (synced by ArgoCD app platform-argocd-config)
  const rbacPath = 'platform/argocd-config/argocd-rbac-cm.yaml';
  const want = argoRbacConfigMap(spaces.map(sp => sp.name));
  const cur = await gh(token, 'GET', `/repos/${OWNER}/gitops-backstage/contents/${rbacPath}?ref=main`);
  const have = cur.ok ? Buffer.from(cur.json.content, 'base64').toString('utf8') : undefined;
  if (have !== want) {
    await act(`update ArgoCD roles (${rbacPath}) for spaces ${spaces.map(sp => sp.name).join(', ')}`, () => gh(token, 'PUT', `/repos/${OWNER}/gitops-backstage/contents/${rbacPath}`, {
      message: 'argocd: roles per DevOps Space (Backstage access sync)', content: Buffer.from(want).toString('base64'), branch: 'main', ...(cur.ok ? { sha: cur.json.sha } : {}),
    }));
  }
  return report;
}

// ---------- ArgoCD RBAC (argocd-rbac-cm), generated from the spaces ----------
// Groups come from Dex/GitHub as "Everesto-Inc:<team>". Default policy: nothing.
//   developer : get (+logs, refresh) + sync      maintainer: + delete      manager: + create, update, delete
//   owner (team platform-team) = role:admin.  exec is disabled globally (argocd-cm).
export function argoRbacCsv(spaceNames: string[]) {
  const lines = [
    '# GENERATED by Backstage (everestoAccess.ts → access sync) — do not edit by hand.',
    `g, ${OWNER}:platform-team, role:admin`,
  ];
  for (const s of [...spaceNames].sort()) {
    const app = `${s}/*`;
    lines.push(
      '',
      `# DevOps Space ${s}`,
      `p, role:${s}-developer, applications, get, ${app}, allow`,
      `p, role:${s}-developer, applications, sync, ${s}/dev-*, allow`, // dev only — prod is synced by managers
      `p, role:${s}-manager, applications, sync, ${app}, allow`,
      `p, role:${s}-developer, logs, get, ${app}, allow`,
      `p, role:${s}-developer, projects, get, ${s}, allow`,
      `p, role:${s}-maintainer, applications, delete, ${app}, allow`,
      `p, role:${s}-manager, applications, create, ${app}, allow`,
      `p, role:${s}-manager, applications, update, ${app}, allow`,
      `p, role:${s}-manager, applications, delete, ${app}, allow`,
      `g, role:${s}-maintainer, role:${s}-developer`,
      `g, role:${s}-manager, role:${s}-developer`,
      `g, ${OWNER}:${s}-developers, role:${s}-developer`,
      `g, ${OWNER}:${s}-maintainers, role:${s}-maintainer`,
      `g, ${OWNER}:${s}-managers, role:${s}-manager`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function argoRbacConfigMap(spaceNames: string[]) {
  return `# ArgoCD roles per DevOps Space — GENERATED by Backstage access sync. Do not edit by hand.
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-rbac-cm
  namespace: argocd
  labels: { app.kubernetes.io/name: argocd-rbac-cm, app.kubernetes.io/part-of: argocd }
data:
  policy.default: ""          # signed in but in no team → sees nothing
  scopes: "[groups]"
  policy.csv: |
${argoRbacCsv(spaceNames).split('\n').map(l => (l ? `    ${l}` : '')).join('\n')}
`;
}
