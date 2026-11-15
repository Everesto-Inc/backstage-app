# CLAUDE.md — backstage-app

> Backstage developer portal for the everesto.live platform — https://backstage.everesto.live
> Parent `oracle/CLAUDE.md` applies (free tier only, ARM images, ArgoCD deploys everything).
> Deployment manifests live in the sibling repo `../gitops-backstage/` (public — no secrets, no internal IPs).

---

## Stack

| Piece | Choice |
|---|---|
| Backstage | new frontend system (`@backstage/frontend-defaults`), new backend system |
| Node | 22 (`.nvmrc`) — `node_modules` is compiled for 22, Node 20 breaks `better-sqlite3` |
| Login (prod) | GitHub OAuth, resolver `usernameMatchingUserEntityName` — only users in `everesto-catalog/platform/org.yaml` (private repo, read with `GITHUB_TOKEN`) |
| Login (local) | Guest, signed in **as** `user:default/jacer7` (`app-config.local.yaml`) |
| Database (prod) | PostgreSQL on the GCP VM, TLS verified with pinned CA, one schema per plugin |
| Database (local) | in-memory SQLite (wiped on restart) |
| Secrets (prod) | Infisical project `backstage`/`prod` → ClusterSecretStore `infisical-backstage` (login in ns `external-secrets`) → ESO → secret `backstage-secrets` in ns `prod-backstage` |
| Secrets (local) | none |
| Permissions | custom policy `packages/backend/src/modules/permissionPolicy.ts` (writes = `platform-team` only) |
| Image | `ghcr.io/everesto-inc/backstage`, linux/arm64, built by `.github/workflows/ci.yml` |
| Deploy | CI bumps tag in `gitops-backstage/apps/prod/values.yaml` → ArgoCD app `prod-backstage` (project `backstage`, path `apps/prod`) → ns `prod-backstage` → NodePort 30700 → Traefik on alb |
| Environments | **dev** = local (`yarn start`) · **prod** = K3s ns `prod-backstage` (only one in-cluster copy) |

## Config files

| File | Loaded by | Purpose |
|---|---|---|
| `app-config.yaml` | always | base / local dev defaults |
| `app-config.local.yaml` | `yarn start` only (gitignored, not in image) | guest-as-jacer7 login |
| `app-config.production.yaml` | container `CMD` / Helm `args` | real URL, CSP, Postgres+TLS, GitHub auth |

## Run locally

```bash
nvm use 22
yarn install        # first time / after yarn.lock changes
yarn start          # http://localhost:3000 → click "Guest"
pkill -f backstage-cli   # stop
```
Right after start, Guest may lack `platform-team` for ~20 s until the catalog has ingested `org.yaml`.

## Gotchas
- Guest provider is only loaded when `NODE_ENV !== 'production'` (`packages/backend/src/index.ts`).
- Audit exceptions must be kept in sync in **both** `.yarnrc.yml` (`npmAuditIgnoreAdvisories`) and `.trivyignore`.
- Each plugin has its own DB pool (max 3) — the GCP Postgres allows ~100 connections.
- Never commit secrets; `*.local.yaml` and `.env` are gitignored.

---


# Product requirements — multi-tenant DevOps portal

> Status: **draft / target design**. Nothing below is implemented yet.

## 1. Hierarchy

```
Platform  (Backstage itself — run by platform-admins)
 └── Entity        RARE ANIMAL name     e.g. blackbuck       tenant / organisation
      └── Project  FLOWER name          e.g. orchid          unit of onboarding = one DevOps Space
           └── Applications  <flower>-<what>                  each one ALWAYS has a CI part + a CD part
                ├── orchid-java-backend      (CI repo)  ┐
                ├── orchid-react-frontend    (CI repo)  ├─ CD: folders in ONE repo orchid-gitops-cd
                └── orchid-storage-pipeline  (CI repo)  ┘
```

Rules:
- A project belongs to **exactly one** entity.
- Each project has **one DevOps Space**; a space holds **many applications** (frontend, backend,
  pipelines …). Every application has a CI block and a CD block.
- **Onboarding is per project**, not per entity.
- A user can be a member of **several spaces, also in other entities**. Example: `user-fox`
  (a user of entity *fox*, illustrative) is invited into the `orchid` space → sees two spaces.

## 2. Naming convention (enforced by templates)

Backstage names: lowercase, `a-z0-9-`, max 63 chars. Templates validate with a regex + allow-list.

