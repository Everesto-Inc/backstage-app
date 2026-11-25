import { commentTags, missingRequired, parseEnvExample } from './everestoEnvTemplate';

describe('parseEnvExample', () => {
  const text = [
    '# Local secrets file is .env (gitignored).',
    '',
    'DATABASE_URL=                    # mysql://user:pass@host:3306/db',
    'SENTRY_DSN=                      # optional — error reporting',
    'LOG_LEVEL=info                   # Optional: debug | info',
    'export API_TOKEN="ab#c"          # quoted value keeps its #',
    'URL_WITH_HASH=https://x/#frag    # a # without a space before it is part of the value',
    'lowercase=1',
    'not a variable',
    'DATABASE_URL=                    # required (redefined: last wins)',
  ].join('\n');
  const { vars, ignored } = parseEnvExample(text);
  const by = Object.fromEntries(vars.map(v => [v.name, v]));

  it('reads names in order, last definition wins', () => {
    expect(vars.map(v => v.name)).toEqual(['SENTRY_DSN', 'LOG_LEVEL', 'API_TOKEN', 'URL_WITH_HASH', 'DATABASE_URL']);
    expect(by.DATABASE_URL.hint).toBe('required (redefined: last wins)');
  });

  it('required unless the comment says optional (any case)', () => {
    expect(by.DATABASE_URL.required).toBe(true);
    expect(by.SENTRY_DSN.required).toBe(false);
    expect(by.LOG_LEVEL.required).toBe(false);
  });

  it('keeps example values and hints, handles quotes, export and # in values', () => {
    expect(by.LOG_LEVEL.example).toBe('info');
    expect(by.API_TOKEN).toEqual({ name: 'API_TOKEN', kind: 'secret', required: true, hint: 'quoted value keeps its #', example: 'ab#c' });
    expect(by.URL_WITH_HASH.example).toBe('https://x/#frag');
    expect(by.SENTRY_DSN.example).toBeUndefined();
  });

  it('reports lines that are not variables', () => {
    expect(ignored).toEqual(['lowercase=1', 'not a variable']);
  });
});

describe('comment tags: config / secret / optional', () => {
  const { vars } = parseEnvExample([
    'API_URL=https://agency-dev.everesto.live   # config — backend address',
    'LOG_LEVEL=info                             # config, optional — debug | info',
    'DATABASE_URL=                              # secret — mysql://…',
    'SENTRY_DSN=                                # Secret, Optional: error reporting',
    'API_KEY=                                   # key of the provider',
    'OLD_STYLE=                                 # optional — like before',
    'WEBHOOK=                                   # Slack webhook (optional)',
    'BARE=x',
  ].join('\n'));
  const by = Object.fromEntries(vars.map(v => [v.name, v]));

  it('config → Config, pre-filled with the value; the hint is the text after the tags', () => {
    expect(by.API_URL).toEqual({ name: 'API_URL', kind: 'config', required: true, hint: 'backend address', example: 'https://agency-dev.everesto.live' });
    expect(by.LOG_LEVEL).toMatchObject({ kind: 'config', required: false, hint: 'debug | info', example: 'info' });
  });

  it('secret (or no tag) → Secrets; optional anywhere keeps working', () => {
    expect(by.DATABASE_URL).toMatchObject({ kind: 'secret', required: true, hint: 'mysql://…' });
    expect(by.SENTRY_DSN).toMatchObject({ kind: 'secret', required: false, hint: 'error reporting' });
    expect(by.API_KEY).toMatchObject({ kind: 'secret', required: true, hint: 'key of the provider' });
    expect(by.OLD_STYLE).toMatchObject({ kind: 'secret', required: false, hint: 'like before' });
    expect(by.WEBHOOK).toMatchObject({ kind: 'secret', required: false, hint: 'Slack webhook (optional)' });
    expect(by.BARE).toEqual({ name: 'BARE', kind: 'secret', required: true, example: 'x' });
  });

  it('tags only count at the start of the comment', () => {
    expect([...commentTags('the config file path').tags]).toEqual([]);
    expect(commentTags('configuration of X').tags.size).toBe(0); // a word starting with "config" is not the tag
    expect([...commentTags('config,optional').tags]).toEqual(['config', 'optional']);
    expect(commentTags('config').hint).toBe('');
  });
});

describe('missingRequired', () => {
  const vars = [
    { name: 'DATABASE_URL', required: true },
    { name: 'REDIS_URL', required: true },
    { name: 'SENTRY_DSN', required: false },
  ];

  it('lists required variables without a value', () => {
    expect(missingRequired(vars, [{ name: 'DATABASE_URL', value: '  ' }])).toEqual(['DATABASE_URL', 'REDIS_URL']);
    expect(missingRequired(vars, [{ name: 'DATABASE_URL', value: 'x' }, { name: 'REDIS_URL', value: 'y' }])).toEqual([]);
  });

  it('exempts what the Redis switch provides', () => {
    expect(missingRequired(vars, [{ name: 'DATABASE_URL', value: 'x' }], ['REDIS_URL', 'REDIS_KEY_PREFIX'])).toEqual([]);
  });
});
