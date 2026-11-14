import { Entity } from '@backstage/catalog-model';

/**
 * DevOps tools an application (Component) can be connected to.
 *
 * State of a tool for one application:
 *   missing    → annotation absent                → [Add]
 *   connected  → annotation present, tool answers → green
 *   error      → annotation present, tool fails   → red (e.g. SonarQube down, token revoked)
 * [Remove] (un-provision + PR removing the annotation) is shown to space owners only.
 *
 * DUMMY: "error" is simulated with the annotation
 *   everesto.live/dummy-tool-errors: "<toolId>=<reason>;<toolId>=<reason>"
 * Later each tool's backend check decides it. Tab data is fake — layout preview only.
 */
export type Tool = {
  id: string;
  name: string;
  /** Own tab on the application page; omitted → results appear in the shared "Security" tab */
  tab?: string;
  /** Entity page tab group */
  group: 'development' | 'security' | 'deployment' | 'observability';
  annotation: string;
  description: string;
  templateRef: string;
  docsPath: string;
  /** key in LOGOS (logos.ts); missing → icon from ToolLogo */
  logo?: string;
  /** Where the tool sits: CI pipeline (app repo) or CD pipeline (gitops / AWX) */
  stage: 'ci' | 'cd';
  /**
   * What it needs before a pipeline can use it:
   *   none     → CLI step / repo config only (no server, no token) — just tick it in Edit
   *   platform → shared tool, connected once by platform admins
   *   project  → tenant-licensed tool, connected by the project owner (Connections tab)
   */
  connection: 'none' | 'platform' | 'project';
  /** free / open source, or enterprise licence */
  licence: 'free' | 'enterprise';
};

export type ToolState =
  | { kind: 'missing' }
  | { kind: 'connected'; value: string }
  | { kind: 'error'; value: string; reason: string };

const t = (x: Tool) => x;

