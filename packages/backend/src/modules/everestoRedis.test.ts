import { ConfigReader } from '@backstage/config';
import {
  aclSetUser, appRedisUrl, encodeCommand, parseAdminUrl, parseReply, redisKeyPrefix, redisProvision, redisRemove,
  redisRun, redisSecrets, redisUser,
} from './everestoRedis';
import { ownerRemovals } from './everestoAccess';

describe('redis naming + rules', () => {
  it('names users <space>-<repo>, prod separately', () => {
    expect(redisUser('orchid', 'agency-backend', 'dev')).toBe('orchid-agency-backend');
    expect(redisUser('orchid', 'agency-backend', 'prod')).toBe('orchid-agency-backend-prod');
    expect(redisKeyPrefix('orchid-agency-backend')).toBe('orchid-agency-backend:');
  });

  it('limits the user to its prefix and denies dangerous commands; resets first (idempotent)', () => {
    const args = aclSetUser('orchid-x', 'pw');
    expect(args.slice(0, 5)).toEqual(['ACL', 'SETUSER', 'orchid-x', 'reset', 'on']);
    expect(args).toContain('~orchid-x:*');
    expect(args).not.toContain('~*');
    expect(args.slice(-2)).toEqual(['+@all', '-@dangerous']);
  });

  it('builds REDIS_URL + REDIS_KEY_PREFIX for Infisical', () => {
    expect(appRedisUrl('192.0.2.10:6379', 'orchid-x', 'p@ss')).toBe('redis://orchid-x:p%40ss@192.0.2.10:6379/0');
    expect(redisSecrets('h:1', 'u', 'p').map(s => s.name)).toEqual(['REDIS_URL', 'REDIS_KEY_PREFIX']);
  });

  it('parses the admin URL', () => {
    expect(parseAdminUrl('redis://backstage:s%3Acret@192.0.2.10:6379')).toEqual({ host: '192.0.2.10', port: 6379, user: 'backstage', password: 's:cret' });
    expect(() => parseAdminUrl('http://x')).toThrow(/redis:\/\//);
  });
});

describe('RESP', () => {
  it('encodes commands', () => {
    expect(encodeCommand(['ACL', 'SAVE']).toString()).toBe('*2\r\n$3\r\nACL\r\n$4\r\nSAVE\r\n');
    expect(encodeCommand(['é']).toString()).toBe('*1\r\n$2\r\né\r\n'); // byte length, not char length
  });

  it('parses replies, incl. partial buffers', () => {
    expect(parseReply(Buffer.from('+OK\r\n'))!.value).toBe('OK');
    expect(parseReply(Buffer.from(':2\r\n'))!.value).toBe(2);
    expect(parseReply(Buffer.from('-ERR no\r\n'))!.value).toEqual({ error: 'ERR no' });
    expect(parseReply(Buffer.from('$-1\r\n'))!.value).toBeNull();
    expect(parseReply(Buffer.from('*2\r\n$1\r\na\r\n:1\r\n'))!.value).toEqual(['a', 1]);
    expect(parseReply(Buffer.from('$5\r\nab'))).toBeUndefined();
    expect(parseReply(Buffer.from('*2\r\n$1\r\na\r\n'))).toBeUndefined();
  });
});

describe('ownerRemovals (platform-team / sonar-administrators)', () => {
  it('removes owners no longer wanted', () => {
    expect(ownerRemovals(['alice', 'bob'], ['alice'])).toEqual(['bob']);
  });
  it('never removes everyone when the wanted list is empty (catalog read error)', () => {
    expect(ownerRemovals(['alice', 'bob'], [])).toEqual([]);
  });
});

/**
 * Real Redis, like the tools VM: an ACL file, a "backstage" user that may ONLY manage users.
 *   docker run -d --name redis-acl-test -p 127.0.0.1:16399:6379 redis:7-alpine sh -c \
 *     'printf "user default on nopass ~* &* +@all\nuser backstage on >bs-pass -@all +acl|setuser +acl|deluser +acl|getuser +acl|save +ping\n" > /data/users.acl && redis-server --aclfile /data/users.acl'
 *   REDIS_ACL_TEST_URL=redis://backstage:bs-pass@127.0.0.1:16399 yarn test everestoRedis
 */
const TEST_URL = process.env.REDIS_ACL_TEST_URL;
(TEST_URL ? describe : describe.skip)('against a real Redis (REDIS_ACL_TEST_URL)', () => {
  const config = new ConfigReader({ redis: { adminUrl: TEST_URL } });

  it('provisions an isolated app user, which cannot touch other keys or flush', async () => {
    const { user, secrets } = await redisProvision(config, 'orchid', 'it-app', 'dev');
    const appUrl = secrets.find(s => s.name === 'REDIS_URL')!.value.replace(/\/0$/, '');
    expect(user).toBe('orchid-it-app');

    // inside its prefix: allowed
    expect(await redisRun(appUrl, [['SET', 'orchid-it-app:k', 'v'], ['GET', 'orchid-it-app:k']])).toEqual(['OK', 'v']);
    // outside its prefix / dangerous: denied
    await expect(redisRun(appUrl, [['GET', 'portfolio:session']])).rejects.toThrow(/NOPERM/);
    await expect(redisRun(appUrl, [['FLUSHALL']])).rejects.toThrow(/NOPERM/);
    await expect(redisRun(appUrl, [['KEYS', '*']])).rejects.toThrow(/NOPERM/);
    // backstage itself can't read data
    await expect(redisRun(TEST_URL!, [['GET', 'orchid-it-app:k']])).rejects.toThrow(/NOPERM/);

    // re-provision = new password, old one stops working
    const again = await redisProvision(config, 'orchid', 'it-app', 'dev');
    await expect(redisRun(appUrl, [['PING']])).rejects.toThrow(/WRONGPASS|invalid/i);
    expect(again.user).toBe(user);

    const removed = await redisRemove(config, 'orchid', 'it-app');
    expect(removed.warn).toEqual([]);
    expect(removed.done[0]).toContain('orchid-it-app');
    const appUrl2 = again.secrets[0].value.replace(/\/0$/, '');
    await expect(redisRun(appUrl2, [['PING']])).rejects.toThrow(/WRONGPASS|invalid/i);
  });

  it('refuses clearly when Redis is not configured', async () => {
    await expect(redisProvision(new ConfigReader({}), 'orchid', 'x', 'dev')).rejects.toThrow(/not connected/);
    expect(await redisRemove(new ConfigReader({}), 'orchid', 'x')).toEqual({ done: [], warn: [] });
  });
});
