import { useEffect, useState } from 'react';
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
  TextField,
  Typography,
  makeStyles,
  useTheme,
} from '@material-ui/core';
import FolderIcon from '@material-ui/icons/Folder';
import { LOGOS } from '../tools/logos';
import { CI_TOOLS } from '../tools/tools';
import { ToolLogo } from '../tools/ToolLogo';

/**
 * "Create pipeline" wizard: pick name, stack and tools (CI only — CD is “Create deployment”), then
 * "Continue" opens template:default/create-pipeline pre-filled (review → Create).
 * Supported today: Python, Java, React. Others are marked "coming soon".
 */

type Stack = { id: string; name: string; hint: string; logo?: string; build: string; soon?: boolean; details?: string[] };
// CI stacks — each maps to a skeleton + CI workflow in the template
export const STACKS: Stack[] = [
  { id: 'java', name: 'Java', hint: 'Spring Boot · Maven', logo: 'openjdk', build: 'mvn verify', details: [
    'Java 21 · Spring Boot 4.1 (Web) · Maven',
    'Starter service: GET / and GET /health on port 8080',
    'Tests: JUnit (spring-boot-starter-test) + JaCoCo coverage for SonarQube',
    'Image: eclipse-temurin 21 JRE, linux/arm64',
    'Dependabot: Maven, Docker base image (patches only), GitHub Actions',
  ] },
  { id: 'python', name: 'Python', hint: 'FastAPI · pytest', logo: 'python', build: 'pytest', details: [
    'Python 3.12 · FastAPI + Uvicorn',
    'Starter service: GET / and GET /health on port 8080',
    'Tests: pytest + pytest-cov + httpx, coverage for SonarQube',
    'Image: python:3.12-slim, linux/arm64',
    'Dependabot: pip, Docker base image (patches only), GitHub Actions',
  ] },
  { soon: true, id: 'go', name: 'Go', hint: 'net/http · go test', logo: 'go', build: 'go test ./...' },
  { soon: true, id: 'rust', name: 'Rust', hint: 'axum · cargo test', logo: 'rust', build: 'cargo test' },
  { soon: true, id: 'node', name: 'Node.js', hint: 'TypeScript · Express', logo: 'nodedotjs', build: 'npm test' },
  { id: 'react', name: 'React', hint: 'web app · Vite · TypeScript', logo: 'react', build: 'npm test + build', details: [
    'React 19 · TypeScript 5 · Vite — a single-page web app (no server rendering)',
    'Tailwind CSS 4 + the board design system: lists, cards, labels; light + dark; phone, tablet and desktop',
    'TanStack Query (data) · react-router (one lazy chunk per screen) · openapi-fetch (typed client from a backend\'s OpenAPI spec)',
    'Starter: one demo board screen + a card that checks whether API_URL answers — a starting point, not an app',
    'Tests: Vitest + Testing Library with coverage for SonarQube; CI fails if the first page grows past 130 KB',
    'Served by nginx-unprivileged 1.27 (static files, ≈ 10 MiB RAM) on port 8080 · /healthz · security headers (CSP)',
    'API_URL is set per environment at runtime (same image everywhere) — a web app holds no secrets',
    'Dependabot: npm, Docker base image (patches only), GitHub Actions',
  ] },
  { soon: true, id: 'dotnet', name: '.NET', hint: 'ASP.NET Core', logo: 'dotnet', build: 'dotnet test' },
  { id: 'repo', name: 'Repository only', hint: 'no CI — scripts, storage, docs', build: '', details: [
    'README + .gitignore only — no pipeline, no image, nothing to deploy',
    'For scripts, configuration, storage or docs; changes to main go through pull requests',
  ] },
];

type Cd = { id: string; name: string; hint: string; logo?: string; soon?: boolean };
export const CD_OPTIONS: Cd[] = [
  { id: 'argocd', name: 'ArgoCD (GitOps)', hint: 'container → K3s namespace, via <app>-gitops (Create deployment)', logo: 'argo' },
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
  details: { marginTop: theme.spacing(1.5), padding: theme.spacing(1.5, 2), borderRadius: 12, border: `1px solid ${theme.palette.divider}`, background: theme.palette.action.hover, fontSize: 13, lineHeight: 1.7 },
  step: { fontSize: 12, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: theme.palette.text.secondary, margin: theme.spacing(3, 0, 1) },
}));