| Level | Rule | Examples |
|---|---|---|
| Entity | rare animal | `blackbuck`, `okapi`, `axolotl`, `saola`, `vaquita`, `kakapo`, `pangolin`, `aye-aye`, `takin`, `markhor`, `dhole`, `snow-leopard`, `red-panda`, `shoebill` |
| Project / Space | flower | `orchid`, `lotus`, `iris`, `dahlia`, `peony`, `magnolia`, `camellia`, `jasmine`, `lavender`, `tulip`, `azalea`, `protea` |
| Application (CI) | `<tech>-<role>` — **no project prefix**, unique in the org | `java-backend`, `react-frontend` |
| Application CD repo | `<app>-gitops` (one per app: `apps/dev`, `apps/prod`, `argocd/`) | `java-backend-gitops` |

Project (flower) names must be unique across the whole platform — they prefix repo names in GitHub.

### Name picker (flower, same mechanism for animals)

The create-project form has a **combo box** (dropdown + free text):
- **Suggestions** come from a large built-in flower list (hundreds of names).
- Names **already taken are hidden** from the dropdown (taken = a `System` with that name exists in the
  catalog, or a repo `Everesto-Inc/<name>-*` exists).
- The user may **type their own** flower name instead.
- Validation, both in the form and again server-side in the template's first step (avoids two people
  grabbing the same name at once): format regex, not taken, max length leaves room for
  `-<tech>-<role>` suffixes in repo names.

Implementation: custom scaffolder **field extension** (MUI Autocomplete `freeSolo`) querying the
catalog API + a small custom action `everesto:name:check-available`.

## 3. Who can do what — three admin levels

Decision: **super admin is a platform role, not a "Super DevOps Space".**
A space is tenant data; mixing platform administration into it would let a tenant-level
membership change grant platform-wide power. A separate `platform-admins` group is simpler to
enforce in the permission policy and to audit.

| Level | Group | Can |
|---|---|---|
| Platform | `platform-admins` (today: `platform-team`) | create/delete **entities**, name the entity owner, everything below |
| Entity | `<animal>-admins` e.g. `blackbuck-admins` | create/delete **projects** (spaces) in their entity, name space owners |
| Space | roles below | work inside the space |

### Space roles (decided 2026-11-16)

| Role | Who | Can |
|---|---|---|
| **owner** | **platform-team** (super admin) — not a per-space group | everything, every space: delete applications, create/delete spaces and entities, add any member anywhere, change Backstage |
| **entity admin** (`<entity>-admins`, optional — may be empty) | manager of a whole entity | = maintainer of EVERY space of that entity (sees and manages them all); later: create/delete spaces in it |
| **maintainer** (`<space>-maintainers`) | manager of ONE space | developer + Create deployment, Deploy, **Promote to prod**, **prod secrets**, change tools, delete deployments, add members of their space (developers, viewers, maintainers) |
| **developer** (`<space>-developers`) | team member | Create pipeline (CI), push code **via pull request only**, dev secrets, Run build — no prod, no delete |
| **viewer** (`<space>-viewers`) | read-only | see everything in the space (names of secrets, never values) |

Platform entities (domain `platform`, annotation `everesto.live/protected`) can't be deleted from Backstage by anyone.
GitHub (access sync, Members tab → Preview/Apply): teams `<space>-developers` → push on CI repos,
`<space>-maintainers` → maintain on CI + push on gitops; nobody admin; `main` = PR only (ruleset `everesto-main`).

### Access follows the role into every tool

| Tool | developer | maintainer / owner |
|---|---|---|
| GitHub (org `Everesto-Inc`, one team per space role) | team `orchid-developers`: `write` on `orchid-*` repos | team `orchid-maintainers`: `maintain` |
| SonarQube | browse + see source | administer project |
| ArgoCD | AppProject per space: view + sync | + delete / override |
| Infisical | developer on the space's secrets | admin |

Deletes run as a Backstage action (maintainer+ only) with the platform bot token — humans never need GitHub `admin`.

## 4. Inviting users (by email)

Login stays **GitHub** — every user needs a GitHub account and is invited into the GitHub
organisation **`Everesto-Inc`**. Invitations are by email:

1. Space owner enters `email` + `role` → Backstage creates a pending `User` (email in `profile.email`).
2. Invitation email with a link to Backstage (+ invite to GitHub org `Everesto-Inc` by email via the GitHub API).
3. User signs in with GitHub → custom sign-in resolver reads the user's **verified** GitHub emails
   (`user:email` scope) and matches the pending invitation → binds GitHub username to the `User`.
4. Access sync grants GitHub / SonarQube / ArgoCD / Infisical rights for the role.

