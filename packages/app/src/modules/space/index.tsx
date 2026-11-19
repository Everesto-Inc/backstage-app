import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { EntityCardBlueprint, EntityContentBlueprint } from '@backstage/plugin-catalog-react/alpha';

/**
 * DevOps Space pages — live data only (GitHub, SonarQube, ArgoCD, Infisical, the cluster).
 *   Entity  (Domain) → "/" hierarchy: entity → its projects (DevOps Spaces), [Create project]
 *   Project (System) → "/" Pipelines (CI / CD / repos, tool chains, [Edit]),
 *                      Startup Guide · API Docs · Members · Connections
 *   Tech Docs = the real TechDocs tab (entity-content:techdocs) + Mermaid addon, ordered in app-config.yaml
 * The default catalog Overview is switched off for domain + system in app-config.yaml.
 */
const tab = (name: string, path: string, title: string, filter: string, load: () => Promise<JSX.Element>) =>
  EntityContentBlueprint.make({ name, params: { path, title, filter, loader: load } });

export const spaceModule = createFrontendModule({
  pluginId: 'catalog',
  extensions: [
    // back to the DevOps Space from every application page (CI, CD, repository)
    EntityCardBlueprint.make({
      name: 'space-nav',
      params: {
        filter: 'kind:component,resource,group',
        type: 'content',
        loader: async () => {
          const { SpaceNavCard } = await import('./SpaceNavCard');
          return <SpaceNavCard />;
        },
      },
    }),
    tab('devops-space', '/', 'DevOps Space', 'kind:domain', async () => {
      const { SpaceOverview } = await import('./SpaceOverview');
      return <SpaceOverview />;
    }),
    tab('project-pipelines', '/', 'Pipelines', 'kind:system', async () => {
      const { ProjectPipelines } = await import('./ProjectPipelines');
      return <ProjectPipelines />;
    }),
    tab('project-startup', '/startup-guide', 'Startup Guide', 'kind:system', async () => {
      const { ProjectStartupGuide } = await import('./ProjectDocsApis');
      return <ProjectStartupGuide />;
    }),
    tab('project-apis', '/api-docs', 'API Docs', 'kind:system', async () => {
      const { ProjectApiDocs } = await import('./ProjectDocsApis');
      return <ProjectApiDocs />;
    }),
    tab('project-members', '/members', 'Members', 'kind:system', async () => {
      const { ProjectMembers } = await import('./ProjectMembers');
      return <ProjectMembers />;
    }),
    tab('project-connections', '/connections', 'Connections', 'kind:system', async () => {
      const { ProjectConnections } = await import('./ProjectConnections');
      return <ProjectConnections />;
    }),
  ],
});
