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
import { ROLE, ToolChange, allowed, appInfo, deleteApp, readFile, setTools } from './everestoManage';
import { builds, createDeployment, deleteDeployment, deploy, devHost, newEsoLogin, nsKeyOf, promote, secretDelete, secretSet, secretsList, setupCommands } from './everestoDeploy';
import { gh, githubToken } from './everestoActions';
import { syncSonarAccess } from './everestoSonarAccess';
import { readRegistry } from './everestoRegistry';
import { pipelineInsights } from './everestoPipeline';
import { collectEsoState, explainStatus, probeUrl } from './everestoStatus';
import { argoApp, podLogs, workloads } from './everestoK8s';
import { expandEntityAdmins, readSpaces, syncGithubAccess } from './everestoAccess';
import { FLOWERS, createSpace } from './everestoSpaces';
import { SPACE_ROLES, SpaceRole, addMember, givableRoles, removeMember } from './everestoMembers';

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
      },
      async init({ httpRouter, config, logger, httpAuth, userInfo, auth, catalog, scheduler }) {
        const cache = new Map<string, { at: number; data: unknown }>();
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
            nsKey: str(b.nsKey).toLowerCase() || undefined,
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
        const runAccessSync = async (dryRun: boolean) => {
          const credentials = await auth.getOwnServiceCredentials();
          const getEntities = async (filter: Record<string, string>) => (await catalog.getEntities({ filter }, { credentials })).items;
          const platform = (await getEntities({ kind: 'Group', 'metadata.name': 'platform-team' }))[0];
          const owners = membersOf(platform);
          const spaces = await readSpaces(getEntities, await readRegistry(await githubToken(config, OWNER), true));
          const github = await syncGithubAccess(config, spaces, dryRun, owners);
          // SonarQube follows the same roles (its own failure never blocks the GitHub part)
          const sonar = await syncSonarAccess(config, spaces, dryRun, owners).catch(e => ({ actions: [], warnings: [`SonarQube sync failed: ${e}`] }));
          return { ...github, actions: [...github.actions, ...sonar.actions], warnings: [...github.warnings, ...sonar.warnings] };
        };
        router.post('/access/sync', async (req, res) => {
          try {
            const { refs, who } = await caller(req);
            if (!refs.includes('group:default/platform-team')) { res.status(403).json({ error: 'platform-team only' }); return; }
            const dryRun = req.query.dryRun !== '0';
            const out = await runAccessSync(dryRun);
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
              if (out.actions.length || out.warnings.length) logger.info(`access sync: ${[...out.actions, ...out.warnings.map(w => `WARN ${w}`)].join(' | ')}`);
            },
          });
        }

        // ---- members of a DevOps Space (real Invite / Remove) ----
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
            logger.info(`members of ${space} (${roles.join(',')}) ${remove ? '-' : '+'} ${login} by ${who}: ${out.done.join(', ')}`);
            res.json(out);
          } catch (e) { fail(res, e); }
        };
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
