import { useEntity } from '@backstage/plugin-catalog-react';
import { InfoCard } from '@backstage/core-components';
import { Box, Typography } from '@material-ui/core';
import LinkIcon from '@material-ui/icons/Link';
import { compatWrapper } from '@backstage/core-compat-api';
import { SonarQubeCard } from '@backstage-community/plugin-sonarqube';
import { TOOLS, Tool, toolState } from './tools';
import { ToolLogo } from './ToolLogo';
import { RealCiTab, RealCodeTab, RealImageTab } from '../space/RealMetrics';
import { SecretsTab } from '../space/SecretsTab';
import { ClusterTab } from '../space/ClusterTab';

/** One tab per tool on an application page (CI, Code, Image, Quality, CD, Secrets …) — live data only. */

const NotAdded = ({ tool }: { tool: Tool }) => (
  <InfoCard title={<Box display="flex" alignItems="center" style={{ gap: 12 }}><ToolLogo tool={tool} />{`${tool.name} is not set up for this application`}</Box>}>
    <Typography variant="body2" paragraph>{tool.description}.</Typography>
    <Typography variant="body2" paragraph color="textSecondary">
      Maintainers add it with <b>Edit</b> on this application's pipeline card (DevOps Space → Pipelines).
    </Typography>
  </InfoCard>
);

/** A tool that is set up for the app but has no Backstage view yet (e.g. Grafana). */
const NoLiveView = ({ tool }: { tool: Tool }) => (
  <Box display="flex" alignItems="center" p={2} borderRadius={12} style={{ gap: 10, border: '1px dashed rgba(128,128,128,0.4)' }}>
    <LinkIcon color="disabled" />
    <Typography variant="body2" color="textSecondary">
      Live {tool.name} data is not shown in Backstage yet — open {tool.name} directly.
    </Typography>
  </Box>
);

export const makeToolTab = (toolId: string) => () => {
  const { entity } = useEntity();
  const tool = TOOLS.find(t => t.id === toolId)!;
  // deployment (Resource <app>-gitops): Infisical always on; Ansible excluded while ArgoCD deploys
  if (entity.kind === 'Resource' && toolId === 'secrets') return <SecretsTab entity={entity} />;
  if (entity.kind === 'Resource' && toolId === 'cd') return <ClusterTab entity={entity} />;
  if (entity.kind === 'Resource' && toolId === 'config') {
    return <Typography variant="body2" color="textSecondary">Ansible is not used — ArgoCD deploys this app (one deployment tool per app).</Typography>;
  }
  if (toolState(entity, tool).kind === 'missing') return <NotAdded tool={tool} />;
  if (toolId === 'quality') return compatWrapper(<SonarQubeCard />);
  if (toolId === 'ci') return <RealCiTab entity={entity} />;
  if (toolId === 'code') return <RealCodeTab entity={entity} />;
  if (toolId === 'registry') return <RealImageTab entity={entity} />;
  return <NoLiveView tool={tool} />;
};
