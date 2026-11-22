/**
 * everesto backend plugin — the HTTP API behind the DevOps Space pages (/api/everesto).
 *
 *   pipeline cards   GET  /pipeline/:repo               (everestoPipeline; cached 2 min per repo)
 *   CI app           POST /apps/:repo/tools | delete | build
 *   CD               POST /apps/:repo/deployment[/delete|/eso-login] · deploy · promote · GET builds | status | k8s[/logs]
 *   secrets          GET/POST /apps/:repo/secrets[/delete]  (values write-only)
 *   spaces, members  /entities/:entity/spaces · /spaces/:space/members[/remove]
 *   access sync      POST /access/sync (+ every 30 min): GitHub, ArgoCD, SonarQube follow the space roles
 *
 * Every route checks the caller's role itself (the UI only hides buttons). The app → space mapping comes from
 * the app registry (everestoRegistry), never from the repo.
 */
import { err, membersOf } from './everestoCommon';
import { coreServices, createBackendPlugin } from '@backstage/backend-plugin-api';
import Router from 'express-promise-router';
import express from 'express';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { notificationService } from '@backstage/plugin-notifications-node';
import { ROLE, ToolChange, allowed, appInfo, deleteApp, readFile, setTools } from './everestoManage';
import { builds, createDeployment, deleteDeployment, deploy, devHost, newEsoLogin, nsKeyOf, promote, secretDelete, secretSet, secretsList, setupCommands } from './everestoDeploy';
import { gh, githubToken } from './everestoActions';
import { syncSonarAccess } from './everestoSonarAccess';
import { readRegistry } from './everestoRegistry';
import { collectFacts, levelOf, scoreChecks } from './everestoScorecard';
import { pipelineInsights } from './everestoPipeline';
import { collectEsoState, explainStatus, probeUrl } from './everestoStatus';
import { argoApp, podLogs, workloads } from './everestoK8s';
import { expandEntityAdmins, readSpaces, syncGithubAccess } from './everestoAccess';
import { FLOWERS, createSpace } from './everestoSpaces';
import { SPACE_ROLES, SpaceRole, addMember, givableRoles, removeMember } from './everestoMembers';
import { ImportInput, importRepo, importableRepos } from './everestoImport';
import { STACKS, Stack } from './everestoLoop';

