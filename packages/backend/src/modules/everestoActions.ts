/**
 * Custom Software Template actions for the everesto.live portal.
 *
 *   everesto:sonarqube:setup   → SonarQube project + project-only analysis token, stored
 *                                DIRECTLY as an encrypted GitHub Actions secret in the new repo
 *                                (the token never appears in task logs, outputs or the DB)
 *   everesto:github:secure-repo → secret scanning + push protection on a (public) repo
 *   everesto:gitops:add-app    → ensures repo <project>-gitops-cd exists, writes the app folder
 *                                (Deployment, Service, kustomization) and gives the app repo's CI a
 *                                deploy key that can write ONLY to that gitops repo (tag bump)
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
import sodium from 'libsodium-wrappers';
import { generateKeyPairSync } from 'node:crypto';

const GH = 'https://api.github.com';

/** Installation token of the GitHub App for an owner (e.g. Everesto-Inc). */
export async function githubToken(config: Config, owner: string): Promise<string> {
  const integrations = ScmIntegrations.fromConfig(config);
  const provider = DefaultGithubCredentialsProvider.fromIntegrations(integrations);
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
  return { baseUrl, post };
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

/** RSA keypair: OpenSSH public key (for GitHub deploy key) + PEM private key (for the CI secret). */
export function sshKeyPair(comment: string) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 4096 });
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  const mpint = (b64url: string) => {
    let b = Buffer.from(b64url, 'base64url');
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return b;
  };
  const field = (b: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(b.length); return Buffer.concat([l, b]); };
  const blob = Buffer.concat([field(Buffer.from('ssh-rsa')), field(mpint(jwk.e)), field(mpint(jwk.n))]);
  return {
    publicOpenSsh: `ssh-rsa ${blob.toString('base64')} ${comment}`,
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs1' }).toString(),
  };
}

/** First step of every space template: the user must be a member of the CHOSEN space (or platform-team). */
function requireSpaceMember() {
  return createTemplateAction({
    id: 'everesto:space:require-member',
    description: 'Fail unless the user is developer/maintainer/owner of the chosen space (or platform-team)',
    schema: {
      input: {
        project: z => z.string().describe('System entity ref of the space, e.g. system:default/orchid'),
        roles: z => z.array(z.string()).default(['owners', 'maintainers', 'developers']),
      },
    },
    async handler(ctx) {
      const space = ctx.input.project.replace(/^system:(default\/)?/, '');
      const groups = (ctx.user?.entity?.relations ?? []).filter(r => r.type === 'memberOf').map(r => r.targetRef);
      const ok = groups.includes('group:default/platform-team')
        || ctx.input.roles.some(role => groups.includes(`group:default/${space}-${role}`));
      if (!ok) {
        throw new Error(`${ctx.user?.ref ?? 'you'} is not ${ctx.input.roles.join('/')} of space ${space} — ask an owner of ${space}`);
      }
      ctx.logger.info(`${ctx.user?.ref} may create in space ${space}`);
    },
  });
}

const parseRepoUrl = (repoUrl: string) => {
  // "github.com?owner=Everesto-Inc&repo=seine-api"
  const q = new URLSearchParams(repoUrl.split('?')[1] ?? '');
  const owner = q.get('owner');
  const repo = q.get('repo');
  if (!owner || !repo) throw new Error(`Invalid repoUrl: ${repoUrl}`);
  return { owner, repo };
};

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

