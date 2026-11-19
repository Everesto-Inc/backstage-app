import { useMemo, useState } from 'react';
import { alertApiRef, useApi } from '@backstage/core-plugin-api';
import { Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, TextField, Typography } from '@material-ui/core';
import useAsync from 'react-use/esm/useAsync';
import { useEveresto } from './api';

/**
 * Create a DevOps Space (flower name) in an entity. Suggestions = flowers nobody uses yet; any valid name may be typed.
 * The backend checks everything again (format, reserved, taken, role) — the form only helps.
 */
const NAME = /^[a-z][a-z0-9-]{0,22}[a-z0-9]$/;

export const CreateSpaceDialog = ({ entity, entityTitle, open, onClose, onCreated }: {
  entity: string; entityTitle: string; open: boolean; onClose: () => void; onCreated: () => void;
}) => {
  const api = useEveresto();
  const alertApi = useApi(alertApiRef);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string[] | undefined>();
  const sugg = useAsync(async (): Promise<{ canCreate: boolean; free: string[] }> =>
    (open ? api('GET', `/entities/${encodeURIComponent(entity)}/spaces/suggest`) : { canCreate: false, free: [] }), [open, entity]);

  const free = useMemo(() => sugg.value?.free ?? [], [sugg.value]);
  const shown = useMemo(() => free.slice((page * 12) % Math.max(free.length, 1)).concat(free).slice(0, 12), [free, page]);
  const formatProblem = name && !NAME.test(name) ? 'Use 2–24 characters: lowercase letters, digits and "-", starting with a letter.' : undefined;
  const takenHint = name && NAME.test(name) && free.length > 0 && !free.includes(name) ? 'Not in the suggestions — fine if it is your own name; it is checked when you create.' : undefined;

  const close = () => { setName(''); setDescription(''); setDone(undefined); setPage(0); onClose(); };
  const create = async () => {
    setBusy(true);
    try {
      const r = await api('POST', `/entities/${encodeURIComponent(entity)}/spaces`, { name, description });
      setDone(r.done);
      onCreated();
    } catch (e: any) {
      alertApi.post({ message: `Create space failed: ${e.message}`, severity: 'error' });
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : close} maxWidth="sm" fullWidth>
      <DialogTitle>{done ? 'Space created' : `Create space in ${entityTitle}`}</DialogTitle>
      <DialogContent>
        {done && (
          <>
            <Box component="ul" pl={3} m={0} style={{ lineHeight: 1.8 }}>{done.map(d => <li key={d}>{d}</li>)}</Box>
            <Typography variant="body2" color="textSecondary" style={{ marginTop: 12 }}>
              It appears below within a few seconds. Next: open it → <b>Members</b> to add people, then <b>Create pipeline</b>.
            </Typography>
          </>
        )}
        {!done && sugg.loading && <Box display="flex" alignItems="center" style={{ gap: 8 }}><CircularProgress size={16} /> Loading…</Box>}
        {!done && sugg.error && <Typography style={{ color: '#d03b3b' }}>{sugg.error.message}</Typography>}
        {!done && sugg.value && !sugg.value.canCreate && (
          <Typography variant="body2">Only the owner or a manager of {entityTitle} can create spaces. Ask them, or the platform team.</Typography>
        )}
        {!done && sugg.value?.canCreate && (
          <>
            <TextField fullWidth variant="outlined" margin="dense" label="Space name (a flower)" value={name}
              onChange={e => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              error={!!formatProblem} helperText={formatProblem ?? takenHint ?? (name ? `Shown as “DevOps Space – ${name.split('-').map(w => w[0]?.toUpperCase() + w.slice(1)).join(' ')}”` : 'Pick a suggestion or type your own')} />
            <Box display="flex" flexWrap="wrap" mt={1} style={{ gap: 6 }}>
              {shown.map(f => <Chip key={f} label={f} size="small" color={f === name ? 'primary' : 'default'} onClick={() => setName(f)} />)}
              {free.length > 12 && <Chip label="more…" size="small" variant="outlined" onClick={() => setPage(p => p + 1)} />}
            </Box>
            <TextField fullWidth variant="outlined" margin="dense" label="Description (optional)" value={description}
              onChange={e => setDescription(e.target.value)} inputProps={{ maxLength: 200 }} style={{ marginTop: 16 }} />
            <Typography variant="body2" color="textSecondary" style={{ marginTop: 12 }}>
              Creates the space with its roles (managers, maintainers, developers, viewers) and their GitHub teams.
              Cluster namespaces, ArgoCD and secrets come later, per application.
            </Typography>
          </>
        )}
      </DialogContent>
      <DialogActions>
        {done ? <Button color="primary" onClick={close}>Close</Button> : (
          <>
            <Button onClick={close} disabled={busy}>Cancel</Button>
            <Button color="primary" variant="contained" disableElevation disabled={busy || !sugg.value?.canCreate || !name || !!formatProblem} onClick={create}>
              {busy ? 'Creating…' : 'Create space'}
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
};
