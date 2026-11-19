/** Small helpers shared by the everesto backend modules. */

/** An Error that carries the HTTP status the route should answer with (400 / 403 / 404 / 409 / 502 …). */
export const err = (status: number, message: string) => Object.assign(new Error(message), { status });

/** "user:default/Jacer7" | "user:jacer7" | "jacer7" → "jacer7" (catalog user name = lowercase GitHub login). */
export const userName = (ref: string) => ref.replace(/^user:(default\/)?/, '').toLowerCase();

/** Members of a catalog Group (spec.members) as user names. */
export const membersOf = (group: { spec?: { members?: unknown } } | undefined) =>
  ((group?.spec?.members ?? []) as string[]).map(userName);
