/**
 * everesto config — the plain (non-secret) environment variables of a deployment, i.e. the `env:` block of
 * <app>-gitops/apps/<env>/deployment.yaml. Change one → Backstage commits it → Sync in ArgoCD.
 *
 *   GET  /api/everesto/apps/:repo/config?env=dev|prod   → { env, vars: [{ name, value }], editable, canEdit, reason? }
 *   POST /api/everesto/apps/:repo/config  { env, vars }  → { changed, commit, argocdApp }
 *
 * Roles: read = members · dev = developers+ · prod = managers (same as secrets).
 * Only the deployment Backstage generated (ONE Deployment, ONE container, `envFrom:`) is edited; hand-edited
 * multi-service deployments (e.g. agency-backend) are refused with a clear message.
 * Values are visible in git — secrets belong in Infisical, never here.
 */
import { Config } from '@backstage/config';
import { githubToken } from './everestoActions';
import { err } from './everestoCommon';
import { OWNER, allowed, appInfo, commit, readFile } from './everestoManage';
import { Env, NAME } from './everestoManifests';
import { ROLE } from './everestoRoles';

export type ConfigVar = { name: string; value: string };

const ENV_HEAD = /^ {10}env:.*$/;
const ENV_ITEM = /^ {12}- \{ name: ([A-Z][A-Z0-9_]*), value: ("(?:[^"\\]|\\.)*") \}/;
const ENV_FROM = /^ {10}envFrom:\s*$/m;
const MAX_VALUE = 2000;

/** Pure: can this deployment.yaml be edited here? (the generated shape) */
export function editableReason(yaml: string): string | undefined {
  if ((yaml.match(/^kind: Deployment$/gm) ?? []).length !== 1) return 'not a single generated Deployment';
  if ((yaml.match(/^ {8}- name: /gm) ?? []).length !== 1) return 'more than one container';
  if ((yaml.match(ENV_FROM) ?? []).length !== 1) return 'no `envFrom:` line where config goes';
  return undefined;
}

/** Pure: the config variables of a deployment.yaml (the `env:` block before `envFrom:`). */
export function readConfigEnv(yaml: string): ConfigVar[] {
  const lines = yaml.split('\n');
  const start = lines.findIndex(l => ENV_HEAD.test(l));
  if (start < 0) return [];
  const vars: ConfigVar[] = [];
  for (const l of lines.slice(start + 1)) {
    const m = l.match(ENV_ITEM);
    if (!m) break;
    vars.push({ name: m[1], value: JSON.parse(m[2]) });
  }
  return vars;
}

/** Pure: validate a new set of config variables (names, duplicates, size, no line breaks). */
export function checkConfigVars(vars: unknown): ConfigVar[] {
  if (!Array.isArray(vars) || vars.length > 50) throw err(400, 'vars: a list of at most 50 { name, value }');
  const seen = new Set<string>();
  return vars.map((v: any) => {
    const name = String(v?.name ?? '');
    const value = String(v?.value ?? '');
    if (!NAME.test(name)) throw err(400, `invalid variable name ${name || '(empty)'} (A-Z 0-9 _)`);
    if (seen.has(name)) throw err(400, `${name} twice`);
    seen.add(name);
    if (value.length > MAX_VALUE || /[\r\n]/.test(value)) throw err(400, `${name}: one line, at most ${MAX_VALUE} characters`);
    return { name, value };
  });
}

/** Pure: deployment.yaml with its `env:` block replaced by `vars` (removed when empty), right before `envFrom:`. */
export function setConfigEnv(yaml: string, vars: ConfigVar[]): string {
  const lines = yaml.split('\n');
  const start = lines.findIndex(l => ENV_HEAD.test(l));
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && ENV_ITEM.test(lines[end])) end++;
    lines.splice(start, end - start);
  }
  if (vars.length) {
    const at = lines.findIndex(l => ENV_FROM.test(`${l}\n`));
    if (at < 0) throw err(409, 'deployment.yaml has no `envFrom:` — edit it in git');
    lines.splice(at, 0, '          env:   # config (not secret) — Backstage → Config; wins over a secret of the same name',
      ...vars.map(v => `            - { name: ${v.name}, value: ${JSON.stringify(v.value)} }`));
  }
  return lines.join('\n');
}

async function ctx(config: Config, repo: string, env: Env) {
  const token = await githubToken(config, OWNER);
  const { project } = await appInfo(token, repo);
  const gitops = `${repo}-gitops`;
  const path = `apps/${env}/deployment.yaml`;
  const yaml = await readFile(token, gitops, path);
  return { token, project, gitops, path, yaml };
}

export async function configList(config: Config, repo: string, env: Env, refs: string[]) {
  const { project, yaml } = await ctx(config, repo, env);
  if (!allowed(refs, project, [...ROLE.MEMBER])) throw err(403, `only members of ${project} can see the config`);
  const canEdit = allowed(refs, project, [...(env === 'prod' ? ROLE.PROD : ROLE.DEV)]);
  if (yaml === undefined) return { env, vars: [], editable: false, canEdit, reason: `no ${env} deployment yet` };
  const reason = editableReason(yaml);
  return { env, vars: readConfigEnv(yaml), editable: !reason, canEdit, ...(reason ? { reason: `hand-edited deployment (${reason}) — change apps/${env}/deployment.yaml in git` } : {}) };
}

export async function configSet(config: Config, repo: string, env: Env, rawVars: unknown, refs: string[], who: string) {
  const { token, project, gitops, path, yaml } = await ctx(config, repo, env);
  const roles = env === 'prod' ? ROLE.PROD : ROLE.DEV;
  if (!allowed(refs, project, [...roles])) throw err(403, `only ${env === 'prod' ? 'managers' : 'developers, maintainers and managers'} of ${project} can change ${env} config`);
  if (yaml === undefined) throw err(404, `${repo} has no ${env} deployment`);
  const reason = editableReason(yaml);
  if (reason) throw err(409, `hand-edited deployment (${reason}) — change ${path} in git`);
  const vars = checkConfigVars(rawVars);
  const next = setConfigEnv(yaml, vars);
  if (next === yaml) return { changed: false };
  const files = [{ path, content: next }];
  if (env === 'dev') {
    // deployment.json keeps the dev config (the first Promote copies it to prod)
    const meta = JSON.parse((await readFile(token, gitops, 'deployment.json')) ?? '{}');
    files.push({ path: 'deployment.json', content: `${JSON.stringify({ ...meta, config: vars }, null, 2)}\n` });
  }
  const sha = await commit(token, gitops, `${env}: config ${vars.map(v => v.name).join(', ') || '(none)'} (Backstage, by ${who})`, files);
  return { changed: true, commit: sha, argocdApp: `${env}-${repo}` };
}
