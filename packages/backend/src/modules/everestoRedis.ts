/**
 * everesto redis — the "Redis" switch of Create deployment.
 *
 * NO Redis per app: every app gets its own ACL user + key prefix in the SHARED platform Redis
 * (tools VM, Ansible playbooks/05_install_redis.yml — UI: https://redis.everesto.live).
 *
 *   user     <space>-<repo>         dev        e.g. orchid-agency-backend
 *            <space>-<repo>-prod    prod       (own user + own keys: dev and prod never share data)
 *   keys     <user>:*  only (Redis ACL key pattern) — the app must prefix its keys with REDIS_KEY_PREFIX
 *   commands everything except @dangerous (FLUSHALL, FLUSHDB, KEYS, CONFIG, DEBUG, SHUTDOWN, …)
 *   secrets  REDIS_URL + REDIS_KEY_PREFIX → the app's Infisical project (dev / prod) → pod env via ESO
 *
 * Backstage itself logs in as ACL user "backstage", which may only manage users (ACL SETUSER/DELUSER/
 * GETUSER/SAVE) — it can't read or write any data. Config (app-config.production.yaml):
 *   redis.adminUrl  redis://backstage:<password>@<host>:6379   (env REDIS_ADMIN_URL, from Infisical)
 *   redis.appHost   host:port the apps connect to              (default: host of adminUrl)
 * Until redis.adminUrl is set, the switch is refused with a clear message (like Infisical).
 */
import { randomBytes } from 'crypto';
import { connect } from 'net';
import { Config } from '@backstage/config';
import { err } from './everestoCommon';

export type RedisEnv = 'dev' | 'prod';
export type RedisSecret = { name: string; value: string };

export const REDIS_SECRET_NAMES = ['REDIS_URL', 'REDIS_KEY_PREFIX'] as const;

// ---------- naming + rules (pure) ----------

/** ACL user of an app: <space>-<repo>, prod gets "-prod". */
export const redisUser = (space: string, repo: string, env: RedisEnv) => `${space}-${repo}${env === 'prod' ? '-prod' : ''}`;
export const redisKeyPrefix = (user: string) => `${user}:`;

/** ACL SETUSER arguments: reset first, so re-running gives exactly these rights (idempotent). */
export const aclSetUser = (user: string, password: string) => [
  'ACL', 'SETUSER', user, 'reset', 'on', `>${password}`, `~${redisKeyPrefix(user)}*`, '+@all', '-@dangerous',
];

export const appRedisUrl = (appHost: string, user: string, password: string) =>
  `redis://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${appHost}/0`;

export function redisSecrets(appHost: string, user: string, password: string): RedisSecret[] {
  return [
    { name: 'REDIS_URL', value: appRedisUrl(appHost, user, password) },
    { name: 'REDIS_KEY_PREFIX', value: redisKeyPrefix(user) },
  ];
}

// ---------- minimal RESP client (only what the ACL commands need — no dependency) ----------

export function encodeCommand(args: string[]): Buffer {
  const parts = [`*${args.length}\r\n`, ...args.map(a => `$${Buffer.byteLength(a)}\r\n${a}\r\n`)];
  return Buffer.from(parts.join(''), 'utf8');
}

export type Reply = string | number | null | Reply[] | { error: string };

/** Parse ONE reply at `pos`. Returns undefined when the buffer doesn't hold a complete reply yet. */
export function parseReply(buf: Buffer, pos = 0): { value: Reply; next: number } | undefined {
  const eol = buf.indexOf('\r\n', pos);
  if (eol < 0) return undefined;
  const type = String.fromCharCode(buf[pos]);
  const line = buf.toString('utf8', pos + 1, eol);
  switch (type) {
    case '+': return { value: line, next: eol + 2 };
    case '-': return { value: { error: line }, next: eol + 2 };
    case ':': return { value: Number(line), next: eol + 2 };
    case '$': {
      const len = Number(line);
      if (len < 0) return { value: null, next: eol + 2 };
      if (buf.length < eol + 2 + len + 2) return undefined;
      return { value: buf.toString('utf8', eol + 2, eol + 2 + len), next: eol + 2 + len + 2 };
    }
    case '*': {
      const n = Number(line);
      if (n < 0) return { value: null, next: eol + 2 };
      const items: Reply[] = [];
      let at = eol + 2;
      for (let i = 0; i < n; i++) {
        const r = parseReply(buf, at);
        if (!r) return undefined;
        items.push(r.value);
        at = r.next;
      }
      return { value: items, next: at };
    }
    default: throw new Error(`Redis: unexpected reply type '${type}'`);
  }
}

