import { configApiRef, useApi } from '@backstage/core-plugin-api';
import { Box, Typography } from '@material-ui/core';
import LinkIcon from '@material-ui/icons/Link';

/** true only when app-config sets everesto.demoData (local preview). */
export const useDemoData = () =>
  useApi(configApiRef).getOptionalBoolean('everesto.demoData') ?? false;

/** Placeholder shown in production where a tool's live data will appear. */
export const ConnectToSee = ({ what, tools }: { what: string; tools: string }) => (
  <Box
    display="flex"
    alignItems="center"
    p={2}
    borderRadius={12}
    style={{ gap: 10, border: '1px dashed rgba(128,128,128,0.4)' }}
  >
    <LinkIcon color="disabled" />
    <Typography variant="body2" color="textSecondary">
      {what} will appear here once <b>{tools}</b> {tools.includes(',') ? 'are' : 'is'} connected to Backstage.
    </Typography>
  </Box>
);