Unmatched GitHub logins are refused (as today).

## 5. Golden path — create an application

Inside a space, Backstage **Software Template**:

1. Name: `orchid-java-backend` (prefix = space's flower, fixed)
2. SCM: **GitHub** (only option)
3. Technology: **Java** (later Node, Python, Go …)
4. Quality: **SonarQube** (existing, tools node)
5. Secrets: **Infisical** (default, pre-selected)
6. CD: **ArgoCD** (existing)

Creates and registers:

| Repo | Contains |
|---|---|
| `orchid-java-backend` | skeleton + GitHub Actions **CI**: test → SonarQube quality gate → build ARM image → push ghcr.io → bump tag in the space's gitops repo |
| `orchid-gitops-cd` (one per **space**, created with the space) | folder `java-backend/` added for this app → **CD**: an ArgoCD ApplicationSet per space syncs every folder to namespace `orchid` |

Plus SonarQube project, Infisical folder + ESO `ExternalSecret`, ArgoCD Application in the space's
AppProject — all owned by the space. Same pattern as `backstage-app` ↔ `gitops-backstage`.

## 6. Mapping onto Backstage

| Our concept | Backstage kind |
|---|---|
| Entity (animal) | `Domain` + `Group` type `organization` (`blackbuck`, `blackbuck-admins`) |
| Project / Space (flower) | `System` + `Group` type `team` with role sub-groups (`orchid-owners`, `-maintainers`, `-developers`, `-viewers`) |
| Application | `Component` (CI repo), `partOf` the System; space gitops repo = `Resource` of the System |
| User | `User` (`metadata.name` = GitHub username, `profile.email` = invite email) |

Org data lives in the private repo `Everesto-Inc/everesto-catalog` (sibling folder `../everesto-catalog`), which templates will write to.

## 7. Backstage built-in vs. our work

| Need | Backstage | Work |
|---|---|---|
| Catalog of entities / projects / apps | built-in | model + catalog repo |
| Create-application wizard | Software Templates | templates + custom actions (SonarQube, Infisical, ArgoCD) |
| CI block | GitHub Actions plugin | install |
| CD block | ArgoCD + Kubernetes plugins | install + config |
| Quality | SonarQube plugin | install |
| Roles in Backstage | permission framework | extend `permissionPolicy.ts` (3 admin levels + space roles) |
| **Space UI: invite / roles** | **not built-in** | custom page or templates |
| **Email invitation + GitHub binding** | **not built-in** | custom sign-in resolver + invite flow |
| **Role sync to GitHub / Sonar / ArgoCD / Infisical** | **not built-in** | custom actions or backend sync module |

## 8. Phases

1. **Catalog model** — entities, projects, spaces, users in a catalog repo; naming validation.
2. **Golden path** — Java template: app repo + gitops repo + Sonar + Infisical + ArgoCD app.
3. **CI/CD views** — GitHub Actions, SonarQube, ArgoCD, Kubernetes plugins.
4. **Permissions** — platform-admin / entity-admin / space roles in the policy.
5. **Space management + email invites** — owner invites by email, assigns roles.
6. **Access sync** — roles propagated to GitHub, SonarQube, ArgoCD, Infisical.

## 9. Architecture decisions

1. **One gitops repo per space** (`orchid-gitops-cd`, folder per app) instead of one per application:
   half the repos, one ArgoCD ApplicationSet per space, one place to see what a space deploys.
2. **Spaces, members and roles live in Backstage's Postgres** (custom catalog entity provider + small
   API), not in git YAML — an invite must not be a git commit. Git keeps templates + app `catalog-info.yaml`.
3. **Tool access is reconciled, not fired once.** Backstage is the source of truth; a scheduled backend
   job makes GitHub teams, SonarQube groups, ArgoCD AppProjects and Infisical match it (idempotent,
   repairs manual drift).
4. **Tenant isolation in K3s**, per space:
   - namespace `<flower>` (e.g. `orchid`)
   - `ResourceQuota` (e.g. 512Mi) + `LimitRange` defaults
   - `NetworkPolicy`: deny traffic from other spaces' namespaces
   - ArgoCD `AppProject`: only its own namespace + its own repos
5. **Secrets at scale (ESO):** one ESO for the cluster; per **space**: 1 Infisical project
   (envs dev/prod, folder per app), 1 machine identity (Viewer on that project only),
   1 `ClusterSecretStore infisical-<flower>` restricted by `conditions` to the space's namespace,
   login secret in ns `external-secrets` (platform only). Per **app**: 1 folder + 1 ExternalSecret.
   The "create space" template provisions all of it via the Infisical API. Backstage itself is
   the first instance (`gitops-backstage/platform/cluster-secret-store.yaml`).
   Check later: ESO Kubernetes Auth for Infisical → no client secrets to manage at all.
