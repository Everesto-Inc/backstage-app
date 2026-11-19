import { discoveryApiRef, fetchApiRef, useApi } from '@backstage/core-plugin-api';

/**
 * ONE way to call the everesto backend (/api/everesto) — with error messages a person can act on.
 * The backend already says what/why for its own checks (403 "only maintainers of orchid…", 409 "namespace used…");
 * this adds the cases it can't: expired session, no connection, gateway/timeouts, non-JSON answers.
 */
export function friendlyError(status: number, serverMessage?: string): string {
  if (serverMessage && status !== 502 && status !== 503 && status !== 504) return serverMessage;
  switch (status) {
    case 0: return 'No connection to Backstage — check your network and try again.';
    case 401: return 'Your session has expired — reload the page and sign in again.';
    case 403: return 'You do not have the role for this action in this space.';
    case 404: return 'Not found — it may have been deleted meanwhile. Reload the page.';
    case 429: return 'Too many requests to GitHub right now — wait a minute and try again.';
    case 502: return `Backstage could not reach GitHub, Infisical or the cluster${serverMessage ? ` (${serverMessage})` : ''} — try again in a minute.`;
    case 503:
    case 504: return 'Backstage is busy or restarting — try again in a minute.';
    default: return serverMessage ?? `Unexpected error (HTTP ${status}) — try again; if it repeats, tell the platform team.`;
  }
}

export class EverestoError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const useEveresto = () => {
  const discovery = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  return async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const base = await discovery.getBaseUrl('everesto');
    let res: Response;
    try {
      res = await fetchApi.fetch(`${base}${path}`, {
        method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new EverestoError(0, friendlyError(0));
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new EverestoError(res.status, friendlyError(res.status, json?.error));
    return json;
  };
};
