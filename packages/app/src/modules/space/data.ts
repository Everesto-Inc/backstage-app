import { useApi } from '@backstage/core-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { identityApiRef } from '@backstage/core-plugin-api';
import { Entity, stringifyEntityRef } from '@backstage/catalog-model';
import useAsync from 'react-use/esm/useAsync';

/**
 * Data model (Backstage catalog):
 *   DevOps Space of an entity = Domain <animal>          (e.g. blackbuck)
 *   Project                   = System <river>, domain = entity   (e.g. seine)
 *   CI application            = Component, system = project, type service|website|library
 *   Repo-only application     = Component, type repository (no CI/CD, e.g. scripts, storage)
 *   CD pipeline               = Resource type gitops (ArgoCD → K3s) or deployment (Ansible/AWX → VMs)
 *   Roles                     = Groups <river>-owners / -maintainers / -developers / -viewers
 */

// owner = platform-team (super admin) — not a per-space role
export const ROLES = ['managers', 'maintainers', 'developers', 'viewers'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABEL: Record<Role, string> = {
  managers: 'Manager',
  maintainers: 'Maintainer',
  developers: 'Developer',
  viewers: 'Viewer',
};

export const useProjects = (domain: string) => {
  const catalogApi = useApi(catalogApiRef);
  return useAsync(async () => {
    const systems = await catalogApi.getEntities({
      filter: { kind: 'system', 'spec.domain': domain },
    });
    const parts = await catalogApi.getEntities({
      filter: [{ kind: 'component' }, { kind: 'resource' }],
    });
    return systems.items.map(sys => ({
      system: sys,
      parts: parts.items.filter(p => p.spec?.system === sys.metadata.name),
    }));
  }, [domain]);
};

export const useProjectParts = (system: string) => {
  const catalogApi = useApi(catalogApiRef);
  return useAsync(async () => {
    const res = await catalogApi.getEntities({
      filter: [
        { kind: 'component', 'spec.system': system },
        { kind: 'resource', 'spec.system': system },
        { kind: 'api', 'spec.system': system },
      ],
    });
    const items = res.items;
    return {
      ci: items.filter(e => e.kind === 'Component' && e.spec?.type !== 'repository'),
      repoOnly: items.filter(e => e.kind === 'Component' && e.spec?.type === 'repository'),
      cd: items.filter(e => e.kind === 'Resource' && ['gitops', 'deployment'].includes(String(e.spec?.type))),
      apis: items.filter(e => e.kind === 'API'),
    };
  }, [system]);
};

export type Member = { user: Entity; role: Role };

export const useMembers = (system: string) => {
  const catalogApi = useApi(catalogApiRef);
  return useAsync(async () => {
    const groups = await catalogApi.getEntities({
      filter: { kind: 'group', 'metadata.name': ROLES.map(r => `${system}-${r}`) },
    });
    const members: Member[] = [];
    for (const role of ROLES) {
      const g = groups.items.find(x => x.metadata.name === `${system}-${role}`);
      const refs = (g?.relations ?? []).filter(r => r.type === 'hasMember').map(r => r.targetRef);
      if (refs.length === 0) continue;
      const users = await catalogApi.getEntitiesByRefs({ entityRefs: refs });
      users.items.forEach(u => u && members.push({ user: u, role }));
    }
    return members;
  }, [system]);
};

/** Owner = platform-team (super admin): delete applications, make maintainers, everything. */
export const useIsProjectOwner = (_system: string) => {
  const identityApi = useApi(identityApiRef);
  const { value } = useAsync(() => identityApi.getBackstageIdentity(), []);
  const refs = value?.ownershipEntityRefs ?? [];
  return refs.includes('group:default/platform-team'); // owner = super admin
};

/** maintainers + owners (+ platform-team): create deployments, promote, change tools. */
/**
 * My role in a space. Owner = platform-team (super admin) · Entity Manager (<entity>-admins) = Manager of every space
 * of that entity · Manager / Maintainer / Developer / Viewer = the space's groups (Manager + Maintainer can be combined).
 * Backend enforces the same rules (packages/backend/src/modules/everestoRoles.ts).
 */
export const useSpaceRole = (system: string) => {
  const identityApi = useApi(identityApiRef);
  const catalogApi = useApi(catalogApiRef);
  const { value } = useAsync(async () => {
    const refs = (await identityApi.getBackstageIdentity()).ownershipEntityRefs;
    const sys = system ? await catalogApi.getEntityByRef(`system:default/${system}`) : undefined;
    return { refs, entity: String(sys?.spec?.domain ?? '') };
  }, [system]);
  const refs = value?.refs ?? [];
  const has = (g: string) => refs.includes(`group:default/${g}`);
  const superAdmin = has('platform-team');
  const entityAdmin = !!value?.entity && has(`${value.entity}-admins`); // Entity Manager = Manager of all its spaces
  const manager = superAdmin || entityAdmin || has(`${system}-managers`); // prod, delete apps, members
  const maintainer = manager || has(`${system}-maintainers`); // create CI/repo/CD, deploy dev, delete deployments
  const developer = maintainer || has(`${system}-developers`); // code via PR, dev secrets, Run build
  return { loaded: !!value, superAdmin, entityAdmin, manager, maintainer, developer, member: developer || has(`${system}-viewers`) };
};

export const useIsProjectMaintainer = (system: string) => useSpaceRole(system).maintainer;
export const useIsProjectManager = (system: string) => useSpaceRole(system).manager;

export const refOf = (e: Entity) => stringifyEntityRef(e);