const Mark = ({ slug, size = 32, fallback }: { slug?: string; size?: number; fallback: JSX.Element }) => {
  const theme = useTheme();
  const logo = slug ? LOGOS[slug] : undefined;
  const dark = theme.palette.type === 'dark';
  const lum = logo ? (() => { const [r, g, b] = [1, 3, 5].map(i => Number.parseInt(logo.hex.slice(i, i + 2), 16) / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b; })() : 1;
  let ink = theme.palette.text.secondary;
  if (logo) ink = dark && lum < 0.2 ? theme.palette.text.primary : logo.hex;
  return (
    <span style={{ width: size, height: size, borderRadius: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, background: `${logo && !(dark && lum < 0.2) ? logo.hex : '#888888'}1f` }}>
      {logo ? <svg viewBox="0 0 24 24" width={size * 0.55} height={size * 0.55} aria-hidden><path d={logo.path} fill={ink} /></svg> : fallback}
    </span>
  );
};

// Free pipeline tools ticked by default; enterprise / project tools opt-in
const DEFAULT_ON = ['code', 'ci', 'secrets-scan', 'semgrep', 'trivy', 'quality', 'registry', 'dependabot'];

// Always on (Loop guard + image scan + push) — shown ticked and locked
const MANDATORY = ['secrets-scan', 'trivy', 'registry'];

// Wizard tool id → template tool id (template:default/create-pipeline). Others: coming soon.
const TEMPLATE_TOOL: Record<string, string> = {
  'secrets-scan': 'gitleaks',
  semgrep: 'semgrep',
  trivy: 'trivy',
  quality: 'sonarqube',
  dependabot: 'dependabot',
};

export const CreatePipelineDialog = ({ project, open, onClose, initialStack = 'python' }: { project: string; open: boolean; onClose: () => void; initialStack?: string }) => {
  const classes = useStyles();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [stack, setStack] = useState(initialStack);
  useEffect(() => { if (open) setStack(initialStack); }, [open, initialStack]);
  const [tools, setTools] = useState<string[]>(DEFAULT_ON);
  const repoOnly = stack === 'repo';
  const s = STACKS.find(x => x.id === stack)!;
  const suggested = `${stack}-${stack === 'react' ? 'frontend' : 'backend'}`;
  const app = name || suggested; // repo = name, unique in the org (no project prefix)
  const valid = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name || 'x') && app.length <= 63;
  const ciTools = CI_TOOLS.filter(t => t.id !== 'code' && t.id !== 'ci');

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Create pipeline in {project}</DialogTitle>
      <DialogContent>
        <div className={classes.step} style={{ marginTop: 0 }}>1 · Name</div>
        <TextField
          fullWidth variant="outlined" size="small" value={name} placeholder={suggested}
          onChange={e => setName(e.target.value.toLowerCase())}
          error={!valid}
          helperText={valid ? `Repository: Everesto-Inc/${app}` : 'lowercase a-z 0-9 -, max 63 characters in total'}
        />

        <div className={classes.step}>2 · Application (CI)</div>
        <div className={classes.grid}>
          {STACKS.map(x => (
            <button key={x.id} type="button" disabled={x.soon} title={x.details?.join('\n')} style={x.soon ? { opacity: 0.45, cursor: 'not-allowed' } : undefined} className={`${classes.option} ${stack === x.id ? classes.selected : ''}`} onClick={() => { setStack(x.id); }}>
              <Mark slug={x.logo} fallback={<FolderIcon style={{ fontSize: 18 }} />} />
              <span><div className={classes.label}>{x.name}</div><div className={classes.hint}>{x.soon ? 'coming soon' : x.hint}</div></span>
            </button>
          ))}
        </div>

        {s.details && (
          <Box className={classes.details} aria-live="polite">
            <div className={classes.label}>{s.name} — what you get</div>
            <Box component="ul" m={0} mt={0.5} pl={2.5}>
              {s.details.map(d => <li key={d}>{d}</li>)}
              {!repoOnly && <li>Every stack: Loop CI (tests → Gitleaks → Semgrep and SonarQube if switched on below → image build + Trivy → ghcr.io, linux/arm64), catalog entry, Tech Docs; deployment later with “Create deployment”</li>}
            </Box>
          </Box>
        )}

        {!repoOnly && (
          <>
            <div className={classes.step}>3 · Pipeline tools</div>
            <Box display="flex" flexWrap="wrap" style={{ gap: '4px 24px' }}>
              {ciTools.map(t => (
                <FormControlLabel
                  key={t.id}
                  disabled={MANDATORY.includes(t.id) || !(t.id in TEMPLATE_TOOL)}
                  control={<Checkbox color="primary" size="small" checked={MANDATORY.includes(t.id) || (tools.includes(t.id) && t.id in TEMPLATE_TOOL)} onChange={e => setTools(e.target.checked ? [...tools, t.id] : tools.filter(x => x !== t.id))} />}
                  label={<Box display="flex" alignItems="center" style={{ gap: 8 }}><ToolLogo tool={t} size={24} />{t.name}{MANDATORY.includes(t.id) && <Typography variant="caption" color="textSecondary">always on</Typography>}{t.licence === 'enterprise' && <Typography variant="caption" color="textSecondary">enterprise · needs connection</Typography>}</Box>}
                />
              ))}
            </Box>
          </>
        )}

        <div className={classes.step}>What will be created (preview)</div>
        <Box component="ol" pl={3} m={0} style={{ lineHeight: 1.9, fontSize: 14 }}>
          <li>repo <b>Everesto-Inc/{app}</b> from the <b>{s.name}</b> skeleton{repoOnly ? ' (README only)' : `, CI workflow: ${s.build} → ${tools.filter(x => ciTools.some(t => t.id === x)).map(x => CI_TOOLS.find(t => t.id === x)!.name).join(' → ')}`}</li>
          <li>registered here as a CI pipeline of <b>{project}</b> — deployment (CD) is added later by a maintainer: “Create deployment”</li>
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
          disabled={!name || !valid || s.soon}
          onClick={() => {
            const formData = {
              project: `system:default/${project}`,
              name,
              stack: stack === 'repo' ? 'repository' : stack,
              description: '',
              visibility: 'public',
              // true/false switches of the template (Gitleaks + Trivy always run in the Loop guard)
              sonarqube: !repoOnly && tools.includes('quality'),
              semgrep: !repoOnly && tools.includes('semgrep'),
              dependabot: !repoOnly && tools.includes('dependabot'),
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