const OWNER = 'Everesto-Inc';
const TTL_MS = 120_000;
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
        notifications: notificationService,
      },
      async init({ httpRouter, config, logger, httpAuth, userInfo, auth, catalog, scheduler, notifications }) {
        const cache = new Map<string, { at: number; data: unknown }>();
        // ---- notifications (bell in the sidebar): fire-and-forget, never fail the action; the actor is not notified ----
        const notify = (to: string[], payload: { title: string; description?: string; link?: string; severity?: 'low' | 'normal' | 'high' }, actor?: string) => {
          if (!to.length) return;
          notifications.send({
            recipients: { type: 'entity', entityRef: to, ...(actor ? { excludeEntityRef: `user:default/${actor}` } : {}) },
            payload: { topic: 'everesto', ...payload },
          }).catch(e => logger.warn(`notification "${payload.title}" not sent: ${e}`));
        };
        const groupsOf = (space: string, roles: string[]) => roles.map(r => `group:default/${space}-${r}`);
        const spaceOfRepo = async (repo: string) => (await readRegistry(await githubToken(config, OWNER)))[repo.replace(/-gitops$/, '')];
        const appLink = (repo: string) => `/catalog/default/component/${repo}`;
        const router = Router();
        // observability: every action + every slow read, with its duration (no bodies, no secrets)
        router.use((req, res, next) => {
          const t0 = Date.now();
          res.on('finish', () => {
            const ms = Date.now() - t0;
            const line = `${req.method} ${req.path} → ${res.statusCode} in ${ms} ms`;
            if (req.method !== 'GET') logger.info(`action ${line}`);
            else if (ms > 1500) logger.warn(`slow ${line}`);
          });
          next();
        });
        router.get('/pipeline/:repo', async (req, res) => {
          const repo = req.params.repo;
          if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(repo)) {
            res.status(400).json({ error: 'invalid repo name' });
            return;
          }
          // sonar = SonarQube project key from the app's annotation ('0' = switched off)
          const q = typeof req.query.sonar === 'string' ? req.query.sonar : '';
          let sonar: string | undefined;
          if (q === '1') sonar = repo;
          else if (q !== '0' && /^[A-Za-z0-9_.:-]{1,200}$/.test(q)) sonar = q;
          const key = `${repo}|${sonar}`;
          const hit = cache.get(key);
          if (hit && Date.now() - hit.at < TTL_MS) {
            res.json(hit.data);
            return;
          }
          try {
            const data = await pipelineInsights(config, repo, sonar);
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
          for (const k of ['sonarqube', 'semgrep', 'dependabot', 'tests'] as const) {
            if (typeof req.body?.[k] === 'boolean') change[k] = req.body[k];
          }
          if (req.body?.trivy === 'enforce' || req.body?.trivy === 'report') change.trivy = req.body.trivy;
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
            const space = await spaceOfRepo(repo).catch(() => undefined);
            const out = await deleteApp(config, repo, refs, unregister);
            for (const k of cache.keys()) if (k.startsWith(`${repo}|`)) cache.delete(k);
            logger.info(`application ${repo} DELETED by ${who}: ${out.done.join(', ')}`);
            if (space) notify(groupsOf(space, ['managers']), { title: `${repo} was deleted`, description: `Application ${repo} (repo, deployment, secrets) was deleted by ${who}.`, link: `/catalog/default/system/${space}` }, who);
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
            nsKey: str(b.nsKey).toLowerCase() || undefined,
            publicUrl: b.publicUrl !== false,
            redis: b.redis === true,
          };
          try {
            const { refs, who } = await caller(req);
            const out = await createDeployment(config, repo, input, refs, who);
            for (const k of cache.keys()) if (k.startsWith(`${repo}|`)) cache.delete(k);
            logger.info(`deployment for ${repo} created by ${who}: ${out.done.join(', ')}`); // never log out.commands (secret)
            spaceOfRepo(repo).then(space => space && notify(groupsOf(space, ['maintainers', 'managers']), {
              title: `${repo}: deployment created`, description: `By ${who}. ArgoCD app dev-${repo} appears within ~3 min — then Sync. Status: CD tab.`, link: `/catalog/default/resource/${repo}-gitops/cd`,
            }, who), () => undefined);
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
            spaceOfRepo(repo).then(space => space && notify(groupsOf(space, ['managers']), {
              title: `${repo}: deployment deleted`, description: `By ${who} — gitops repo, ArgoCD apps and Infisical project removed.`, link: appLink(repo),
            }, who), () => undefined);
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
            res.json({ commands: setupCommands(repo, project, hasProd, await nsKeyOf(token, repo, project)) });
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
            throw err(403, `only members of ${project} can see its cluster resources`);
          }
          return project;
        };

        router.get('/apps/:repo/k8s', async (req, res) => {
          const { repo } = req.params;
          if (!validRepo(repo)) { res.status(400).json({ error: 'invalid repo name' }); return; }
          try {
            const project = await member(req, repo);
            const nsKey = await nsKeyOf(await githubToken(config, OWNER), repo, project);
            const envs = await Promise.all((['dev', 'prod'] as const).map(async e => ({
              env: e,
              argo: await argoApp(`${e}-${repo}`),
              k8s: await workloads(`${e}-${nsKey}`, repo), // the app's own namespace (dev-<key> / prod-<key>)
            })));
            res.json({ clusterAccess: envs.some(e => e.k8s !== undefined), envs });
          } catch (e) { fail(res, e); }
        });

        // status chain per environment: what is done, what is next, how long to wait, what to click
        // ---- scorecards (members of the space; cached 10 min — standards, not live status) ----
        const scoreCache = new Map<string, { at: number; data: unknown }>();
        const reviewersOf = async (space: string) => {
          const credentials = await auth.getOwnServiceCredentials();
          const groups = (await catalog.getEntities({ filter: { kind: 'Group', 'metadata.name': ['developers', 'maintainers', 'managers'].map(r => `${space}-${r}`) } }, { credentials })).items;
          return new Set(groups.flatMap(g => membersOf(g))).size;
        };
        const scoreOf = async (repo: string, space: string, fresh = false) => {
          const hit = scoreCache.get(repo);
          if (!fresh && hit && Date.now() - hit.at < 10 * 60_000) return hit.data;
          const credentials = await auth.getOwnServiceCredentials();
          const e = await catalog.getEntityByRef(`component:default/${repo}`, { credentials });
          const kind = e?.spec?.type === 'repository' ? 'repo' : 'ci';
          const facts = await collectFacts(config, repo, e?.metadata.annotations?.['sonarqube.org/project-key'], kind, await reviewersOf(space));
          const checks = scoreChecks(facts);
          const data = { repo, space, kind, level: levelOf(checks) ?? null, checks, at: new Date().toISOString() };
          scoreCache.set(repo, { at: Date.now(), data });
          return data;
        };
        router.get('/apps/:repo/scorecard', async (req, res) => {
          const { repo } = req.params;
          if (!validRepo(repo)) { res.status(400).json({ error: 'invalid repo name' }); return; }
          try {
            const space = await member(req, repo);
            res.json(await scoreOf(repo, space, req.query.fresh === '1'));
          } catch (e) { fail(res, e); }
        });
        router.get('/spaces/:space/scorecard', async (req, res) => {
          const { space } = req.params;
          if (!/^[a-z0-9-]{1,63}$/.test(space)) { res.status(400).json({ error: 'invalid space' }); return; }
          try {
            const { refs } = await caller(req);
            if (!allowed(refs, space, [...ROLE.MEMBER])) { res.status(403).json({ error: `only members of ${space} can see its scorecards` }); return; }
            const registry = await readRegistry(await githubToken(config, OWNER));
            const repos = Object.entries(registry).filter(([, s]) => s === space).map(([r]) => r).sort();
            const apps = await Promise.all(repos.map(r => scoreOf(r, space).catch(e => ({ repo: r, space, error: String(e?.message ?? e) }))));
            res.json({ space, apps });
          } catch (e) { fail(res, e); }
        });

        // ---- home page: my spaces (roles + scorecard summary) and my pull requests ----
        router.get('/me/spaces', async (req, res) => {
          try {
            const { refs } = await caller(req);
            const owner = refs.includes('group:default/platform-team');
            const credentials = await auth.getOwnServiceCredentials();
            const systems = (await catalog.getEntities({ filter: { kind: 'System', 'metadata.labels.everesto.live/level': 'space' } }, { credentials })).items;
            const registry = await readRegistry(await githubToken(config, OWNER));
            const mine = systems.map(sys => {
              const space = sys.metadata.name;
              const roles = ['managers', 'maintainers', 'developers', 'viewers'].filter(r => refs.includes(`group:default/${space}-${r}`));
              return { space, title: sys.metadata.title ?? space, entity: String(sys.spec?.domain ?? ''), roles: owner ? ['owner', ...roles] : roles };
            }).filter(x => x.roles.length);
            const out = await Promise.all(mine.map(async x => {
              const repos = Object.entries(registry).filter(([, sp]) => sp === x.space).map(([r]) => r);
              const cards = await Promise.all(repos.map(r => scoreOf(r, x.space).catch(() => undefined))) as any[];
              const ok = cards.filter(Boolean);
              return {
                ...x,
                apps: repos.length,
                silverPlus: ok.filter(c => c.level === 'silver' || c.level === 'gold').length,
                failingCi: ok.filter(c => c.checks?.some((k: any) => k.id === 'ci' && k.state === 'fail')).length,
                toFix: ok.reduce((n, c) => n + (c.checks ?? []).filter((k: any) => k.state === 'fail').length, 0),
              };
            }));
            res.json({ owner, spaces: out });
          } catch (e) { fail(res, e); }
        });
        const prCache = new Map<string, { at: number; data: unknown }>();
        router.get('/me/pull-requests', async (req, res) => {
          try {
            const { who } = await caller(req);
            const hit = prCache.get(who);
            if (hit && Date.now() - hit.at < 2 * 60_000) { res.json(hit.data); return; }
            const token = await githubToken(config, OWNER);
            const search = async (q: string) => {
              const r = await gh(token, 'GET', `/search/issues?q=${encodeURIComponent(`is:pr is:open org:${OWNER} ${q}`)}&sort=updated&per_page=20`);
              if (!r.ok) throw err(r.status === 403 || r.status === 429 ? 429 : 502, 'GitHub search is busy — try again in a minute');
              return ((r.json?.items ?? []) as any[]).map(i => ({
                repo: String(i.repository_url ?? '').split('/').pop(), number: i.number, title: i.title, url: i.html_url,
                author: i.user?.login, updatedAt: i.updated_at, draft: !!i.draft,
              }));
            };
            const [toReview, mine] = await Promise.all([search(`review-requested:${who}`), search(`author:${who}`)]);
            const data = { toReview, mine };
            prCache.set(who, { at: Date.now(), data });
            res.json(data);
          } catch (e) { fail(res, e); }
        });

        router.get('/apps/:repo/status', async (req, res) => {
          const { repo } = req.params;
          if (!validRepo(repo)) { res.status(400).json({ error: 'invalid repo name' }); return; }
          try {
            const project = await member(req, repo);
            const token = await githubToken(config, OWNER);
            const meta = JSON.parse((await readFile(token, `${repo}-gitops`, 'deployment.json')) ?? '{}');
            const nsKey = String(meta.nsKey ?? project);
            const envs = await Promise.all((['dev', 'prod'] as const).map(async envName => {
              const namespace = `${envName}-${nsKey}`;
              const [git, argo, wl, eso, url] = await Promise.all([
                readFile(token, `${repo}-gitops`, `apps/${envName}/kustomization.yaml`),
                argoApp(`${envName}-${repo}`),
                workloads(namespace, repo),
                collectEsoState(repo, envName, namespace),
                envName === 'dev' && meta.publicUrl ? probeUrl(devHost(repo)) : Promise.resolve(undefined),
              ]);
              const steps = explainStatus({
                env: envName, repo, namespace, clusterReadable: argo !== undefined, gitConfigured: !!git, argo, ...eso,
                pods: wl?.pods, replicas: wl?.deployments?.[0]?.replicas, events: wl?.events?.map(e => `${e.reason}: ${e.message}`), url,
              });
              return { env: envName, namespace, steps };
            }));
            res.json({ envs });
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
        // only = one space (after a member change); otherwise all spaces
        type SyncRun = { at: string; trigger: 'automatic' | 'manual'; dryRun: boolean; actions: string[]; warnings: string[] };
        let lastFullRun: SyncRun | undefined; // last APPLIED full run (automatic every 30 min, or Apply) — shown on the Access check card
        const runAccessSync = async (dryRun: boolean, only?: string) => {
          const credentials = await auth.getOwnServiceCredentials();
          const getEntities = async (filter: Record<string, string>) => (await catalog.getEntities({ filter }, { credentials })).items;
          const platform = (await getEntities({ kind: 'Group', 'metadata.name': 'platform-team' }))[0];
          const owners = membersOf(platform);
          const spaces = await readSpaces(getEntities, await readRegistry(await githubToken(config, OWNER), true));
          const github = await syncGithubAccess(config, spaces, dryRun, owners, only);
          // SonarQube follows the same roles (its own failure never blocks the GitHub part)
          const sonar = await syncSonarAccess(config, only ? spaces.filter(s => s.name === only) : spaces, dryRun, owners)
            .catch(e => ({ actions: [], warnings: [`SonarQube sync failed: ${e}`] }));
          return { ...github, actions: [...github.actions, ...sonar.actions], warnings: [...github.warnings, ...sonar.warnings] };
        };
        const remember = (trigger: SyncRun['trigger'], out: { dryRun: boolean; actions: string[]; warnings: string[] }) => {
          if (!out.dryRun) lastFullRun = { at: new Date().toISOString(), trigger, ...out };
        };
        router.get('/access/status', async (req, res) => {
          try {
            const { refs } = await caller(req);
            if (!refs.includes('group:default/platform-team')) { res.status(403).json({ error: 'platform-team only' }); return; }
            res.json({ lastRun: lastFullRun ?? null, everyMinutes: config.getOptionalBoolean('everesto.accessSync.enabled') ? 30 : null });
          } catch (e) { fail(res, e); }
        });
        router.post('/access/sync', async (req, res) => {
          try {
            const { refs, who } = await caller(req);
            if (!refs.includes('group:default/platform-team')) { res.status(403).json({ error: 'platform-team only' }); return; }
            const dryRun = req.query.dryRun !== '0';
            const out = await runAccessSync(dryRun);
            remember('manual', out);
            logger.info(`access sync (${dryRun ? 'dry run' : 'APPLIED'}) by ${who}: ${out.actions.length} actions, ${out.warnings.length} warnings`);
            if (!dryRun && out.warnings.length) logger.warn(`access sync warnings: ${out.warnings.join(' | ')}`);
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
              remember('automatic', out);
              if (out.actions.length || out.warnings.length) logger.info(`access sync: ${[...out.actions, ...out.warnings.map(w => `WARN ${w}`)].join(' | ')}`);
            },
          });
        }

        // ---- members of a DevOps Space (real Invite / Remove) ----
        /** Poll the catalog (max ~30 s) until the role groups show the change — true when visible. */
        const waitForCatalog = async (credentials: any, space: string, roles: string[], user: string, present: boolean) => {
          for (let i = 0; i < 15; i++) {
            const groups = await Promise.all(roles.map(r => catalog.getEntityByRef(`group:default/${space}-${r}`, { credentials })));
            if (groups.every(g => membersOf(g as any).includes(user) === present)) return true;
            await new Promise(r => setTimeout(r, 2000));
          }
          return false;
        };
        const memberChange = async (req: express.Request, res: express.Response, remove: boolean) => {
          const { space } = req.params;
          // add: one or several roles at once (body.roles) · remove: one role (body.role)
          const roles = [...new Set((Array.isArray(req.body?.roles) && !remove ? req.body.roles : [req.body?.role]) as SpaceRole[])];
          const login = str(req.body?.username).replace(/^@/, '');
          if (!/^[a-z0-9-]{1,63}$/.test(space) || !roles.length || !roles.every(r => SPACE_ROLES.includes(r)) || !/^[A-Za-z0-9-]{1,39}$/.test(login)) {
            res.status(400).json({ error: 'invalid space, role or GitHub username' });
            return;
          }
          try {
            const { refs, who } = await caller(req);
            const credentials = await auth.getOwnServiceCredentials();
            const sys = await catalog.getEntityByRef(`system:default/${space}`, { credentials });
            if (!sys) { res.status(404).json({ error: `space ${space} not found` }); return; }
            const mayGive = givableRoles(refs, space, String(sys.spec?.domain ?? ''));
            const refused = roles.filter(r => !mayGive.includes(r));
            if (refused.length) {
              res.status(403).json({ error: mayGive.length
                ? `you can ${remove ? 'take' : 'give'} only ${mayGive.join(', ')} in ${space} — ${refused.join(', ')} needs ${refused.includes('managers') ? 'the owner' : 'a manager or the owner'}`
                : `only maintainers, managers or the owner can change members of ${space}` });
              return;
            }
            const email = str(req.body?.email) || undefined;
            if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { res.status(400).json({ error: 'invalid email' }); return; }
            const out = remove
              ? await removeMember(config, space, roles[0], login, who)
              : await addMember(config, space, roles, login, email, str(req.body?.displayName) || undefined, who);
            // re-read the catalog files now instead of waiting for the next processing loop
            for (const ref of [...roles.map(r => `group:default/${space}-${r}`), 'group:default/platform-team']) {
              await catalog.refreshEntity(ref, { credentials }).catch(() => undefined);
            }
            // Apply access for THIS space right away (GitHub teams, repo permissions, ArgoCD, SonarQube) — no separate
            // "Apply" needed. Only once the catalog shows the change: a sync on stale data would undo it.
            const user = (out as any).user ?? login.toLowerCase();
            const visible = await waitForCatalog(credentials, space, roles, user, !remove);
            if (!visible) {
              out.warn.push('access (GitHub teams, ArgoCD, SonarQube) is applied by the automatic sync within 30 minutes — the catalog was not updated yet');
            } else {
              const acc = await runAccessSync(false, space).catch(e => ({ actions: [] as string[], warnings: [`access sync failed: ${e}`] }));
              out.done.push(...(acc.actions.length ? acc.actions.map(a => `access: ${a}`) : ['access: GitHub, ArgoCD and SonarQube already match']));
              out.warn.push(...acc.warnings);
            }
            logger.info(`members of ${space} (${roles.join(',')}) ${remove ? '-' : '+'} ${login} by ${who}: ${out.done.join(', ')}`);
            notify([`user:default/${login.toLowerCase()}`], remove
              ? { title: `Your ${roles[0]} role in ${sys.metadata.title ?? space} was removed`, description: `By ${who}.`, link: '/' }
              : { title: `You were added to ${sys.metadata.title ?? space}`, description: `As ${roles.join(' + ')}, by ${who}. Start with the space's Startup Guide.`, link: `/catalog/default/system/${space}/startup-guide` }, who);
            res.json(out);
          } catch (e) { fail(res, e); }
        };
        // ---- Import an existing repository into a space (Loop v1.1, via a pull request) ----
        router.get('/spaces/:space/importable', async (req, res) => {
          try {
            const { refs } = await caller(req);
            if (!allowed(refs, req.params.space, [...ROLE.CREATE])) { res.status(403).json({ error: `only maintainers/managers of ${req.params.space} can import` }); return; }
            res.json({ repos: await importableRepos(config) });
          } catch (e) { fail(res, e); }
        });
        router.post('/spaces/:space/import', async (req, res) => {
          const { space } = req.params;
          const b = req.body ?? {};
          const input: ImportInput = {
            repo: str(b.repo), stack: (STACKS.includes(b.stack) ? b.stack : 'python') as Stack,
            tests: b.tests !== false, semgrep: b.semgrep === true, sonarqube: b.sonarqube === true,
            dependabot: b.dependabot !== false, trivy: b.trivy === 'report' ? 'report' : 'enforce',
          };
          try {
            const { refs, who } = await caller(req);
            const out = await importRepo(config, space, input, refs, who);
            // team access + main ruleset for the new repo right away (scoped to this space)
            const acc = await runAccessSync(false, space).catch(e => ({ actions: [] as string[], warnings: [`access sync failed: ${e}`] }));
            out.done.push(...acc.actions.map(a => `access: ${a}`));
            out.warn.push(...acc.warnings);
            logger.info(`import ${input.repo} → ${space} by ${who}: ${out.prUrl}`);
            res.json(out);
          } catch (e) { fail(res, e); }
        });

        router.post('/spaces/:space/members', (req, res) => memberChange(req, res, false));
        router.post('/spaces/:space/members/remove', (req, res) => memberChange(req, res, true));

        // ---- DevOps Spaces: create (owner or the entity's managers) ----
        const takenNames = async () => {
          const credentials = await auth.getOwnServiceCredentials();
          const items = (await catalog.getEntities({ filter: [{ kind: 'System' }, { kind: 'Group' }, { kind: 'Domain' }], fields: ['metadata.name'] }, { credentials })).items;
          return items.map(e => e.metadata.name);
        };
        const canCreateSpace = (refs: string[], entity: string) => refs.includes('group:default/platform-team') || refs.includes(`group:default/${entity}-admins`);
        router.get('/entities/:entity/spaces/suggest', async (req, res) => {
          const { entity } = req.params;
          try {
            const { refs } = await caller(req);
            const taken = new Set(await takenNames());
            res.json({ canCreate: canCreateSpace(refs, entity), free: FLOWERS.filter(f => !taken.has(f)) });
          } catch (e) { fail(res, e); }
        });
        router.post('/entities/:entity/spaces', async (req, res) => {
          const { entity } = req.params;
          const name = str(req.body?.name).toLowerCase();
          try {
            const { refs, who } = await caller(req);
            if (!canCreateSpace(refs, entity)) { res.status(403).json({ error: `only the owner or managers of entity ${entity} can create spaces` }); return; }
            const credentials = await auth.getOwnServiceCredentials();
            if (!(await catalog.getEntityByRef(`domain:default/${entity}`, { credentials }))) { res.status(404).json({ error: `entity ${entity} not found` }); return; }
            const out = await createSpace(config, entity, name, str(req.body?.description).slice(0, 200), await takenNames(), who);
            await catalog.refreshEntity('location:default/everesto-catalog', { credentials }).catch(() => undefined);
            logger.info(`space ${name} created in ${entity} by ${who}`);
            notify([`group:default/${entity}-admins`, 'group:default/platform-team'], { title: `New DevOps Space: ${name}`, description: `Created in ${entity} by ${who}. Add people in Members.`, link: `/catalog/default/system/${name}/members` }, who);
            // GitHub teams for the roles — in the background (the 30-min sync would do it too)
            runAccessSync(false).then(r => logger.info(`access sync after new space ${name}: ${r.actions.length} actions`), e => logger.warn(`access sync after new space ${name} failed: ${e}`));
            res.json(out);
          } catch (e) { fail(res, e); }
        });

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
            spaceOfRepo(repo).then(space => space && notify(groupsOf(space, ['developers', 'maintainers', 'managers']), {
              title: `${repo}: ${out.to} ready for dev`, description: `By ${who} (was ${out.from ?? 'none'}). Click Sync on dev-${repo} in ArgoCD to roll it out.`, link: `https://argocd.everesto.live/applications/argocd/dev-${repo}`,
            }, who), () => undefined);
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
            spaceOfRepo(repo).then(space => space && notify(groupsOf(space, ['managers']), {
              title: `${repo}: promote to prod waiting for your approval`, description: `${out.from ?? 'new'} → ${out.to}, opened by ${who}. A manager approves the pull request, then Sync prod-${repo}.`, link: out.url, severity: 'high',
            }, who), () => undefined);
            res.json(out);
          } catch (e) { fail(res, e); }
        });

        httpRouter.use(router);
        // default auth policy: only signed-in users (no unauthenticated access)
      },
    });
  },
});
