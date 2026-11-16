import { useApi } from '@backstage/core-plugin-api';
import { catalogApiRef, useEntity } from '@backstage/plugin-catalog-react';
import { Box, Typography } from '@material-ui/core';
import { Link } from 'react-router-dom';
import useAsync from 'react-use/esm/useAsync';

/** Top of every application page (CI, CD, repository): one click back to its DevOps Space + breadcrumb. */
export const SpaceNavCard = () => {
  const { entity } = useEntity();
  const catalogApi = useApi(catalogApiRef);
  // apps: spec.system · space team "orchid": its own name · role groups "orchid-developers": spec.parent
  const isSpaceGroup = entity.kind === 'Group' && entity.metadata.labels?.['everesto.live/level'] === 'space';
  let space = String(entity.spec?.system ?? '');
  if (!space && isSpaceGroup) space = String(entity.spec?.type === 'role' ? entity.spec?.parent : entity.metadata.name);
  const { value: sys } = useAsync(async () => (space ? catalogApi.getEntityByRef(`system:default/${space}`) : undefined), [space]);
  if (!space) return null;
  const spaceTitle = sys?.metadata.title ?? `DevOps Space – ${space}`;
  const entityName = String(sys?.spec?.domain ?? '');
  // the space title itself is the link: always lands on the space's Pipelines page (all CI / CD / repositories)
  return (
    <Box>
      <Link to={`/catalog/default/system/${space}`} style={{ textDecoration: 'none', color: 'inherit' }}>
        <Typography variant="h5" style={{ fontWeight: 800 }}>{spaceTitle}</Typography>
      </Link>
      <Typography variant="caption" color="textSecondary">
        {entityName ? `${entityName} › ` : ''}{spaceTitle} › {entity.metadata.title ?? entity.metadata.name}
      </Typography>
    </Box>
  );
};
