/**
 * App → DevOps Space registry: which space owns which repository. THE source for every permission decision.
 *
 * Lives in the PRIVATE platform repo everesto-catalog (platform/apps.yaml); only Backstage (GitHub App) and the owner
 * write it. A repo's own catalog-info.yaml (spec.system) is NOT trusted: developers can merge into their repo, so a
 * repo could otherwise claim another space and borrow that space's roles. The catalog guard (everestoCatalogGuard)
 * also forces spec.system to the registry value, so the UI shows apps only in their real space.
 *
 *   apps:
 *     python-backend: orchid      # <repo>: <space>   (<repo>-gitops belongs to the same space)
 */
import { err } from './everestoCommon';
import { parseDocument } from 'yaml';
import { commit, readFile } from './everestoManage';
import { docs } from './everestoYaml';

export const REGISTRY_REPO = 'everesto-catalog';
export const REGISTRY_FILE = 'platform/apps.yaml';
const NAME = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** Pure: registry text → { repo: space } (invalid entries ignored). */
export function parseRegistry(text: string | undefined): Record<string, string> {
  const apps = (docs(text)[0]?.apps ?? {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(apps).filter(([r, s]) => NAME.test(r) && typeof s === 'string' && NAME.test(s)) as [string, string][]);
}

/** Pure: the repo's base name (<repo>-gitops → <repo>). */
export const baseRepo = (repo: string) => repo.replace(/-gitops$/, '');

/** Pure: registry text with <repo>: <space> set (space undefined = removed). Comments and other entries kept. */
export function setRegistryEntry(text: string, repo: string, space: string | undefined): string {
  const d = parseDocument(text || 'apps: {}\n');
  if (space === undefined) d.deleteIn(['apps', repo]);
  else d.setIn(['apps', repo], space);
  return d.toString({ lineWidth: 0 });
}

let cache: { at: number; map: Record<string, string> } | undefined;
const TTL = 30_000;

export async function readRegistry(token: string, fresh = false): Promise<Record<string, string>> {
  if (!fresh && cache && Date.now() - cache.at < TTL) return cache.map;
  const text = await readFile(token, REGISTRY_REPO, REGISTRY_FILE);
  if (text === undefined) throw err(502, `cannot read the app registry (${REGISTRY_REPO}/${REGISTRY_FILE}) — try again in a minute`);
  cache = { at: Date.now(), map: parseRegistry(text) };
  return cache.map;
}

/** The space that owns a repo (or its -gitops twin); undefined = not registered. */
export async function spaceOf(token: string, repo: string) {
  return (await readRegistry(token))[baseRepo(repo)];
}

export async function registerApp(token: string, repo: string, space: string, who: string) {
  if (!NAME.test(repo) || !NAME.test(space)) throw err(400, 'invalid repo or space name');
  const text = (await readFile(token, REGISTRY_REPO, REGISTRY_FILE)) ?? '';
  const cur = parseRegistry(text)[repo];
  if (cur === space) return;
  if (cur) throw err(409, `${repo} already belongs to space ${cur} — only the platform team can move it`);
  await commit(token, REGISTRY_REPO, `apps: ${repo} → ${space} (Backstage, by ${who})`, [{ path: REGISTRY_FILE, content: setRegistryEntry(text, repo, space) }]);
  cache = undefined;
}

export async function unregisterApp(token: string, repo: string, who: string) {
  const text = await readFile(token, REGISTRY_REPO, REGISTRY_FILE);
  if (!text || !parseRegistry(text)[repo]) return;
  await commit(token, REGISTRY_REPO, `apps: ${repo} removed (Backstage, by ${who})`, [{ path: REGISTRY_FILE, content: setRegistryEntry(text, repo, undefined) }]);
  cache = undefined;
}

