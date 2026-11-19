/**
 * YAML reading/editing for everesto — a real parser (yaml 2.x) instead of regexes.
 *
 * Edits go through the yaml Document API on ONLY the document that changes; every other document of a
 * multi-document file is returned byte-for-byte (comments, order, formatting of hand-edited files survive).
 */
import { err } from './everestoCommon';
import { Document, isMap, isSeq, parseAllDocuments, parseDocument } from 'yaml';

type Obj = Record<string, any>;
const SEP = /\n---[ \t]*\n/;

/** All documents of a (multi-document) YAML text as plain objects; unparsable/empty docs are skipped. */
export function docs(text: string | undefined): Obj[] {
  if (!text) return [];
  return parseAllDocuments(text)
    .filter(d => !(d as any).errors?.length)
    .map(d => (d as Document).toJS() as Obj)
    .filter(d => d && typeof d === 'object');
}

/** First document of kind <kind> (and name <name> when given). */
export function findDoc(text: string | undefined, kind: string, name?: string): Obj | undefined {
  return docs(text).find(d => d.kind === kind && (name === undefined || d.metadata?.name === name));
}

/** Edit the ONE document matching (kind, name); the others stay exactly as they were. Returns undefined if none matches. */
export function editDoc(text: string, kind: string, name: string | undefined, edit: (d: Document) => void): string | undefined {
  const parts = text.split(SEP);
  const seps = text.match(new RegExp(SEP.source, 'g')) ?? [];
  let hit = false;
  const out = parts.map(part => {
    if (hit) return part;
    const d = parseDocument(part);
    const js = d.toJS() as Obj | null;
    if (!js || js.kind !== kind || (name !== undefined && js.metadata?.name !== name)) return part;
    hit = true;
    edit(d);
    const s = d.toString({ lineWidth: 0, flowCollectionPadding: false });
    return part.endsWith('\n') ? s : s.replace(/\n$/, '');
  });
  if (!hit) return undefined;
  return out.reduce((acc, p, i) => acc + p + (seps[i] ?? ''), '');
}

/** Members of Group <group> (spec.members). */
export function groupMembers(text: string, group: string): string[] {
  return ((findDoc(text, 'Group', group)?.spec?.members ?? []) as string[]).map(String);
}

/** Set spec.members of Group <group> (kept as a one-line flow list, like the hand-written files). */
export function setGroupMembers(text: string, group: string, change: (m: string[]) => string[]): string {
  const out = editDoc(text, 'Group', group, d => {
    const cur = ((d.getIn(['spec', 'members']) as any)?.toJSON?.() ?? []) as string[];
    const node = d.createNode(change(cur.map(String)));
    if (isSeq(node)) node.flow = true;
    if (!isMap(d.get('spec'))) d.set('spec', d.createNode({}));
    d.setIn(['spec', 'members'], node);
  });
  if (out === undefined) throw err(404, `group ${group} not found in the catalog`);
  return out;
}

/** Add or remove ONE annotation of the document (kind, name). Value undefined = remove. */
export function setAnnotation(text: string, kind: string, name: string | undefined, key: string, value: string | undefined): string {
  const out = editDoc(text, kind, name, d => {
    if (value === undefined) d.deleteIn(['metadata', 'annotations', key]);
    else d.setIn(['metadata', 'annotations', key], value);
  });
  if (out === undefined) throw err(409, `catalog-info.yaml has no ${kind}${name ? ` ${name}` : ''}`);
  return out;
}

/** The Backstage application in a repo's catalog-info.yaml: its Component (system, annotations). */
export function component(text: string | undefined) {
  const c = findDoc(text, 'Component');
  return c ? { name: String(c.metadata?.name ?? ''), system: c.spec?.system ? String(c.spec.system) : undefined, annotations: (c.metadata?.annotations ?? {}) as Record<string, string> } : undefined;
}

/** kustomization.yaml: the image tag (images[0].newTag). */
export const kustomizeTag = (text: string | undefined): string | undefined => {
  const k = docs(text)[0];
  const t = k?.images?.[0]?.newTag;
  return t === undefined ? undefined : String(t);
};

/** kustomization.yaml with images[0].newTag := tag (everything else unchanged). */
export function setKustomizeTag(text: string, tag: string): string {
  const d = parseDocument(text);
  if (!isSeq(d.get('images'))) throw err(409, 'kustomization.yaml has no images: section');
  d.setIn(['images', 0, 'newTag'], tag);
  return d.toString({ lineWidth: 0, flowCollectionPadding: false });
}

/** ClusterSecretStore(s) of a deployment: Infisical project slug + API url. */
export function infisicalStore(text: string | undefined): { slug?: string; url?: string } {
  const s = docs(text).find(d => d.kind === 'ClusterSecretStore');
  const inf = s?.spec?.provider?.infisical;
  return { slug: inf?.secretsScope?.projectSlug, url: inf?.hostAPI };
}

/** Destination namespaces of every ArgoCD Application in the text. */
export function appNamespaces(text: string | undefined): string[] {
  return docs(text).filter(d => d.kind === 'Application').map(d => String(d.spec?.destination?.namespace ?? '')).filter(Boolean);
}
