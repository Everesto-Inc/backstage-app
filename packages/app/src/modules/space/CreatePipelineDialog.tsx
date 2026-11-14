import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  InputAdornment,
  TextField,
  Typography,
  makeStyles,
  useTheme,
} from '@material-ui/core';
import FolderIcon from '@material-ui/icons/Folder';
import BlockIcon from '@material-ui/icons/Block';
import { LOGOS } from '../tools/logos';
import { CI_TOOLS } from '../tools/tools';
import { ToolLogo } from '../tools/ToolLogo';

/**
 * "Create pipeline" wizard: pick name, stack (CI), deployment (CD) and tools, then
 * "Continue" opens template:default/create-pipeline pre-filled (review → Create).
 * Supported today: Python, Java · ArgoCD / no deployment. Others are marked "coming soon".
 */

type Stack = { id: string; name: string; hint: string; logo?: string; build: string; soon?: boolean };
// CI stacks — each maps to a skeleton + CI workflow in the template
export const STACKS: Stack[] = [
  { id: 'java', name: 'Java', hint: 'Spring Boot · Maven/Gradle', logo: 'openjdk', build: 'mvn verify' },
  { id: 'python', name: 'Python', hint: 'FastAPI · pytest', logo: 'python', build: 'pytest' },
  { soon: true, id: 'go', name: 'Go', hint: 'net/http · go test', logo: 'go', build: 'go test ./...' },
  { soon: true, id: 'rust', name: 'Rust', hint: 'axum · cargo test', logo: 'rust', build: 'cargo test' },
  { soon: true, id: 'node', name: 'Node.js', hint: 'TypeScript · Express', logo: 'nodedotjs', build: 'npm test' },
  { soon: true, id: 'react', name: 'React', hint: 'frontend · Vite', logo: 'react', build: 'npm run build' },
  { soon: true, id: 'dotnet', name: '.NET', hint: 'ASP.NET Core', logo: 'dotnet', build: 'dotnet test' },
  { soon: true, id: 'repo', name: 'Repository only', hint: 'no CI — scripts, storage', build: '' },
];

type Cd = { id: string; name: string; hint: string; logo?: string; soon?: boolean };
export const CD_OPTIONS: Cd[] = [
  { id: 'argocd', name: 'ArgoCD (GitOps)', hint: 'container → K3s namespace, folder in <project>-gitops-cd', logo: 'argo' },
  { soon: true, id: 'ansible', name: 'Ansible (AWX)', hint: 'deploy to VMs via an AWX job template', logo: 'ansible' },
  { id: 'none', name: 'No deployment', hint: 'build only (library, tool, storage)' },
];

const useStyles = makeStyles(theme => ({
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: theme.spacing(1.5) },
  option: {
    display: 'flex', alignItems: 'center', gap: theme.spacing(1.5), padding: theme.spacing(1.5),
    border: `1px solid ${theme.palette.divider}`, borderRadius: 12, cursor: 'pointer', background: 'none',
    textAlign: 'left', font: 'inherit', color: 'inherit', width: '100%',
    '&:hover': { borderColor: theme.palette.primary.main },
  },
  selected: { borderColor: theme.palette.primary.main, boxShadow: `0 0 0 1px ${theme.palette.primary.main}` },
  label: { fontWeight: 650, fontSize: 14 },
  hint: { fontSize: 12, color: theme.palette.text.secondary },
  step: { fontSize: 12, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: theme.palette.text.secondary, margin: theme.spacing(3, 0, 1) },
}));

