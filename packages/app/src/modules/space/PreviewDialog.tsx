import { ReactNode } from 'react';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@material-ui/core';

/** Dialog used by every dummy action: explains what the real action will do. */
export const PreviewDialog = ({
  open,
  onClose,
  title,
  steps,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  steps: ReactNode[];
  children?: ReactNode;
}) => (
  <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
    <DialogTitle>{title}</DialogTitle>
    <DialogContent>
      {children}
      <Typography variant="body2" color="textSecondary" paragraph style={{ marginTop: children ? 16 : 0 }}>
        Preview — nothing is changed. The real action will:
      </Typography>
      <Box component="ol" pl={3} m={0} style={{ lineHeight: 1.8 }}>
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </Box>
    </DialogContent>
    <DialogActions>
      <Button onClick={onClose}>Close</Button>
    </DialogActions>
  </Dialog>
);
