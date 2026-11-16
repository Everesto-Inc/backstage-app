/**
 * everesto insights — real data for the DevOps Space pipeline cards.
 *
 *   GET /api/everesto/pipeline/:repo     (signed-in users only)
 *     → last CI runs (GitHub Actions), commits per day, scanner results from the latest
 *       main run (Gitleaks / Semgrep / Trivy / SonarQube steps), SonarQube measures,
 *       last deploy (latest commit in <project>-gitops-cd/<app>/).
 *
 * Read-only. GitHub via the GitHub App (integrations.github), SonarQube via sonarqube.apiKey.
 * Results are cached 2 minutes per repo to stay far below GitHub / SonarQube rate limits.
 */
import { coreServices, createBackendPlugin } from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import Router from 'express-promise-router';
import express from 'express';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { ROLE, ToolChange, allowed, appInfo, deleteApp, readFile, setTools } from './everestoManage';
import { builds, createDeployment, deleteDeployment, deploy, newEsoLogin, promote, secretDelete, secretSet, secretsList, setupCommands } from './everestoDeploy';
import { gh, githubToken } from './everestoActions';
import { argoApp, podLogs, workloads } from './everestoK8s';
import { expandEntityAdmins, readSpaces, syncGithubAccess } from './everestoAccess';
import { SPACE_ROLES, SpaceRole, addMember, canManageRole, removeMember } from './everestoMembers';

const OWNER = 'Everesto-Inc';
const TTL_MS = 120_000;
const DAYS = 14;

type Step = { name: string; conclusion: string | null };
const SCANNERS: Record<string, RegExp> = {
  gitleaks: /gitleaks/i,
  semgrep: /semgrep/i,
  trivyDeps: /vulnerable dependencies/i,
  trivyImage: /scan image/i,
  sonarqube: /quality gate/i,
  tests: /tests/i,
};

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const lastDays = () =>
  Array.from({ length: DAYS }, (_, i) => dayKey(new Date(Date.now() - (DAYS - 1 - i) * 864e5)));

