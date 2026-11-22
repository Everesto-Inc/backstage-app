/**
 * everesto env template — "Create deployment" pre-fills the secrets from the app's own .env.example.
 *
 *   GET /api/everesto/apps/:repo/env-template   → { found, path, vars: [{ name, required, hint, example }] }
 *
 * Convention for .env.example (repo root; values are EXAMPLES only, never real secrets):
 *   DATABASE_URL=            # required unless the comment says "optional"
 *   SENTRY_DSN=              # optional — may stay empty (CHANGE_ME in Infisical)
 *   LOG_LEVEL=info           # the comment is shown as a hint, the value as a placeholder
 * Required variables must get a value to create the deployment — enforced here too, not only in the dialog.
 * Variables the Redis switch provides (REDIS_URL, REDIS_KEY_PREFIX) are exempt when Redis is ticked.
 */
import { Config } from '@backstage/config';
import { err } from './everestoCommon';
import { githubToken } from './everestoActions';
import { OWNER, allowed, appInfo, readFile } from './everestoManage';
import { ROLE } from './everestoRoles';

export const ENV_TEMPLATE_PATH = '.env.example';
const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

export type EnvVar = { name: string; required: boolean; hint?: string; example?: string };

/** Pure: parse a .env.example. Order kept; a repeated name keeps its last definition. */
export function parseEnvExample(text: string): { vars: EnvVar[]; ignored: string[] } {
  const byName = new Map<string, EnvVar>();
  const ignored: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([^=\s]+)\s*=(.*)$/);
    if (!m || !NAME.test(m[1])) { ignored.push(line.slice(0, 80)); continue; }
    const [, name, rest] = m;
    let value = rest.trim();
    let comment = '';
    const quoted = value.match(/^(["'])(.*?)\1\s*(?:#\s*(.*))?$/);
    if (quoted) {
      value = quoted[2];
      comment = quoted[3] ?? '';
    } else {
      const hash = value.search(/(^|\s)#/); // an inline comment needs whitespace before '#'
      if (hash >= 0) {
        comment = value.slice(hash).replace(/^\s*#\s*/, '');
        value = value.slice(0, hash).trim();
      }
    }
    comment = comment.trim();
    byName.delete(name); // re-insert: last definition wins, at its position
    byName.set(name, {
      name,
      required: !/\boptional\b/i.test(comment),
      ...(comment ? { hint: comment } : {}),
      ...(value ? { example: value } : {}),
    });
  }
  return { vars: [...byName.values()], ignored };
}

/** Pure: required variables without a value (exempt: what the Redis switch provides). */
export function missingRequired(vars: EnvVar[], given: { name: string; value?: string }[], provided: readonly string[] = []) {
  const filled = new Set(given.filter(s => (s.value ?? '').trim()).map(s => s.name));
  return vars.filter(v => v.required && !provided.includes(v.name) && !filled.has(v.name)).map(v => v.name);
}

export async function readEnvTemplate(token: string, repo: string) {
  const text = await readFile(token, repo, ENV_TEMPLATE_PATH);
  if (text === undefined) return { found: false, path: ENV_TEMPLATE_PATH, vars: [] as EnvVar[], ignored: [] as string[] };
  return { found: true, path: ENV_TEMPLATE_PATH, ...parseEnvExample(text) };
}

/** Members of the app's space may read the template (names + hints only — it's a file in the repo anyway). */
export async function envTemplate(config: Config, repo: string, refs: string[]) {
  const token = await githubToken(config, OWNER);
  const { project } = await appInfo(token, repo);
  if (!allowed(refs, project, [...ROLE.MEMBER])) throw err(403, `only members of ${project} can read ${repo}'s template`);
  return { ...(await readEnvTemplate(token, repo)), url: `https://github.com/${OWNER}/${repo}/blob/main/${ENV_TEMPLATE_PATH}` };
}
