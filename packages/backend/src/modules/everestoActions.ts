/**
 * Custom Software Template actions for the everesto.live portal.
 *
 *   everesto:sonarqube:setup   → SonarQube project + project-only analysis token, stored
 *                                DIRECTLY as an encrypted GitHub Actions secret in the new repo
 *                                (the token never appears in task logs, outputs or the DB)
 *   everesto:github:secure-repo → secret scanning + push protection on a (public) repo
 *   everesto:space:require-member → the user is developer+ of the chosen space (first template step)
 *   everesto:app:register      → app registry entry: which space owns the new repo (platform-controlled)
 *
 * CD is not a template action: Create deployment (everestoDeploy) creates <repo>-gitops; CI never deploys.
 *
 * Credentials: GitHub = the GitHub App (integrations.github), SonarQube = sonarqube.apiKey.
 */
import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import {
  createTemplateAction,
  scaffolderActionsExtensionPoint,
} from '@backstage/plugin-scaffolder-node';
import {
  DefaultGithubCredentialsProvider,
  ScmIntegrations,
} from '@backstage/integration';
import { Config } from '@backstage/config';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import sodium from 'libsodium-wrappers';
import { registerApp as registerAppInRegistry } from './everestoRegistry';

const OWNER_ORG = 'Everesto-Inc';

const GH = 'https://api.github.com';

/** Installation token of the GitHub App for an owner (e.g. Everesto-Inc). */
// ONE provider per config: it caches the GitHub App installation token (~1 h) — a new provider per call
// minted a fresh token on every request (2 extra GitHub round trips ≈ 0.4 s per click / card).
const providers = new WeakMap<Config, DefaultGithubCredentialsProvider>();
export async function githubToken(config: Config, owner: string): Promise<string> {
  let provider = providers.get(config);
  if (!provider) {
    provider = DefaultGithubCredentialsProvider.fromIntegrations(ScmIntegrations.fromConfig(config));
    providers.set(config, provider);
  }
  const { token } = await provider.getCredentials({ url: `https://github.com/${owner}` });
  if (!token) throw new Error(`No GitHub App installation for ${owner}`);
  return token;
}

export async function gh(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${GH}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, json: text ? JSON.parse(text) : undefined };
}

export async function setRepoSecret(token: string, owner: string, repo: string, name: string, value: string) {
  const key = await gh(token, 'GET', `/repos/${owner}/${repo}/actions/secrets/public-key`);
  if (!key.ok) throw new Error(`GitHub: cannot read secrets public key (${key.status})`);
  await sodium.ready;
  const sealed = sodium.crypto_box_seal(
    sodium.from_string(value),
    sodium.from_base64(key.json.key, sodium.base64_variants.ORIGINAL),
  );
  const res = await gh(token, 'PUT', `/repos/${owner}/${repo}/actions/secrets/${name}`, {
    encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL),
    key_id: key.json.key_id,
  });
  if (!res.ok) throw new Error(`GitHub: cannot set secret ${name} (${res.status})`);
}