async function sonarMeasures(config: Config, key: string) {
  const baseUrl = config.getOptionalString('sonarqube.baseUrl');
  const apiKey = config.getOptionalString('sonarqube.apiKey');
  if (!baseUrl || !apiKey) return undefined;
  const auth = `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
  const get = (path: string) => fetch(`${baseUrl}${path}`, { headers: { authorization: auth } });
  const metrics = 'alert_status,coverage,new_coverage,bugs,vulnerabilities,code_smells,security_hotspots,new_violations,ncloc';
  const res = await get(`/api/measures/component?component=${encodeURIComponent(key)}&metricKeys=${metrics}`);
  if (res.status === 404) return { exists: false };
  if (!res.ok) return { exists: true, error: `SonarQube HTTP ${res.status}` };
  const json: any = await res.json();
  const m: Record<string, string> = {};
  for (const x of json.component?.measures ?? []) m[x.metric] = x.value ?? x.period?.value;
  const analyses: any = await (await get(`/api/project_analyses/search?project=${encodeURIComponent(key)}&ps=1`)).json().catch(() => ({}));
  return {
    exists: true,
    analysed: Boolean(analyses.analyses?.length),
    lastAnalysis: analyses.analyses?.[0]?.date,
    gate: m.alert_status, // OK | ERROR | undefined
    coverage: m.coverage !== undefined ? Number(m.coverage) : undefined,
    newCoverage: m.new_coverage !== undefined ? Number(m.new_coverage) : undefined,
    bugs: m.bugs !== undefined ? Number(m.bugs) : undefined,
    vulnerabilities: m.vulnerabilities !== undefined ? Number(m.vulnerabilities) : undefined,
    codeSmells: m.code_smells !== undefined ? Number(m.code_smells) : undefined,
    hotspots: m.security_hotspots !== undefined ? Number(m.security_hotspots) : undefined,
    newIssues: m.new_violations !== undefined ? Number(m.new_violations) : undefined,
    url: `${baseUrl}/dashboard?id=${encodeURIComponent(key)}`,
  };
}

async function pipelineInsights(config: Config, repo: string, _project?: string, _app?: string, sonarKey?: string) {
  const token = await githubToken(config, OWNER);
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();

  const [runsRes, commitsRes, repoRes, prsRes, langRes] = await Promise.all([
    gh(token, 'GET', `/repos/${OWNER}/${repo}/actions/runs?per_page=30`),
    gh(token, 'GET', `/repos/${OWNER}/${repo}/commits?sha=main&since=${since}&per_page=100`),
    gh(token, 'GET', `/repos/${OWNER}/${repo}`),
    gh(token, 'GET', `/repos/${OWNER}/${repo}/pulls?state=open&per_page=50`),
    gh(token, 'GET', `/repos/${OWNER}/${repo}/languages`),
  ]);
  const langTotal = Object.values((langRes.json ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0) || 1;
  const code = repoRes.ok ? {
    visibility: repoRes.json.visibility as string,
    defaultBranch: repoRes.json.default_branch as string,
    pushedAt: repoRes.json.pushed_at as string,
    openPulls: ((prsRes.json ?? []) as any[]).map(p => ({ number: p.number, title: p.title, author: p.user?.login, createdAt: p.created_at, url: p.html_url, draft: p.draft })),
    languages: Object.entries((langRes.json ?? {}) as Record<string, number>).map(([name, bytes]) => ({ name, pct: Math.round((bytes / langTotal) * 100) })),
    lastCommits: ((commitsRes.json ?? []) as any[]).slice(0, 8).map(c => ({
      sha: String(c.sha).slice(0, 7), message: String(c.commit?.message ?? '').split('\n')[0], author: c.author?.login ?? c.commit?.author?.name, at: c.commit?.committer?.date, url: c.html_url,
    })),
  } : undefined;
  if (runsRes.status === 404) return { exists: false };

  const runs = ((runsRes.json?.workflow_runs ?? []) as any[])
    .filter(r => r.name === 'CI')
    .map(r => ({
      id: r.id,
      number: r.run_number,
      sha: String(r.head_sha).slice(0, 7),
      branch: r.head_branch,
      event: r.event,
      actor: r.actor?.login,
      title: r.display_title,
      status: r.status,
      conclusion: r.conclusion,
      createdAt: r.created_at,
      durationSec: r.updated_at ? Math.max(0, (Date.parse(r.updated_at) - Date.parse(r.run_started_at ?? r.created_at)) / 1000) : undefined,
      url: r.html_url,
    }));

  // scanner results = step conclusions of the latest completed run on main
  const lastMain = ((runsRes.json?.workflow_runs ?? []) as any[]).find(
    r => r.name === 'CI' && r.head_branch === 'main' && r.status === 'completed',
  );
  const scanners: Record<string, string | null> = {};
  let failedStep: string | undefined;
  if (lastMain) {
    const jobs = await gh(token, 'GET', `/repos/${OWNER}/${repo}/actions/runs/${lastMain.id}/jobs`);
    // all jobs: Loop guard job (Gitleaks, Trivy deps) + ci job (tests, Semgrep, Sonar, image)
    const steps: Step[] = ((jobs.json?.jobs ?? []) as any[]).flatMap(j => j.steps ?? []);
    for (const [k, re] of Object.entries(SCANNERS)) {
      const st = steps.find(s => re.test(s.name));
      if (st) scanners[k] = st.conclusion; // success | failure | skipped | null(not reached)
    }
    failedStep = steps.find(s => s.conclusion === 'failure')?.name;
  }

  const perDay: Record<string, number> = Object.fromEntries(lastDays().map(d => [d, 0]));
  for (const c of (commitsRes.json ?? []) as any[]) {
    const d = dayKey(new Date(c.commit?.committer?.date ?? c.commit?.author?.date));
    if (d in perDay) perDay[d] += 1;
  }

  // CD: <repo>-gitops — tag + last change per environment
  const envs: Record<string, { tag?: string; at?: string; message?: string; url?: string }> = {};
  const gitops = `${repo}-gitops`;
  for (const env of ['dev', 'prod']) {
    const k = await readFile(token, gitops, `apps/${env}/kustomization.yaml`);
    if (!k) continue;
    const dep = await gh(token, 'GET', `/repos/${OWNER}/${gitops}/commits?path=apps/${env}&per_page=1`);
    const c = dep.json?.[0];
    envs[env] = { tag: k.match(/newTag:\s*(\S+)/)?.[1], at: c?.commit?.committer?.date, message: c?.commit?.message?.split('\n')[0], url: c?.html_url };
  }
  // live ArgoCD status (read-only cluster access) — undefined outside the cluster or without RBAC
  const argo: Record<string, unknown> = {};
  for (const env of Object.keys(envs)) argo[env] = await argoApp(`${repo}-${env}`);
  const lastDeploy = envs.dev?.at ? { at: envs.dev.at, message: envs.dev.message ?? '', url: envs.dev.url ?? '' } : undefined;

  return {
    exists: true,
    repoUrl: `https://github.com/${OWNER}/${repo}`,
    runs,
    lastMainRun: runs.find(r => r.id === lastMain?.id),
    failedStep,
    scanners,
    commitsPerDay: lastDays().map(d => ({ day: d, count: perDay[d] })),
    // no sonar key: SonarQube switched off for this app → never show (old) measures
    sonar: sonarKey ? await sonarMeasures(config, sonarKey).catch(e => ({ exists: true, error: String(e) })) : { exists: false },
    lastDeploy,
    envs: Object.keys(envs).length ? envs : undefined,
    argo: Object.keys(argo).length ? argo : undefined,
    code,
    images: runs.filter(r => r.branch === 'main' && r.conclusion === 'success' && r.event !== 'pull_request').slice(0, 5)
      .map(r => ({ tag: `sha-${r.sha}`, at: r.createdAt, title: r.title, url: r.url })),
    gitopsRepo: Object.keys(envs).length ? `https://github.com/${OWNER}/${gitops}` : undefined,
  };
}

