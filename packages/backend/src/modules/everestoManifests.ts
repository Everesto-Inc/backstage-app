/** Pure Kubernetes / ArgoCD / ESO manifests of a deployment (no I/O). */
import { OWNER } from './everestoManage';

export type Env = 'dev' | 'prod';
/** Namespace of an APP per environment: env-first + a short key chosen at Create deployment (dev-python, prod-python). */
export const ns = (nsKey: string, env: Env) => `${env}-${nsKey}`;
export const NS_KEY = /^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$/;
export const RESERVED_NS = ['backstage', 'argocd', 'system', 'platform', 'default', 'livecode', 'folio', 'maas', 'monitoring', 'awx'];
export const err = (status: number, message: string) => Object.assign(new Error(message), { status });
export const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

export type DeploymentInput = {
  secrets: { name: string; value?: string }[];
  config: { name: string; value: string }[];
  port: number;
  memoryMi: number;
  replicas: number;
  healthPath?: string; // e.g. /health → HTTP probes; empty → TCP port check
  publicUrl?: boolean; // dev: ingress <repo>.dev.everesto.live (via alb wildcard → in-cluster Traefik)
  nsKey?: string; // short namespace key → dev-<nsKey> / prod-<nsKey> (default: first word of the app name)
};

// ---------- manifests ----------

export const kustomization = (image: string, tag: string, nsKey: string, env: Env, ingress = false) => `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: ${ns(nsKey, env)}
resources: [namespace.yaml, deployment.yaml, service.yaml, externalsecret.yaml, rolebinding-backstage.yaml${ingress ? ', ingress.yaml' : ''}]
images:
  - name: ${image}
    newTag: ${tag}   # ${env === 'dev' ? 'changed by "Deploy" in Backstage' : 'changed by "Promote to prod" (PR)'} — then Sync in ArgoCD
`;

export const probes = (d: DeploymentInput) => (d.healthPath
  ? `          readinessProbe: { httpGet: { path: ${d.healthPath}, port: ${d.port} }, periodSeconds: 10 }
          livenessProbe: { httpGet: { path: ${d.healthPath}, port: ${d.port} }, initialDelaySeconds: 20, periodSeconds: 20, failureThreshold: 3 }`
  : `          readinessProbe: { tcpSocket: { port: ${d.port} }, periodSeconds: 10 }`);

export const deployment = (repo: string, image: string, project: string, env: Env, d: DeploymentInput) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${repo}
  labels: { app: ${repo}, everesto.live/project: ${project}, everesto.live/env: ${env} }
spec:
  replicas: ${d.replicas}
  selector: { matchLabels: { app: ${repo} } }
  template:
    metadata:
      labels: { app: ${repo}, everesto.live/project: ${project}, everesto.live/env: ${env} }
    spec:
      nodeSelector: { everesto.live/pool: tenants }
      securityContext: { runAsNonRoot: true, seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: app
          image: ${image}
          ports: [{ containerPort: ${d.port} }]${d.config.length ? `
          env:   # config (not secret)
${d.config.map(c => `            - { name: ${c.name}, value: ${JSON.stringify(c.value)} }`).join('\n')}` : ''}
          envFrom:
            - secretRef: { name: ${repo} }   # secrets: Infisical ${repo}-gitops / ${env} (via ESO)
          resources:
            requests: { cpu: 25m, memory: ${Math.max(32, Math.round(d.memoryMi / 2))}Mi }
            limits: { memory: ${d.memoryMi}Mi }
${probes(d)}
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: [ALL] } }
`;

// own manifest (not only CreateNamespace=true): ArgoCD skips CreateNamespace on partial syncs
export const namespace = (project: string, nsKey: string, env: Env) => `apiVersion: v1
kind: Namespace
metadata:
  name: ${ns(nsKey, env)}
  labels: { everesto.live/project: ${project}, everesto.live/env: ${env} }
  annotations:
    # never deleted by ArgoCD (safety): remove it by hand after Delete deployment if it is empty
    argocd.argoproj.io/sync-options: Delete=false
