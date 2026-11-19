/**
 * everesto spaces — real "Create space" (DevOps Space = flower name) inside an entity (rare animal).
 *
 *   one commit in everesto-catalog:  spaces/<name>.yaml (System + team Group + 4 role Groups) + a line in all.yaml
 *   then: catalog refresh (visible in seconds) + access sync (GitHub teams <name>-managers/-maintainers/-developers).
 *   ArgoCD project / namespaces / Infisical are created later, per application, by Create deployment.
 *
 * Who: owner (platform-team) or the entity's managers (<entity>-admins).
 */
import { Config } from '@backstage/config';
import { githubToken } from './everestoActions';
import { OWNER, commit, readFile } from './everestoManage';

const CATALOG = 'everesto-catalog';
const err = (status: number, message: string) => Object.assign(new Error(message), { status });

/** Suggestions (any name matching SPACE_NAME may be typed instead). */
export const FLOWERS = [
  'acacia', 'agapanthus', 'allium', 'alstroemeria', 'amaryllis', 'anemone', 'angelica', 'anthurium', 'aster', 'astilbe',
  'azalea', 'begonia', 'bellflower', 'bergenia', 'bluebell', 'bougainvillea', 'buttercup', 'calendula', 'calla', 'camellia',
  'campanula', 'candytuft', 'carnation', 'celosia', 'chamomile', 'clematis', 'clover', 'columbine', 'coneflower', 'cornflower',
  'cosmos', 'crocus', 'cyclamen', 'daffodil', 'dahlia', 'daisy', 'delphinium', 'dianthus', 'edelweiss', 'echinacea',
  'foxglove', 'freesia', 'fuchsia', 'gardenia', 'geranium', 'gerbera', 'gladiolus', 'heather', 'hellebore', 'hibiscus',
  'hollyhock', 'honeysuckle', 'hyacinth', 'hydrangea', 'impatiens', 'iris', 'ixora', 'jasmine', 'jonquil', 'kalmia',
  'lantana', 'larkspur', 'lavender', 'lilac', 'lily', 'lisianthus', 'lobelia', 'lotus', 'lupine', 'magnolia',
  'mallow', 'marigold', 'mimosa', 'narcissus', 'nasturtium', 'nemesia', 'oleander', 'orchid', 'osteospermum', 'pansy',
  'peony', 'periwinkle', 'petunia', 'phlox', 'plumeria', 'poppy', 'primrose', 'protea', 'ranunculus', 'rhododendron',
  'rose', 'salvia', 'saxifrage', 'snapdragon', 'snowdrop', 'statice', 'stephanotis', 'sunflower', 'sweetpea', 'tansy',
  'thistle', 'trillium', 'tuberose', 'tulip', 'verbena', 'veronica', 'violet', 'wisteria', 'yarrow', 'zinnia',
];

/** a-z start, a-z0-9- , 2–24 chars: leaves room for <space>-maintainers (GitHub team) within 63. */
export const SPACE_NAME = /^[a-z][a-z0-9-]{0,22}[a-z0-9]$/;
const RESERVED = ['platform', 'backstage', 'loop', 'argocd', 'default', 'system', 'admin', 'admins', 'everesto'];

/** Pure: why a name can't be used (undefined = fine). */
export function spaceNameProblem(name: string, taken: string[]): string | undefined {
  if (!SPACE_NAME.test(name)) return 'Use 2–24 characters: lowercase letters, digits and "-", starting with a letter (e.g. lotus).';
  if (RESERVED.includes(name)) return `"${name}" is reserved by the platform — choose another name.`;
  if (taken.includes(name)) return `"${name}" is already used — choose another name.`;
  return undefined;
}

const title = (name: string) => name.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

/** Pure: the catalog file of a new space (same shape as spaces/orchid.yaml). */
export function spaceYaml(name: string, entity: string, description: string, who: string) {
  const T = title(name);
  const role = (r: string, label: string, comment: string) => `---
# ${comment}
apiVersion: backstage.io/v1alpha1
kind: Group
metadata:
  name: ${name}-${r}
  title: ${T} ${r}
  labels: { everesto.live/level: space, everesto.live/role: ${label} }
spec:
  type: role
  parent: ${name}
  children: []
  members: []
`;
  return `# SPACE "${name}" of entity ${entity} — created in Backstage by ${who}.
#   System ${name} = the space · Group ${name} = the space team · Groups ${name}-<role> = the roles
#   Owner = platform-team · entity manager = ${entity}-admins (manager of every ${entity} space)
---
apiVersion: backstage.io/v1alpha1
kind: System
metadata:
  name: ${name}
  title: DevOps Space – ${T}
  description: ${JSON.stringify(description || `DevOps space of entity ${entity}`)}
  labels:
    everesto.live/level: space
    everesto.live/entity: ${entity}
spec:
  owner: ${name}
  domain: ${entity}
---
apiVersion: backstage.io/v1alpha1
kind: Group
metadata:
  name: ${name}
  title: ${T} (space)
  labels:
    everesto.live/level: space
    everesto.live/entity: ${entity}
spec:
  type: team
  parent: ${entity}
  children: [${name}-managers, ${name}-maintainers, ${name}-developers, ${name}-viewers]
${role('managers', 'manager', 'manager: maintainer + promote to prod, prod secrets, delete applications, add/remove developers & viewers')}${role('maintainers', 'maintainer', 'maintainer: create CI / repositories / deployments, deploy to dev, change tools, delete deployments')}${role('developers', 'developer', 'developer: code via pull request, dev secrets, run build — creates and deletes nothing')}${role('viewers', 'viewer', 'viewer: read only')}`;
}

/** Pure: all.yaml with ./spaces/<name>.yaml added after the last space line (idempotent). */
export function addToAll(all: string, name: string) {
  const line = `./spaces/${name}.yaml`;
  if (all.includes(line)) return all;
  const lines = all.split('\n');
  let at = -1;
  lines.forEach((l, i) => { if (/^\s*- \.\/spaces\//.test(l)) at = i; });
  if (at < 0) lines.forEach((l, i) => { if (/^\s*- \.\/entities\//.test(l)) at = i; });
  if (at < 0) throw err(500, 'all.yaml has no ./entities/ or ./spaces/ target — cannot add the space');
  const indent = lines[at].match(/^\s*/)![0];
  lines.splice(at + 1, 0, `${indent}- ${line}${' '.repeat(Math.max(1, 29 - line.length))}# space — created in Backstage`);
  return lines.join('\n');
}

export async function createSpace(config: Config, entity: string, name: string, description: string, taken: string[], who: string) {
  const problem = spaceNameProblem(name, taken);
  if (problem) throw err(409, problem);
  const token = await githubToken(config, OWNER);
  if (await readFile(token, CATALOG, `spaces/${name}.yaml`)) throw err(409, `"${name}" is already used — choose another name.`);
  const all = await readFile(token, CATALOG, 'all.yaml');
  if (!all) throw err(502, 'could not read the catalog (everesto-catalog/all.yaml) — try again in a minute');
  await commit(token, CATALOG, `spaces: ${name} in ${entity} (Backstage, by ${who})`, [
    { path: `spaces/${name}.yaml`, content: spaceYaml(name, entity, description, who) },
    { path: 'all.yaml', content: addToAll(all, name) },
  ]);
  return { done: [`DevOps Space – ${title(name)} in ${entity}`, 'roles: managers, maintainers, developers, viewers (add people in Members)'] };
}