export const everestoInsightsPlugin = createBackendPlugin({
  pluginId: 'everesto',
  register(env) {
    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        httpAuth: coreServices.httpAuth,
        userInfo: coreServices.userInfo,
        auth: coreServices.auth,
        catalog: catalogServiceRef,
        scheduler: coreServices.scheduler,
      },
      async init({ httpRouter, config, logger, httpAuth, userInfo, auth, catalog, scheduler }) {
        const cache = new Map<string, { at: number; data: unknown }>();
        const router = Router();
        router.get('/pipeline/:repo', async (req, res) => {
          const repo = req.params.repo;
          if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(repo)) {
            res.status(400).json({ error: 'invalid repo name' });
            return;
          }
          const project = typeof req.query.project === 'string' && /^[a-z0-9-]{1,63}$/.test(req.query.project) ? req.query.project : undefined;
          const app = typeof req.query.app === 'string' && /^[a-z0-9-]{1,63}$/.test(req.query.app) ? req.query.app : undefined;
          // sonar = SonarQube project key from the app's annotation ('0' = switched off)
          const q = typeof req.query.sonar === 'string' ? req.query.sonar : '';
          let sonar: string | undefined;
          if (q === '1') sonar = repo;
          else if (q !== '0' && /^[A-Za-z0-9_.:-]{1,200}$/.test(q)) sonar = q;
          const key = `${repo}|${project}|${app}|${sonar}`;
          const hit = cache.get(key);
          if (hit && Date.now() - hit.at < TTL_MS) {
            res.json(hit.data);
            return;
          }
          try {
            const data = await pipelineInsights(config, repo, project, app, sonar);
            cache.set(key, { at: Date.now(), data });
            res.json(data);
          } catch (e) {
            logger.warn(`insights for ${repo} failed: ${e}`);
            res.status(502).json({ error: 'could not read pipeline data' });
          }
        });

        // ---- change tools / delete an application (see everestoManage.ts) ----
        router.use(express.json());
        const caller = async (req: express.Request) => {
          const credentials = await httpAuth.credentials(req, { allow: ['user'] });
          const u = await userInfo.getUserInfo(credentials);
          // Entity admin (<entity>-admins) = maintainer of EVERY space of that entity → expand once, here,
          // so every permission check (deploy, promote, prod secrets, members, tools) applies it.
          const refs = await expandEntityAdmins(u.ownershipEntityRefs, async entity => (await catalog.getEntities(
            { filter: { kind: 'System', 'spec.domain': entity, 'metadata.labels.everesto.live/level': 'space' }, fields: ['metadata.name'] },
            { credentials: await auth.getOwnServiceCredentials() },
          )).items.map(e => e.metadata.name));
          return { refs, who: u.userEntityRef.replace(/^user:default\//, '') };
        };
        const fail = (res: express.Response, e: any) => {
          const status = e?.status ?? 500;
          if (status === 500) logger.warn(`manage failed: ${e}`);
          res.status(status).json({ error: e?.message ?? String(e) });
        };
        const validRepo = (r: string) => /^[a-z0-9][a-z0-9-]{0,99}$/.test(r);

        router.post('/apps/:repo/tools', async (req, res) => {
          const { repo } = req.params;
          if (!validRepo(repo)) { res.status(400).json({ error: 'invalid repo name' }); return; }
          const change: ToolChange = {};
          for (const k of ['sonarqube', 'semgrep', 'dependabot'] as const) {
            if (typeof req.body?.[k] === 'boolean') change[k] = req.body[k];
          }
          try {
            const { refs, who } = await caller(req);
            const out = await setTools(config, repo, change, refs, who);
            for (const k of cache.keys()) if (k.startsWith(`${repo}|`)) cache.delete(k);
            logger.info(`tools of ${repo} changed by ${who}: ${out.done.join(', ')}`);
            res.json(out);
          } catch (e) { fail(res, e); }
        });

        router.post('/apps/:repo/delete', async (req, res) => {
          const { repo } = req.params;
          if (!validRepo(repo)) { res.status(400).json({ error: 'invalid repo name' }); return; }
          if (req.body?.confirm !== repo) { res.status(400).json({ error: 'type the application name to confirm' }); return; }
          try {
            const { refs, who } = await caller(req);
            const credentials = await auth.getOwnServiceCredentials();
            const unregister = async (r: string) => {
              const loc = await catalog.getLocationByEntity(`component:default/${r}`, { credentials });
              if (loc) await catalog.removeLocationById(loc.id, { credentials });
              const e = await catalog.getEntityByRef(`component:default/${r}`, { credentials });
              if (e?.metadata.uid) await catalog.removeEntityByUid(e.metadata.uid, { credentials });
              const g = await catalog.getEntityByRef(`resource:default/${r}-gitops`, { credentials });
              if (g?.metadata.uid) await catalog.removeEntityByUid(g.metadata.uid, { credentials });
            };
            const out = await deleteApp(config, repo, refs, unregister);
            for (const k of cache.keys()) if (k.startsWith(`${repo}|`)) cache.delete(k);
            logger.info(`application ${repo} DELETED by ${who}: ${out.done.join(', ')}`);
            res.json(out);
          } catch (e) { fail(res, e); }
        });

        const resourceUnregister = (credentials: any) => async (name: string) => {
          const r = await catalog.getEntityByRef(`resource:default/${name}`, { credentials });
          if (r?.metadata.uid) await catalog.removeEntityByUid(r.metadata.uid, { credentials });
        };
        const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

        router.post('/apps/:repo/deployment', async (req, res) => {
          const { repo } = req.params;
          if (!validRepo(repo)) { res.status(400).json({ error: 'invalid repo name' }); return; }
          const b = req.body ?? {};
          const input = {
            secrets: (Array.isArray(b.secrets) ? b.secrets : []).map((x: any) => ({ name: str(x?.name), value: str(x?.value) || undefined })).filter((x: any) => x.name),
            config: (Array.isArray(b.config) ? b.config : []).map((x: any) => ({ name: str(x?.name), value: str(x?.value) })).filter((x: any) => x.name),
            port: Number(b.port ?? 8080),
            memoryMi: Number(b.memoryMi ?? 192),
            replicas: Number(b.replicas ?? 1),
            healthPath: str(b.healthPath) || undefined,
            publicUrl: b.publicUrl !== false,
          };
          try {
            const { refs, who } = await caller(req);
            const out = await createDeployment(config, repo, input, refs, who);
            for (const k of cache.keys()) if (k.startsWith(`${repo}|`)) cache.delete(k);
            logger.info(`deployment for ${repo} created by ${who}: ${out.done.join(', ')}`); // never log out.commands (secret)
            res.json(out);
          } catch (e) { fail(res, e); }
        });

        router.post('/apps/:repo/deployment/delete', async (req, res) => {
          const { repo } = req.params;
          if (!validRepo(repo)) { res.status(400).json({ error: 'invalid repo name' }); return; }
          if (req.body?.confirm !== `${repo}-gitops`) { res.status(400).json({ error: `type ${repo}-gitops to confirm` }); return; }
          try {
            const { refs, who } = await caller(req);
            const out = await deleteDeployment(config, repo, refs, who, resourceUnregister(await auth.getOwnServiceCredentials()));
            for (const k of cache.keys()) if (k.startsWith(`${repo}|`)) cache.delete(k);
            logger.info(`deployment of ${repo} DELETED by ${who}: ${out.done.join(', ')}`);
            res.json(out);
          } catch (e) { fail(res, e); }
        });

        router.get('/apps/:repo/deployment/setup', async (req, res) => {
          const { repo } = req.params;
          if (!validRepo(repo)) { res.status(400).json({ error: 'invalid repo name' }); return; }
          try {
            const token = await githubToken(config, OWNER);
            const { project } = await appInfo(token, repo);
            const hasProd = (await readFile(token, `${repo}-gitops`, 'apps/prod/kustomization.yaml')) !== undefined;
            res.json({ commands: setupCommands(repo, project, hasProd) });
          } catch (e) { fail(res, e); }
        });

        router.post('/apps/:repo/deployment/eso-login', async (req, res) => {
          const { repo } = req.params;
          if (!validRepo(repo)) { res.status(400).json({ error: 'invalid repo name' }); return; }
          try {
            const { refs, who } = await caller(req);
            const out = await newEsoLogin(config, repo, refs, who);
            logger.info(`new ESO login for ${repo} by ${who}`); // never log out.cmd (secret)
            res.json(out);
          } catch (e) { fail(res, e); }
        });

        const envOf = (v: unknown): 'dev' | 'prod' | undefined => (['dev', 'prod'].includes(String(v)) ? (v as 'dev' | 'prod') : undefined);

        router.get('/apps/:repo/secrets', async (req, res) => {
          const { repo } = req.params;
          const secEnv = envOf(req.query.env);
          if (!validRepo(repo) || !secEnv) { res.status(400).json({ error: 'invalid repo or env' }); return; }
          try { const { refs } = await caller(req); res.json(await secretsList(config, repo, secEnv, refs)); } catch (e) { fail(res, e); }
        });

        router.post('/apps/:repo/secrets', async (req, res) => {
          const { repo } = req.params;
          const secEnv = envOf(req.body?.env);
          if (!validRepo(repo) || !secEnv) { res.status(400).json({ error: 'invalid repo or env' }); return; }
          try {
            const { refs, who } = await caller(req);
            const out = await secretSet(config, repo, secEnv, str(req.body?.name), typeof req.body?.value === 'string' ? req.body.value : '', refs);
            logger.info(`secret ${out.saved} (${secEnv}) of ${repo} set by ${who}`); // never log the value
            res.json(out);
          } catch (e) { fail(res, e); }
        });

        router.post('/apps/:repo/secrets/delete', async (req, res) => {
          const { repo } = req.params;
          const secEnv = envOf(req.body?.env);
          if (!validRepo(repo) || !secEnv) { res.status(400).json({ error: 'invalid repo or env' }); return; }
          try {
            const { refs, who } = await caller(req);
            const out = await secretDelete(config, repo, secEnv, str(req.body?.name), refs);
            logger.info(`secret ${out.deleted} (${secEnv}) of ${repo} DELETED by ${who}`);
            res.json(out);
          } catch (e) { fail(res, e); }
        });

        // ---- cluster view of a deployment: only the app's namespaces, only for project members ----
        const member = async (req: express.Request, repo: string) => {
          const { refs } = await caller(req);
          const { project } = await appInfo(await githubToken(config, OWNER), repo);
          if (!allowed(refs, project, [...ROLE.MEMBER])) {
            throw Object.assign(new Error(`only members of ${project} can see its cluster resources`), { status: 403 });
          }
          return project;
        };

        router.get('/apps/:repo/k8s', async (req, res) => {
          const { repo } = req.params;
          if (!validRepo(repo)) { res.status(400).json({ error: 'invalid repo name' }); return; }
          try {
            const project = await member(req, repo);
            const envs = await Promise.all((['dev', 'prod'] as const).map(async e => ({
              env: e,
              argo: await argoApp(`${repo}-${e}`),
              k8s: await workloads(`${project}-${e}`, repo),
            })));
            res.json({ clusterAccess: envs.some(e => e.k8s !== undefined), envs });
          } catch (e) { fail(res, e); }
        });

        router.get('/apps/:repo/k8s/logs', async (req, res) => {
          const { repo } = req.params;
          const logEnv = envOf(req.query.env);
          const pod = typeof req.query.pod === 'string' && /^[a-z0-9.-]{1,253}$/.test(req.query.pod) ? req.query.pod : undefined;
          if (!validRepo(repo) || !logEnv || !pod) { res.status(400).json({ error: 'invalid repo, env or pod' }); return; }
          try {
            const project = await member(req, repo);
            const text = await podLogs(`${project}-${logEnv}`, repo, pod, Number(req.query.tail ?? 200), req.query.previous === '1');
            if (text === undefined) { res.status(404).json({ error: 'pod not found or not readable' }); return; }
            res.json({ pod, env: logEnv, log: text });
          } catch (e) { fail(res, e); }
        });

        // ---- access sync: Backstage groups → GitHub teams, invitations, branch protection ----
        const runAccessSync = async (dryRun: boolean) => {
          const credentials = await auth.getOwnServiceCredentials();
          const getEntities = async (filter: Record<string, string>) => (await catalog.getEntities({ filter }, { credentials })).items;
          const platform = (await getEntities({ kind: 'Group', 'metadata.name': 'platform-team' }))[0];
          const owners = ((platform?.spec?.members ?? []) as string[]).map(m => m.replace(/^user:(default\/)?/, '').toLowerCase());
          return syncGithubAccess(config, await readSpaces(getEntities), dryRun, owners);
        };
        router.post('/access/sync', async (req, res) => {
          try {
            const { refs, who } = await caller(req);
            if (!refs.includes('group:default/platform-team')) { res.status(403).json({ error: 'platform-team only' }); return; }
            const dryRun = req.query.dryRun !== '0';
            const out = await runAccessSync(dryRun);
            logger.info(`access sync (${dryRun ? 'dry run' : 'APPLIED'}) by ${who}: ${out.actions.length} actions, ${out.warnings.length} warnings`);
            res.json(out);
          } catch (e) { fail(res, e); }
        });
        if (config.getOptionalBoolean('everesto.accessSync.enabled')) {
          await scheduler.scheduleTask({
            id: 'everesto-access-sync',
            frequency: { minutes: 30 },
            timeout: { minutes: 10 },
            initialDelay: { minutes: 3 },
            fn: async () => {
              const out = await runAccessSync(false);
              if (out.actions.length || out.warnings.length) logger.info(`access sync: ${[...out.actions, ...out.warnings.map(w => `WARN ${w}`)].join(' | ')}`);
            },
          });
        }

        // ---- members of a DevOps Space (real Invite / Remove) ----
        const memberChange = async (req: express.Request, res: express.Response, remove: boolean) => {
          const { space } = req.params;
          const role = req.body?.role as SpaceRole;
          const login = str(req.body?.username).replace(/^@/, '');
          if (!/^[a-z0-9-]{1,63}$/.test(space) || !SPACE_ROLES.includes(role) || !/^[A-Za-z0-9-]{1,39}$/.test(login)) {
            res.status(400).json({ error: 'invalid space, role or GitHub username' });
            return;
          }
          try {
            const { refs, who } = await caller(req);
            const credentials = await auth.getOwnServiceCredentials();
            const sys = await catalog.getEntityByRef(`system:default/${space}`, { credentials });
            if (!sys) { res.status(404).json({ error: `space ${space} not found` }); return; }
            if (!canManageRole(refs, space, role, String(sys.spec?.domain ?? ''))) {
              res.status(403).json({ error: role === 'developers' || role === 'viewers' ? `only managers of ${space} (or the owner) can change members` : 'only the owner can give or take the Manager / Maintainer role' });
              return;
            }
            const email = str(req.body?.email) || undefined;
            if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { res.status(400).json({ error: 'invalid email' }); return; }
            const out = remove
              ? await removeMember(config, space, role, login, who)
              : await addMember(config, space, role, login, email, str(req.body?.displayName) || undefined, who);
            // re-read the catalog files now instead of waiting for the next processing loop
            for (const ref of [`group:default/${space}-${role}`, 'group:default/platform-team']) {
              await catalog.refreshEntity(ref, { credentials }).catch(() => undefined);
            }
            logger.info(`members of ${space} (${role}) ${remove ? '-' : '+'} ${login} by ${who}: ${out.done.join(', ')}`);
            res.json(out);
          } catch (e) { fail(res, e); }
        };
        router.post('/spaces/:space/members', (req, res) => memberChange(req, res, false));
        router.post('/spaces/:space/members/remove', (req, res) => memberChange(req, res, true));

        router.get('/apps/:repo/builds', async (req, res) => {
          const { repo } = req.params;
          if (!validRepo(repo)) { res.status(400).json({ error: 'invalid repo name' }); return; }
          try { res.json({ builds: await builds(config, repo) }); } catch (e) { fail(res, e); }
        });

        router.post('/apps/:repo/deploy', async (req, res) => {
          const { repo } = req.params;
          const tag = str(req.body?.tag);
          if (!validRepo(repo) || !/^sha-[0-9a-f]{7}$/.test(tag)) { res.status(400).json({ error: 'invalid repo or tag' }); return; }
          try {
            const { refs, who } = await caller(req);
            const out = await deploy(config, repo, tag, refs, who);
            for (const k of cache.keys()) if (k.startsWith(`${repo}|`)) cache.delete(k);
            logger.info(`deploy ${repo} dev ${out.from} → ${out.to} by ${who}`);
            res.json(out);
          } catch (e) { fail(res, e); }
        });

        // "Run build": workflow_dispatch of ci.yml on main (GitHub App needs Actions: write)
        router.post('/apps/:repo/build', async (req, res) => {
          const { repo } = req.params;
          if (!validRepo(repo)) { res.status(400).json({ error: 'invalid repo name' }); return; }
          try {
            const { refs, who } = await caller(req);
            const token = await githubToken(config, OWNER);
            const { project } = await appInfo(token, repo);
            if (!allowed(refs, project, [...ROLE.DEV])) { res.status(403).json({ error: `only members of ${project} can run builds` }); return; }
            const r = await gh(token, 'POST', `/repos/${OWNER}/${repo}/actions/workflows/ci.yml/dispatches`, { ref: 'main' });
            if (r.status === 403) { res.status(403).json({ error: 'the GitHub App needs the permission "Actions: Read and write" to start builds' }); return; }
            if (!r.ok) { res.status(502).json({ error: `GitHub: cannot start build (${r.status})` }); return; }
            logger.info(`build of ${repo} started by ${who}`);
            res.json({ started: true, url: `https://github.com/${OWNER}/${repo}/actions` });
          } catch (e) { fail(res, e); }
        });

        router.post('/apps/:repo/promote', async (req, res) => {
          const { repo } = req.params;
          if (!validRepo(repo)) { res.status(400).json({ error: 'invalid repo name' }); return; }
          try {
            const { refs, who } = await caller(req);
            const out = await promote(config, repo, refs, who);
            for (const k of cache.keys()) if (k.startsWith(`${repo}|`)) cache.delete(k);
            logger.info(`promote ${repo} ${out.from} → ${out.to} by ${who}: ${out.url}`);
            res.json(out);
          } catch (e) { fail(res, e); }
        });

        httpRouter.use(router);
        // default auth policy: only signed-in users (no unauthenticated access)
      },
    });
  },
});