const Mark = ({ slug, size = 32, fallback }: { slug?: string; size?: number; fallback: JSX.Element }) => {
  const theme = useTheme();
  const logo = slug ? LOGOS[slug] : undefined;
  const dark = theme.palette.type === 'dark';
  const lum = logo ? (() => { const [r, g, b] = [1, 3, 5].map(i => parseInt(logo.hex.slice(i, i + 2), 16) / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b; })() : 1;
  const ink = logo ? (dark && lum < 0.2 ? theme.palette.text.primary : logo.hex) : theme.palette.text.secondary;
  return (
    <span style={{ width: size, height: size, borderRadius: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, background: `${logo && !(dark && lum < 0.2) ? logo.hex : '#888888'}1f` }}>
      {logo ? <svg viewBox="0 0 24 24" width={size * 0.55} height={size * 0.55} aria-hidden><path d={logo.path} fill={ink} /></svg> : fallback}
    </span>
  );
};

// Free pipeline tools ticked by default; enterprise / project tools opt-in
const DEFAULT_ON = ['code', 'ci', 'secrets-scan', 'semgrep', 'trivy', 'quality', 'registry', 'dependabot'];

// Wizard tool id → template tool id (template:default/create-pipeline). Others: coming soon.
const TEMPLATE_TOOL: Record<string, string> = {
  'secrets-scan': 'gitleaks',
  semgrep: 'semgrep',
  trivy: 'trivy',
  quality: 'sonarqube',
  dependabot: 'dependabot',
};

export const CreatePipelineDialog = ({ project, open, onClose }: { project: string; open: boolean; onClose: () => void }) => {
  const classes = useStyles();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [stack, setStack] = useState('python');
  const [cd, setCd] = useState('argocd');
  const [tools, setTools] = useState<string[]>(DEFAULT_ON);
  const repoOnly = stack === 'repo';
  const s = STACKS.find(x => x.id === stack)!;
  const app = `${project}-${name || `${stack}-backend`}`;
  const valid = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name || 'x') && app.length <= 63;
  const ciTools = CI_TOOLS.filter(t => t.id !== 'code' && t.id !== 'ci');

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Create pipeline in {project}</DialogTitle>
      <DialogContent>
        <div className={classes.step} style={{ marginTop: 0 }}>1 · Name</div>
        <TextField
          fullWidth variant="outlined" size="small" value={name} placeholder={`${stack}-backend`}
          onChange={e => setName(e.target.value.toLowerCase())}
          error={!valid}
          helperText={valid ? `Repository: Everesto-Inc/${app}` : 'lowercase a-z 0-9 -, max 63 characters in total'}
          InputProps={{ startAdornment: <InputAdornment position="start">{project}-</InputAdornment> }}
        />

        <div className={classes.step}>2 · Application (CI)</div>
        <div className={classes.grid}>
          {STACKS.map(x => (
            <button key={x.id} type="button" disabled={x.soon} style={x.soon ? { opacity: 0.45, cursor: 'not-allowed' } : undefined} className={`${classes.option} ${stack === x.id ? classes.selected : ''}`} onClick={() => { setStack(x.id); if (x.id === 'repo') setCd('none'); }}>
              <Mark slug={x.logo} fallback={<FolderIcon style={{ fontSize: 18 }} />} />
              <span><div className={classes.label}>{x.name}</div><div className={classes.hint}>{x.soon ? 'coming soon' : x.hint}</div></span>
            </button>
          ))}
        </div>

        <div className={classes.step}>3 · Deployment (CD)</div>
        <div className={classes.grid}>
          {CD_OPTIONS.map(x => (
            <button key={x.id} type="button" disabled={x.soon} style={x.soon ? { opacity: 0.45, cursor: 'not-allowed' } : undefined} className={`${classes.option} ${cd === x.id ? classes.selected : ''}`} onClick={() => setCd(x.id)}>
              <Mark slug={x.logo} fallback={<BlockIcon style={{ fontSize: 18 }} />} />
              <span><div className={classes.label}>{x.name}</div><div className={classes.hint}>{x.soon ? 'coming soon' : x.hint.replace('<project>', project)}</div></span>
            </button>
          ))}
        </div>

        {!repoOnly && (
          <>
            <div className={classes.step}>4 · Pipeline tools</div>
            <Box display="flex" flexWrap="wrap" style={{ gap: '4px 24px' }}>
              {ciTools.map(t => (
                <FormControlLabel
                  key={t.id}
                  disabled={!(t.id in TEMPLATE_TOOL) && t.id !== 'registry'}
                  control={<Checkbox color="primary" size="small" checked={tools.includes(t.id) && (t.id in TEMPLATE_TOOL || t.id === 'registry')} onChange={e => setTools(e.target.checked ? [...tools, t.id] : tools.filter(x => x !== t.id))} />}
                  label={<Box display="flex" alignItems="center" style={{ gap: 8 }}><ToolLogo tool={t} size={24} />{t.name}{t.licence === 'enterprise' && <Typography variant="caption" color="textSecondary">enterprise · needs connection</Typography>}</Box>}
                />
              ))}
            </Box>
          </>
        )}

        <div className={classes.step}>What will be created (preview)</div>
        <Box component="ol" pl={3} m={0} style={{ lineHeight: 1.9, fontSize: 14 }}>
          <li>repo <b>Everesto-Inc/{app}</b> from the <b>{s.name}</b> skeleton{repoOnly ? ' (README only)' : `, CI workflow: ${s.build} → ${tools.filter(x => ciTools.some(t => t.id === x)).map(x => CI_TOOLS.find(t => t.id === x)!.name).join(' → ')}`}</li>
          {cd === 'argocd' && <li>folder <b>{name || `${stack}-backend`}/</b> in <b>{project}-gitops-cd</b> (Deployment, Service, ExternalSecret) → ArgoCD syncs to namespace <b>{project}</b></li>}
          {cd === 'ansible' && <li>AWX job template <b>{app}-deploy</b> + playbook in the repo (<code>deploy/</code>) → deploys to VMs</li>}
          <li>registered here: a CI pipeline{cd !== 'none' ? ' and a CD pipeline' : ''}, owned by <b>{project}</b></li>
          {tools.includes('quality') && !repoOnly && <li>SonarQube project <b>{app}</b> + its token stored in Infisical</li>}
        </Box>
      </DialogContent>
      <DialogActions>
        <Typography variant="caption" color="textSecondary" style={{ marginRight: 'auto', paddingLeft: 16 }}>
          Next: review in the template form, then Create
        </Typography>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          color="primary"
          disableElevation
          disabled={!name || !valid || s.soon || CD_OPTIONS.find(x => x.id === cd)!.soon}
          onClick={() => {
            const formData = {
              project: `system:default/${project}`,
              name,
              stack,
              description: '',
              cd,
              tools: tools.filter(t => t in TEMPLATE_TOOL).map(t => TEMPLATE_TOOL[t]),
            };
            navigate(`/create/templates/default/create-pipeline?formData=${encodeURIComponent(JSON.stringify(formData))}`);
          }}
        >
          Continue
        </Button>
      </DialogActions>
    </Dialog>
  );
};