function gitopsAddApp(config: Config) {
  return createTemplateAction({
    id: 'everesto:gitops:add-app',
    description: 'Ensure <project>-gitops-cd exists and add the app folder (Deployment, Service, kustomization)',
    schema: {
      input: {
        owner: z => z.string(),
        project: z => z.string(),
        app: z => z.string().describe('Folder name, e.g. java-backend'),
        appRepo: z => z.string().describe('Application repo whose CI bumps the image tag'),
        image: z => z.string().describe('ghcr.io/everesto-inc/<repo>'),
        port: z => z.number().default(8080),
      },
      output: {
        repoUrl: z => z.string(),
        path: z => z.string(),
      },
    },
    async handler(ctx) {
      const { owner, project, app, appRepo, image, port } = ctx.input;
      const repo = `${project}-gitops-cd`;
      const token = await githubToken(config, owner);

      const exists = await gh(token, 'GET', `/repos/${owner}/${repo}`);
      if (exists.status === 404) {
        const created = await gh(token, 'POST', `/orgs/${owner}/repos`, {
          name: repo,
          private: true,
          auto_init: true,
          description: `CD for project ${project} — one folder per application (ArgoCD)`,
        });
        if (!created.ok) throw new Error(`GitHub: cannot create ${repo} (${created.status})`);
        ctx.logger.info(`Created ${owner}/${repo}`);
      } else if (!exists.ok) {
        throw new Error(`GitHub: cannot read ${repo} (${exists.status})`);
      }

      const name = `${project}-${app}`;
      const files: Record<string, string> = {
        'kustomization.yaml': `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: ${project}
resources: [deployment.yaml, service.yaml]
images:
  - name: ${image}
    newTag: latest   # CI of ${owner}/${name} bumps this
`,
        'deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  labels: { app: ${name}, everesto.live/project: ${project} }
spec:
  replicas: 1
  selector: { matchLabels: { app: ${name} } }
  template:
    metadata:
      labels: { app: ${name}, everesto.live/project: ${project} }
    spec:
      nodeSelector: { everesto.live/pool: tenants }
      containers:
        - name: app
          image: ${image}
          ports: [{ containerPort: ${port} }]
          resources:
            requests: { cpu: 50m, memory: 128Mi }
            limits: { memory: 256Mi }
          readinessProbe: { httpGet: { path: /health, port: ${port} } }
`,
        'service.yaml': `apiVersion: v1
kind: Service
metadata:
  name: ${name}
spec:
  selector: { app: ${name} }
  ports: [{ port: 80, targetPort: ${port} }]
`,
      };
      for (const [file, content] of Object.entries(files)) {
        const path = `${app}/${file}`;
        const cur = await gh(token, 'GET', `/repos/${owner}/${repo}/contents/${path}`);
        const put = await gh(token, 'PUT', `/repos/${owner}/${repo}/contents/${path}`, {
          message: `${app}: ${cur.ok ? 'update' : 'add'} ${file} (Backstage)`,
          content: Buffer.from(content).toString('base64'),
          ...(cur.ok ? { sha: cur.json.sha } : {}),
        });
        if (!put.ok) throw new Error(`GitHub: cannot write ${path} (${put.status})`);
      }
      ctx.logger.info(`Wrote ${app}/ in ${owner}/${repo}`);

      // Deploy key: write access to the gitops repo only; private half → app repo secret.
      const keys = sshKeyPair(`${appRepo}-ci`);
      const dk = await gh(token, 'POST', `/repos/${owner}/${repo}/keys`, {
        title: `CI of ${appRepo} (tag bump)`,
        key: keys.publicOpenSsh,
        read_only: false,
      });
      if (!dk.ok) throw new Error(`GitHub: cannot add deploy key to ${repo} (${dk.status})`);
      await setRepoSecret(token, owner, appRepo, 'GITOPS_DEPLOY_KEY', keys.privatePem);
      ctx.logger.info(`Deploy key on ${repo} + GITOPS_DEPLOY_KEY secret in ${appRepo}`);
      ctx.output('repoUrl', `https://github.com/${owner}/${repo}`);
      ctx.output('path', `${app}/`);
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
      deps: { scaffolder: scaffolderActionsExtensionPoint, config: coreServices.rootConfig },
      async init({ scaffolder, config }) {
        scaffolder.addActions(requireSpaceMember(), sonarqubeSetup(config), gitopsAddApp(config), githubSecureRepo(config));
      },
    });
  },
});