/** SonarQube API (POST, form-encoded) with the backstage-bot token from sonarqube.apiKey. */
export function sonarApi(config: Config) {
  const baseUrl = config.getOptionalString('sonarqube.baseUrl');
  const apiKey = config.getOptionalString('sonarqube.apiKey');
  if (!baseUrl || !apiKey) throw new Error('sonarqube.baseUrl / sonarqube.apiKey not configured');
  const auth = `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
  const post = async (path: string, params: Record<string, string>) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    const text = await res.text();
    let json: any;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
    return { status: res.status, ok: res.ok, json };
  };
  /** Any method; JSON body (web API v2) — GET/DELETE without body. */
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: auth, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
    return { status: res.status, ok: res.ok, json };
  };
  return { baseUrl, post, call };
}

/** Create SonarQube project + project-only analysis token → encrypted GitHub secret SONAR_TOKEN. */
export async function sonarProvision(config: Config, owner: string, repo: string, key: string, tags: string[] = [], log: (m: string) => void = () => {}) {
  const { baseUrl, post } = sonarApi(config);
  const created = await post('/api/projects/create', { project: key, name: key, visibility: 'private' });
  if (!created.ok && !JSON.stringify(created.json ?? '').includes('already exists')) {
    throw new Error(`SonarQube: cannot create project ${key} (${created.status})`);
  }
  log(`SonarQube project ${key} ${created.ok ? 'created' : 'already existed'}`);
  if (tags.length) await post('/api/project_tags/set', { project: key, tags: tags.join(',') });
  // Token name must be unique per user — timestamp keeps re-runs safe.
  const tok = await post('/api/user_tokens/generate', {
    name: `ci-${key}-${Date.now()}`,
    type: 'PROJECT_ANALYSIS_TOKEN',
    projectKey: key,
    expirationDate: new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10),
  });
  if (!tok.ok) throw new Error(`SonarQube: cannot create analysis token (${tok.status})`);
  await setRepoSecret(await githubToken(config, owner), owner, repo, 'SONAR_TOKEN', tok.json.token);
  log(`Stored SONAR_TOKEN (encrypted) in ${owner}/${repo}`);
  return `${baseUrl}/dashboard?id=${encodeURIComponent(key)}`;
}

/** Delete the SonarQube project (its tokens die with it) + the repo secret SONAR_TOKEN. */
export async function sonarRemove(config: Config, owner: string, repo: string, key: string) {
  const { post } = sonarApi(config);
  const del = await post('/api/projects/delete', { project: key });
  if (!del.ok && del.status !== 404) throw new Error(`SonarQube: cannot delete project ${key} (${del.status})`);
  const sec = await gh(await githubToken(config, owner), 'DELETE', `/repos/${owner}/${repo}/actions/secrets/SONAR_TOKEN`);
  if (!sec.ok && sec.status !== 404) throw new Error(`GitHub: cannot delete secret SONAR_TOKEN (${sec.status})`);
}

function requireSpaceMember(entityOf: (space: string) => Promise<string>) {
  return createTemplateAction({
    id: 'everesto:space:require-member',
    description: 'Fail unless the user is developer/maintainer/owner of the chosen space (or platform-team)',
    schema: {
      input: {
        project: z => z.string().describe('System entity ref of the space, e.g. system:default/orchid'),
        roles: z => z.array(z.string()).default(['managers', 'maintainers', 'developers']), // CI pipeline / repository: developers and up (CD: maintainers, checked in everestoDeploy)
      },
    },
    async handler(ctx) {
      const space = ctx.input.project.replace(/^system:(default\/)?/, '');
      const groups = (ctx.user?.entity?.relations ?? []).filter(r => r.type === 'memberOf').map(r => r.targetRef);
      const entity = await entityOf(space);
      const ok = groups.includes('group:default/platform-team')
        || (entity !== '' && groups.includes(`group:default/${entity}-admins`)) // entity admin = maintainer of all its spaces
        || ctx.input.roles.some(role => groups.includes(`group:default/${space}-${role}`));
      if (!ok) {
        throw new Error(`${ctx.user?.ref ?? 'you'} is not ${ctx.input.roles.join('/')} of space ${space} — ask an owner of ${space}`);
      }
      ctx.logger.info(`${ctx.user?.ref} may create in space ${space}`);
    },
  });
}

const parseRepoUrl = (repoUrl: string) => {
  // "github.com?owner=Everesto-Inc&repo=python-backend"
  const q = new URLSearchParams(repoUrl.split('?')[1] ?? '');
  const owner = q.get('owner');
  const repo = q.get('repo');
  if (!owner || !repo) throw new Error(`Invalid repoUrl: ${repoUrl}`);
  return { owner, repo };
};

/** Register the new repo in the app registry (platform-controlled: which space owns it). Runs right after publish. */
function registerApp(config: Config, entityOf: (space: string) => Promise<string>) {
  return createTemplateAction({
    id: 'everesto:app:register',
    description: 'Record which DevOps Space owns the new repository (everesto-catalog/platform/apps.yaml)',
    schema: {
      input: {
        project: z => z.string().describe('System entity ref of the space, e.g. system:default/orchid'),
        repoUrl: z => z.string().describe('github.com?owner=Everesto-Inc&repo=<name>'),
      },
    },
    async handler(ctx) {
      const space = ctx.input.project.replace(/^system:(default\/)?/, '');
      const { repo } = parseRepoUrl(ctx.input.repoUrl);
      // same membership rule as everesto:space:require-member (checked again: this action writes platform data)
      const groups = (ctx.user?.entity?.relations ?? []).filter(r => r.type === 'memberOf').map(r => r.targetRef);
      const entity = await entityOf(space);
      const ok = groups.includes('group:default/platform-team') || (entity !== '' && groups.includes(`group:default/${entity}-admins`))
        || ['managers', 'maintainers', 'developers'].some(r => groups.includes(`group:default/${space}-${r}`));
      if (!ok) throw new Error(`${ctx.user?.ref ?? 'you'} is not a member of space ${space}`);
      const token = await githubToken(config, OWNER_ORG);
      await registerAppInRegistry(token, repo, space, (ctx.user?.ref ?? 'scaffolder').replace(/^user:default\//, ''));
      ctx.logger.info(`${repo} registered to space ${space}`);
    },
  });
}

function sonarqubeSetup(config: Config) {
  return createTemplateAction({
    id: 'everesto:sonarqube:setup',
    description: 'Create a SonarQube project + analysis token and store it as GitHub secret SONAR_TOKEN',
    schema: {
      input: {
        repoUrl: z => z.string().describe('Same repoUrl as publish:github'),
        projectKey: z => z.string().describe('SonarQube project key (= repo name)'),
        tags: z => z.array(z.string()).optional().describe('SonarQube project tags (e.g. the project name)'),
      },
      output: {
        projectUrl: z => z.string(),
      },
    },
    async handler(ctx) {
      const { owner, repo } = parseRepoUrl(ctx.input.repoUrl);
      const url = await sonarProvision(config, owner, repo, ctx.input.projectKey, ctx.input.tags, m => ctx.logger.info(m));
      ctx.output('projectUrl', url);
    },
  });
}

function githubSecureRepo(config: Config) {
  return createTemplateAction({
    id: 'everesto:github:secure-repo',
    description: 'Enable GitHub secret scanning + push protection (free for public repos)',
    schema: {
      input: {
        repoUrl: z => z.string().describe('Same repoUrl as publish:github'),
      },
    },
    async handler(ctx) {
      const { owner, repo } = parseRepoUrl(ctx.input.repoUrl);
      const token = await githubToken(config, owner);
      const res = await gh(token, 'PATCH', `/repos/${owner}/${repo}`, {
        security_and_analysis: {
          secret_scanning: { status: 'enabled' },
          secret_scanning_push_protection: { status: 'enabled' },
        },
      });
      if (!res.ok) throw new Error(`GitHub: cannot enable secret scanning on ${repo} (${res.status})`);
      ctx.logger.info(`Secret scanning + push protection enabled on ${owner}/${repo}`);
    },
  });
}

export const everestoActionsModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'everesto-actions',
  register(reg) {
    reg.registerInit({
      deps: { scaffolder: scaffolderActionsExtensionPoint, config: coreServices.rootConfig, catalog: catalogServiceRef, auth: coreServices.auth },
      async init({ scaffolder, config, catalog, auth }) {
        // entity of a space (System.spec.domain) — entity admins may create in every space of their entity
        const entityOf = async (space: string) => String((await catalog.getEntityByRef(
          `system:default/${space}`, { credentials: await auth.getOwnServiceCredentials() },
        ))?.spec?.domain ?? '');
        scaffolder.addActions(requireSpaceMember(entityOf), registerApp(config, entityOf), sonarqubeSetup(config), githubSecureRepo(config));
      },
    });
  },
});