/** Pipeline order: the chain on each pipeline card follows this order. */
export const TOOLS: Tool[] = [
  // ── CI ──────────────────────────────────────────────────────────────────
  t({ id: 'code', stage: 'ci', name: 'GitHub', tab: 'Code', group: 'development', logo: 'github',
    connection: 'platform', licence: 'free', annotation: 'github.com/project-slug',
    description: 'Repository in Everesto-Inc, branch protection, team access per role',
    templateRef: 'template:default/add-github-repo', docsPath: 'docs/repository.md' }),
  t({ id: 'ci', stage: 'ci', name: 'GitHub Actions', tab: 'CI', group: 'development', logo: 'githubactions',
    connection: 'platform', licence: 'free', annotation: 'everesto.live/ci-workflow',
    description: 'Runs the pipeline: build, test, scans, image',
    templateRef: 'template:default/add-github-actions', docsPath: 'docs/ci.md' }),
  t({ id: 'secrets-scan', stage: 'ci', name: 'Gitleaks', group: 'security',
    connection: 'none', licence: 'free', annotation: 'everesto.live/gitleaks',
    description: 'Blocks committed passwords, keys and tokens',
    templateRef: 'template:default/add-gitleaks', docsPath: 'docs/gitleaks.md' }),
  t({ id: 'semgrep', stage: 'ci', name: 'Semgrep', group: 'security',
    connection: 'none', licence: 'free', annotation: 'everesto.live/semgrep',
    description: 'Code security (SAST): injection, XSS, unsafe crypto',
    templateRef: 'template:default/add-semgrep', docsPath: 'docs/semgrep.md' }),
  t({ id: 'trivy', stage: 'ci', name: 'Trivy', group: 'security', logo: 'trivy',
    connection: 'none', licence: 'free', annotation: 'everesto.live/trivy',
    description: 'Vulnerable dependencies + image CVEs, with fix versions',
    templateRef: 'template:default/add-trivy', docsPath: 'docs/trivy.md' }),
  t({ id: 'quality', stage: 'ci', name: 'SonarQube', tab: 'Quality', group: 'development', logo: 'sonarqubeserver',
    connection: 'platform', licence: 'free', annotation: 'sonarqube.org/project-key',
    description: 'Quality gate: coverage, new issues — also collects Semgrep/Trivy/Gitleaks results',
    templateRef: 'template:default/add-sonarqube', docsPath: 'docs/sonarqube.md' }),
  t({ id: 'sast', stage: 'ci', name: 'Fortify', group: 'security',
    connection: 'project', licence: 'enterprise', annotation: 'everesto.live/fortify-application',
    description: 'Enterprise SAST — needs your Fortify licence',
    templateRef: 'template:default/add-fortify', docsPath: 'docs/fortify.md' }),
  t({ id: 'deps', stage: 'ci', name: 'Nexus IQ', group: 'security', logo: 'sonatype',
    connection: 'project', licence: 'enterprise', annotation: 'everesto.live/nexus-iq-application',
    description: 'Enterprise dependency policy (CVEs + licences) — needs your Nexus IQ',
    templateRef: 'template:default/add-nexus-iq', docsPath: 'docs/nexus-iq.md' }),
  t({ id: 'registry', stage: 'ci', name: 'Image · ghcr.io', tab: 'Image', group: 'development', logo: 'docker',
    connection: 'platform', licence: 'free', annotation: 'everesto.live/image',
    description: 'Builds the ARM container image (Dockerfile) and pushes it to GitHub Container Registry (ghcr.io)',
    templateRef: 'template:default/add-image', docsPath: 'docs/image.md' }),
  t({ id: 'dependabot', stage: 'ci', name: 'Dependabot', group: 'security', logo: 'dependabot',
    connection: 'none', licence: 'free', annotation: 'everesto.live/dependabot',
    description: 'Opens upgrade PRs for vulnerable dependencies automatically',
    templateRef: 'template:default/add-dependabot', docsPath: 'docs/dependabot.md' }),
  // ── CD ──────────────────────────────────────────────────────────────────
  t({ id: 'cd', stage: 'cd', name: 'ArgoCD', tab: 'CD', group: 'deployment', logo: 'argo',
    connection: 'platform', licence: 'free', annotation: 'argocd/app-name',
    description: "Deploys the project's gitops-cd folder for this app to K3s",
    templateRef: 'template:default/add-argocd', docsPath: 'docs/argocd.md' }),
  t({ id: 'config', stage: 'cd', name: 'Ansible', tab: 'Config', group: 'deployment', logo: 'ansible',
    connection: 'project', licence: 'free', annotation: 'everesto.live/awx-job-template',
    description: 'Deploys / configures VMs via AWX job templates',
    templateRef: 'template:default/add-ansible', docsPath: 'docs/ansible.md' }),
  t({ id: 'secrets', stage: 'cd', name: 'Infisical', tab: 'Secrets', group: 'deployment',
    connection: 'platform', licence: 'free', annotation: 'infisical.com/secret-path',
    description: 'App secrets → ESO → Kubernetes Secret (values never shown here)',
    templateRef: 'template:default/add-infisical', docsPath: 'docs/secrets.md' }),
  t({ id: 'monitoring', stage: 'cd', name: 'Grafana', tab: 'Monitoring', group: 'observability', logo: 'grafana',
    connection: 'platform', licence: 'free', annotation: 'grafana/dashboard-selector',
    description: 'Dashboards and alerts (Prometheus + Loki)',
    templateRef: 'template:default/add-grafana', docsPath: 'docs/monitoring.md' }),
];

/** Scanners whose findings feed the Vulnerabilities / Secrets views. */
export const SECURITY_TOOL_IDS = ['secrets-scan', 'semgrep', 'trivy', 'sast', 'deps', 'dependabot'];

const DUMMY_ERRORS = 'everesto.live/dummy-tool-errors';

const dummyErrors = (entity: Entity): Record<string, string> =>
  Object.fromEntries(
    (entity.metadata.annotations?.[DUMMY_ERRORS] ?? '')
      .split(';')
      .map(p => p.split('=').map(s => s.trim()))
      .filter(([id]) => id)
      .map(([id, reason]) => [id, reason || 'tool not reachable']),
  );

export const toolState = (entity: Entity, tool: Tool): ToolState => {
  const value = entity.metadata.annotations?.[tool.annotation];
  if (!value) return { kind: 'missing' };
  const reason = dummyErrors(entity)[tool.id];
  return reason ? { kind: 'error', value, reason } : { kind: 'connected', value };
};

/**
 * Who may remove a tool: owners of the application's space (<system>-owners)
 * and platform admins. Mirrors the space roles in CLAUDE.md (owner ⊃ maintainer ⊃ developer).
 */
export const canRemoveTools = (entity: Entity, ownershipRefs: string[]) => {
  const system = (entity.spec?.system as string | undefined) ?? '';
  return (
    ownershipRefs.includes('group:default/platform-team') ||
    (system !== '' && ownershipRefs.includes(`group:default/${system}-owners`))
  );
};

export const CI_TOOLS = TOOLS.filter(t => t.stage === 'ci');
export const CD_TOOLS = TOOLS.filter(t => t.stage === 'cd');
