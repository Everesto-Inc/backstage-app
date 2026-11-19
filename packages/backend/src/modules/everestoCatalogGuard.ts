/**
 * Catalog guard: an application's DevOps Space comes from the app registry (everestoRegistry), never from the
 * repo's own catalog-info.yaml. Entities read from a tenant repo (github.com/Everesto-Inc/<repo>/…) get
 * spec.system / spec.owner forced to the registered space; a mismatch is logged. The platform catalog
 * (everesto-catalog) is trusted as-is.
 */
import { Entity } from '@backstage/catalog-model';
import { Config } from '@backstage/config';
import { LoggerService, coreServices, createBackendModule } from '@backstage/backend-plugin-api';
import { CatalogProcessor, catalogProcessingExtensionPoint } from '@backstage/plugin-catalog-node';
import { githubToken } from './everestoActions';
import { REGISTRY_REPO, baseRepo, readRegistry } from './everestoRegistry';

/** Pure: repo name from a location target like https://github.com/Everesto-Inc/<repo>/blob/main/catalog-info.yaml */
export function repoOfTarget(target: string): string | undefined {
  return target.match(/github\.com\/Everesto-Inc\/([a-z0-9][a-z0-9-]*)\//i)?.[1]?.toLowerCase();
}

/** Pure: the entity with its space forced to the registered one (unchanged when not a tenant app). */
export function guardEntity(entity: Entity, repo: string | undefined, registry: Record<string, string>): { entity: Entity; changedFrom?: string } {
  if (!repo || repo === REGISTRY_REPO) return { entity };
  if (entity.kind !== 'Component' && entity.kind !== 'Resource') return { entity };
  const space = registry[baseRepo(repo)];
  const claimed = entity.spec?.system as string | undefined;
  if (!space || claimed === space) return { entity };
  return {
    entity: { ...entity, spec: { ...entity.spec, system: space, owner: space } },
    changedFrom: claimed ?? '(none)',
  };
}

class SpaceGuardProcessor implements CatalogProcessor {
  constructor(private readonly config: Config, private readonly logger: LoggerService) {}
  getProcessorName() { return 'EverestoSpaceGuard'; }
  async preProcessEntity(entity: Entity, location: { type: string; target: string }): Promise<Entity> {
    const repo = repoOfTarget(location.target);
    if (!repo || repo === REGISTRY_REPO) return entity;
    let registry: Record<string, string>;
    try { registry = await readRegistry(await githubToken(this.config, 'Everesto-Inc')); } catch { return entity; }
    const out = guardEntity(entity, repo, registry);
    if (out.changedFrom) {
      this.logger.warn(`catalog guard: ${entity.kind} ${entity.metadata.name} in ${repo} claims space ${out.changedFrom}; registry says ${out.entity.spec?.system} — using the registry`);
    }
    return out.entity;
  }
}

export const everestoCatalogGuardModule = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'everesto-space-guard',
  register(env) {
    env.registerInit({
      deps: { catalog: catalogProcessingExtensionPoint, config: coreServices.rootConfig, logger: coreServices.logger },
      async init({ catalog, config, logger }) {
        catalog.addProcessor(new SpaceGuardProcessor(config, logger));
      },
    });
  },
});