export function parseAdminUrl(url: string) {
  const u = new URL(url);
  if (u.protocol !== 'redis:') throw new Error('redis.adminUrl must start with redis://');
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    user: decodeURIComponent(u.username || 'default'),
    password: decodeURIComponent(u.password),
  };
}

/** Run commands in order on one connection (AUTH first). Throws on the first error reply. */
export async function redisRun(adminUrl: string, commands: string[][], timeoutMs = 5000): Promise<Reply[]> {
  const { host, port, user, password } = parseAdminUrl(adminUrl);
  const all = [...(password ? [['AUTH', user, password]] : []), ...commands];
  return new Promise((resolve, reject) => {
    const sock = connect({ host, port });
    let buf = Buffer.alloc(0);
    const replies: Reply[] = [];
    const done = (e?: Error) => { sock.destroy(); if (e) reject(e); else resolve(replies.slice(password ? 1 : 0)); };
    sock.setTimeout(timeoutMs, () => done(new Error(`Redis ${host}:${port}: timeout`)));
    sock.on('error', e => done(new Error(`Redis ${host}:${port}: ${e.message}`)));
    sock.on('connect', () => sock.write(Buffer.concat(all.map(encodeCommand))));
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const r = parseReply(buf);
        if (!r) break;
        buf = buf.subarray(r.next);
        if (r.value && typeof r.value === 'object' && 'error' in r.value) {
          // never echo the command (it may hold a password) — only which one failed
          done(new Error(`Redis: ${all[replies.length][0]} ${all[replies.length][1] ?? ''} failed: ${r.value.error}`));
          return;
        }
        replies.push(r.value);
        if (replies.length === all.length) { done(); return; }
      }
    });
  });
}

// ---------- flows ----------

export const redisConfigured = (config: Config) => !!config.getOptionalString('redis.adminUrl');

function settings(config: Config) {
  const adminUrl = config.getOptionalString('redis.adminUrl');
  if (!adminUrl) {
    throw err(409, 'Redis is not connected to Backstage yet (redis.adminUrl / REDIS_ADMIN_URL) — create the deployment without Redis, or ask the platform team');
  }
  const { host, port } = parseAdminUrl(adminUrl);
  return { adminUrl, appHost: config.getOptionalString('redis.appHost') ?? `${host}:${port}` };
}

/** Create (or reset) the app's ACL user for one environment. Returns the secrets for Infisical. */
export async function redisProvision(config: Config, space: string, repo: string, env: RedisEnv) {
  const { adminUrl, appHost } = settings(config);
  const user = redisUser(space, repo, env);
  const password = randomBytes(24).toString('hex');
  await redisRun(adminUrl, [aclSetUser(user, password), ['ACL', 'SAVE']]);
  return { user, prefix: redisKeyPrefix(user), secrets: redisSecrets(appHost, user, password) };
}

/** Remove the app's ACL users (dev + prod). Its keys are left to expire / to clean up in the Redis UI. */
export async function redisRemove(config: Config, space: string, repo: string): Promise<{ done: string[]; warn: string[] }> {
  const adminUrl = config.getOptionalString('redis.adminUrl');
  if (!adminUrl) return { done: [], warn: [] };
  const users = (['dev', 'prod'] as const).map(e => redisUser(space, repo, e));
  try {
    const [deleted] = await redisRun(adminUrl, [['ACL', 'DELUSER', ...users], ['ACL', 'SAVE']]);
    return {
      done: Number(deleted) > 0 ? [`Redis ACL users ${users.join(' / ')} (keys ${redisKeyPrefix(users[0])}* left to expire — clean up in https://redis.everesto.live)`] : [],
      warn: [],
    };
  } catch (e: any) {
    return { done: [], warn: [`Redis: could not remove users ${users.join(', ')} — remove them by hand (ACL DELUSER): ${e.message}`] };
  }
}
