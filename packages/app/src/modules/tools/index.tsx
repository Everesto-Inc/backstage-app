import { createFrontendModule } from '@backstage/frontend-plugin-api';
import {
  EntityCardBlueprint,
  EntityContentBlueprint,
} from '@backstage/plugin-catalog-react/alpha';
import { TOOLS } from './tools';

/**
 * DevOps tools on an application (Component) page — DUMMY layout preview.
 *  - "Tools" card on Overview: connected / [Add]
 *  - one tab per tool (CI, Quality, CD, Secrets, Monitoring), grouped
 * Only for Components (applications). Tab data is fake.
 */
const toolsCard = EntityCardBlueprint.make({
  name: 'devops-tools',
  params: {
    filter: 'kind:component,resource',
    loader: async () => {
      const { ToolsCard } = await import('./ToolsCard');
      return <ToolsCard />;
    },
  },
});

const toolTabs = TOOLS.filter(tool => tool.tab).map(tool =>
  EntityContentBlueprint.make({
    name: `devops-${tool.id}`,
    params: {
      path: `/${tool.id}`,
      title: tool.tab!,
      group: tool.group,
      filter: tool.stage === 'ci' ? 'kind:component' : 'kind:resource',
      loader: async () => {
        const { makeToolTab } = await import('./ToolTab');
        const Tab = makeToolTab(tool.id);
        return <Tab />;
      },
    },
  }),
);

const securityTab = EntityContentBlueprint.make({
  name: 'devops-security',
  params: {
    path: '/security',
    title: 'Security',
    group: 'security',
    filter: 'kind:component',
    loader: async () => {
      const { SecurityTab } = await import('./SecurityTab');
      return <SecurityTab />;
    },
  },
});

export const toolsModule = createFrontendModule({
  pluginId: 'catalog',
  extensions: [toolsCard, ...toolTabs, securityTab],
});
