import { ReactNode } from 'react';
import { Box, Button, ButtonProps, CircularProgress, LinearProgress, Typography } from '@material-ui/core';

/**
 * Feedback for anything that calls the backend: the screen must never look frozen.
 *
 *   <BusyButton busy={busy} busyLabel="Creating…" onClick={create}>Create</BusyButton>
 *     → while busy: disabled, spinner in the button, label "Creating…"
 *   <BusyBar busy={busy} hint="This can take up to a minute." />
 *     → thin progress bar (+ optional hint) at the top of a dialog / card while busy
 */
export type BusyButtonProps = ButtonProps & {
  busy: boolean;
  /** label while busy, e.g. "Deleting…" (default: the normal label) */
  busyLabel?: ReactNode;
};

export const BusyButton = ({ busy, busyLabel, children, disabled, startIcon, ...rest }: BusyButtonProps) => (
  <Button
    {...rest}
    disabled={disabled || busy}
    aria-busy={busy}
    startIcon={busy ? <CircularProgress size={14} color="inherit" thickness={5} /> : startIcon}
  >
    {busy ? (busyLabel ?? children) : children}
  </Button>
);

export const BusyBar = ({ busy, hint }: { busy: boolean; hint?: ReactNode }) =>
  busy ? (
    <Box mb={1}>
      <LinearProgress />
      {hint && (
        <Typography variant="caption" color="textSecondary" component="div" style={{ marginTop: 4 }}>
          {hint}
        </Typography>
      )}
    </Box>
  ) : null;

/** Standard hint for slow, multi-system actions (GitHub + Infisical + ArgoCD …). */
export const SLOW_HINT = 'Working — this can take up to a minute. Please keep this window open.';