6. **Node placement:**

   | Node | Pool | Runs |
   |---|---|---|
   | `dev-k3s-control-plane` (2 vCPU / 10 GB) | platform | K3s API, AWX, ArgoCD, ESO, platform apps — **never tenant apps** |
   | `dev-k3s-argocd` (1 vCPU / 4 GB) | `everesto.live/pool=tenants` | Backstage + all apps created from Backstage |
   | `dev-k3s-tools` (if joined to K3s later) | `everesto.live/pool=tenants` | extra tenant capacity |

   Node label set by ansible `01_v2_join_k3s_workers.yml`; templates write
   `nodeSelector: {everesto.live/pool: tenants}` into every generated manifest.
   Budget on the argocd node: ~4 GB − OS 0.7 − Backstage ≤1.5 → **~1.5–2 GB for all tenant apps**.
   Measured 2026-11-13: control-plane 6.2 GB used (all workloads), argocd node 0.7 GB (nothing scheduled).

## 10. Constraints

- Free tier: A1.Flex is at cap → apps share the existing K3s nodes; no per-tenant clusters.
  Realistic scale: a demo with 1–2 entities and a handful of small apps, not real tenants.
- ARM (`linux/arm64`) images only.
- GitHub Free org: private repos share 2,000 Actions min/month + 500 MB packages; public repos are free
  and unlimited. Decided: **public by default** → native `ubuntu-24.04-arm` runner; private repos fall
  back to `ubuntu-latest` + QEMU. No payment method on the accounts → GitHub blocks, never bills.
- Exposed apps need a Traefik route on alb (ansible repo `files/traefik/conf.d/`).

## 11. Decisions

- **One GitHub organisation for everything: `Everesto-Inc`.** All repos live there
  (`Everesto-Inc/orchid-java-backend`, `Everesto-Inc/orchid-gitops-cd`). Tenants are separated by
  GitHub **teams** per space role, not by orgs. Repos are **public** by default (free unlimited CI,
  native ARM runners, public images → no pull secrets, free secret push protection); private on request
  in the Create pipeline form. Secrets never in code: GitHub secrets / Infisical, Gitleaks in CI,
  GitHub secret scanning + push protection enabled on every public repo.
- Project names: flower suggestions (taken ones hidden) **or** free input, validated for uniqueness.
- Super admin = `platform-admins` group, not a space.
- Users invited by email; login with GitHub.

## 12. CI and CD are separate (decided 2026-11-14)

- **Create pipeline** (developers+): repo `Everesto-Inc/<name>` (no project prefix), Loop CI. PRs/branches: tests + scans
  (+ image built and scanned, not pushed). main: same + image pushed to ghcr.io (every merge, or "Run build" button).
  **CI never deploys.**
- **Create deployment** (maintainers/owners, backend-enforced) — Infisical is required and runs FIRST:
  1. Infisical project `<app>-gitops` (one per application) → env dev with the app's secrets (values optional, else
     CHANGE_ME), identity `eso-<app>` (viewer) — its login shown once as a kubectl command (secret `infisical-<app>-auth`).
  2. public repo `<app>-gitops`: `apps/dev` (newest image), `argocd/argocd.yaml`, `argocd/secret-stores.yaml`.
  3. catalog Resource `<app>-gitops` (dependsOn the CI component).
- Default env **dev** (ns `<project>-dev`). **Every ArgoCD sync is manual.** "Deploy to dev" = pick one of the last
  5 builds → tag committed to `apps/dev`. "Promote to prod" = PR (prod tag := dev tag); the first promote also creates
  `apps/prod`, ns `<project>-prod`, the prod secrets in Infisical and `argocd/argocd-prod.yaml`.
- **Delete deployment** (owners): deletes `<app>-gitops`, catalog Resource, Infisical project `<app>-gitops` + identity `eso-<app>`. Kept: ghcr.io images only (the kubectl command also removes the apps, both stores and `infisical-<app>-auth`). Delete application does the same for its deployment.
- Backstage has **no cluster access** — it returns kubectl commands. Tenant pods need node label
  `everesto.live/pool=tenants`. CD tool: ArgoCD only (no Ansible). Grafana: placeholder.
- Backstage ↔ Infisical: identity `backstage-platform` (org Admin), keys INFISICAL_CLIENT_ID / _SECRET / _ORG_ID.
