import { useApi } from '@backstage/core-plugin-api';
import { catalogApiRef, useEntity } from '@backstage/plugin-catalog-react';
import { Box, Button, Typography } from '@material-ui/core';
import ArrowBack from '@material-ui/icons/ArrowBack';
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
  const crumb = { textDecoration: 'none', color: 'inherit', fontWeight: 600 } as const;
  return (
    <Box display="flex" alignItems="center" flexWrap="wrap" style={{ gap: 16 }}>
      <Button component={Link} to={`/catalog/default/system/${space}`} variant="contained" color="primary" disableElevation startIcon={<ArrowBack />}>
        {spaceTitle}
      </Button>
      <Typography variant="body2" color="textSecondary">
        {entityName && <><Link to={`/catalog/default/domain/${entityName}`} style={crumb}>{entityName}</Link>{' › '}</>}
        <Link to={`/catalog/default/system/${space}`} style={crumb}>{spaceTitle}</Link>
        {' › '}<b>{entity.metadata.title ?? entity.metadata.name}</b>
      </Typography>
    </Box>
  );
};