`;

// Backstage may READ this app's namespace (Kubernetes tab) — ClusterRole backstage-read bound HERE only
export const roleBinding = (repo: string) => `apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: backstage-read-${repo}
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: backstage-read }
subjects:
  - { kind: ServiceAccount, name: backstage, namespace: prod-backstage }
`;

/** dev URL: https://<repo>.dev.everesto.live (app names are unique in the org → one wildcard cert covers all). */
export const devHost = (repo: string) => `${repo}.dev.everesto.live`;
export const ingress = (repo: string) => `# https://${devHost(repo)} — alb (TLS *.dev.everesto.live) → in-cluster Traefik → this Ingress → Service ${repo}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${repo}
spec:
  ingressClassName: traefik
  rules:
    - host: ${devHost(repo)}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend: { service: { name: ${repo}, port: { number: 80 } } }
`;

export const service = (repo: string, port: number) => `apiVersion: v1
kind: Service
metadata:
  name: ${repo}
spec:
  selector: { app: ${repo} }
  ports: [{ port: 80, targetPort: ${port} }]
`;

export const externalSecret = (repo: string, _project: string, env: Env) => `# All secrets of Infisical project "${repo}-gitops", env ${env} → Secret "${repo}"
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: ${repo}
spec:
  refreshInterval: 5m
  secretStoreRef: { kind: ClusterSecretStore, name: infisical-${repo}-${env} }
  target: { name: ${repo} }
  dataFrom:
    - find: { name: { regexp: ".*" } }
`;

export const appProject = (project: string, namespaces: string[]) => `apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: ${project}
  namespace: argocd
spec:
  description: DevOps space ${project}
  sourceRepos:
    - https://github.com/${OWNER}/*-gitops.git
  destinations:   # exactly the namespaces of this space's apps (dev-<key> / prod-<key>)
${[...new Set(namespaces)].sort().map(n => `    - { server: https://kubernetes.default.svc, namespace: ${n} }`).join('\n')}
  clusterResourceWhitelist:
    - { group: '', kind: Namespace }
  namespaceResourceWhitelist:
    - { group: '*', kind: '*' }
`;

export const application = (repo: string, project: string, env: Env, nsKey: string) => `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ${env}-${repo}
  namespace: argocd
  labels: { everesto.live/project: ${project}, everesto.live/env: ${env} }
  finalizers: [resources-finalizer.argocd.argoproj.io]   # deleting the app removes its pods too
spec:
  project: ${project}
  source:
    repoURL: https://github.com/${OWNER}/${repo}-gitops.git
    targetRevision: main
    path: apps/${env}
  destination: { server: https://kubernetes.default.svc, namespace: ${ns(nsKey, env)} }
  syncPolicy:
    # MANUAL sync: after "Deploy" / "Promote" click Sync in ArgoCD
    syncOptions: [CreateNamespace=true]
`;

export const secretStore = (repo: string, _project: string, env: Env, projectSlug: string, url: string, nsKey: string) => `apiVersion: external-secrets.io/v1
kind: ClusterSecretStore
metadata:
  name: infisical-${repo}-${env}
spec:
  conditions:
    - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: ${ns(nsKey, env)} } }
  provider:
    infisical:
      hostAPI: ${url}
      auth:
        universalAuthCredentials:
          clientId: { name: infisical-${repo}-auth, namespace: external-secrets, key: clientId }
          clientSecret: { name: infisical-${repo}-auth, namespace: external-secrets, key: clientSecret }
      secretsScope: { projectSlug: ${projectSlug}, environmentSlug: ${env}, secretsPath: / }
`;

export const header = (file: string, gitops: string, extra = '') =>
  `# Apply on the control plane (Backstage has no cluster access):\n#   sudo kubectl apply -f https://raw.githubusercontent.com/${OWNER}/${gitops}/main/argocd/${file}\n${extra}`;

