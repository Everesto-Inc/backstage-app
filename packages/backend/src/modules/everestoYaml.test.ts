import { appNamespaces, component, groupMembers, infisicalStore, kustomizeTag, setAnnotation, setGroupMembers, setKustomizeTag } from './everestoYaml';

const space = `# SPACE "orchid" — hand-written comment that must survive
---
apiVersion: backstage.io/v1alpha1
kind: System
metadata:
  name: orchid
spec:
  owner: orchid
---
# manager: comment above the group
apiVersion: backstage.io/v1alpha1
kind: Group
metadata:
  name: orchid-managers
  labels: { everesto.live/level: space, everesto.live/role: manager }
spec:
  type: role
  parent: orchid
  children: []
  members: [adminbob575]   # trailing comment
---
apiVersion: backstage.io/v1alpha1
kind: Group
metadata:
  name: orchid-developers
spec:
  type: role
  parent: orchid
  children: []
`;

describe('everestoYaml', () => {
  it('reads group members', () => {
    expect(groupMembers(space, 'orchid-managers')).toEqual(['adminbob575']);
    expect(groupMembers(space, 'orchid-developers')).toEqual([]);
  });

  it('edits ONE group, every other document byte-for-byte unchanged', () => {
    const out = setGroupMembers(space, 'orchid-managers', m => [...m, 'babu']);
    expect(groupMembers(out, 'orchid-managers')).toEqual(['adminbob575', 'babu']);
    const before = space.split('\n---\n');
    const after = out.split('\n---\n');
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[3]).toBe(before[3]);
    expect(after[2]).toContain('# manager: comment above the group');
    expect(after[2]).toContain('members: [adminbob575, babu]');
  });

  it('adds members where there was no list, removes again', () => {
    const added = setGroupMembers(space, 'orchid-developers', m => [...m, 'nanu']);
    expect(groupMembers(added, 'orchid-developers')).toEqual(['nanu']);
    expect(groupMembers(setGroupMembers(added, 'orchid-developers', m => m.filter(x => x !== 'nanu')), 'orchid-developers')).toEqual([]);
  });

  it('a lookalike in a comment or another kind is not matched', () => {
    const tricky = `# kind: Group\n#   name: orchid-managers\n${space}`;
    expect(groupMembers(tricky, 'orchid-managers')).toEqual(['adminbob575']);
    expect(() => setGroupMembers(space, 'orchid', m => m)).toThrow(/not found/);
  });

  const catalog = `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: python-backend
  annotations:
    everesto.live/image: ghcr.io/everesto-inc/python-backend
spec:
  type: service
  system: orchid
---
apiVersion: backstage.io/v1alpha1
kind: Resource
metadata:
  name: python-backend-gitops
spec:
  type: gitops
  system: lily
`;

  it("the app's space comes from its Component, never from another document", () => {
    expect(component(catalog)?.system).toBe('orchid');
    expect(component(catalog.split('---\n').reverse().join('---\n'))?.system).toBe('orchid');
  });

  it('annotations: add / remove on the Component only', () => {
    const on = setAnnotation(catalog, 'Component', undefined, 'sonarqube.org/project-key', 'python-backend');
    expect(component(on)?.annotations['sonarqube.org/project-key']).toBe('python-backend');
    expect(on.split('\n---\n')[1]).toBe(catalog.split('\n---\n')[1]);
    const off = setAnnotation(on, 'Component', undefined, 'sonarqube.org/project-key', undefined);
    expect(component(off)?.annotations['sonarqube.org/project-key']).toBeUndefined();
  });

  it('kustomization tag read + write', () => {
    const k = 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nnamespace: dev-python\nimages:\n  - name: app\n    newName: ghcr.io/x\n    newTag: sha-1111111\n';
    expect(kustomizeTag(k)).toBe('sha-1111111');
    const k2 = setKustomizeTag(k, 'sha-2222222');
    expect(kustomizeTag(k2)).toBe('sha-2222222');
    expect(k2.replace('sha-2222222', 'sha-1111111')).toBe(k);
  });

  it('secret store + application namespaces', () => {
    const t = `apiVersion: external-secrets.io/v1
kind: ClusterSecretStore
metadata: { name: infisical-python-backend-dev }
spec:
  provider:
    infisical:
      hostAPI: https://infisical.everesto.live
      secretsScope: { projectSlug: python-backend-gitops-xv-fo, environmentSlug: dev, secretsPath: / }
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata: { name: dev-python-backend }
spec:
  destination: { server: https://kubernetes.default.svc, namespace: dev-python }
`;
    expect(infisicalStore(t)).toEqual({ slug: 'python-backend-gitops-xv-fo', url: 'https://infisical.everesto.live' });
    expect(appNamespaces(t)).toEqual(['dev-python']);
  });
});
