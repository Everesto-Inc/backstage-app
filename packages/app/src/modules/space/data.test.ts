import { classifyParts, deployedApp } from './data';

const e = (kind: string, name: string, type: string, annotations?: Record<string, string>) =>
  ({ apiVersion: 'backstage.io/v1alpha1', kind, metadata: { name, annotations }, spec: { type } }) as any;

describe('classifyParts', () => {
  const parts = classifyParts([
    e('Component', 'backstage-app', 'website'),
    e('Component', 'platform-guides', 'documentation'),
    e('Component', 'notes', 'repository'),
    e('Resource', 'gitops-backstage', 'gitops'),
    e('Resource', 'some-bucket', 'storage'),
  ]);
  it('never counts docs as CI, and only gitops/deployment Resources as CD', () => {
    expect(parts.ci.map(x => x.metadata.name)).toEqual(['backstage-app']);
    expect(parts.docs.map(x => x.metadata.name)).toEqual(['platform-guides']);
    expect(parts.repoOnly.map(x => x.metadata.name)).toEqual(['notes']);
    expect(parts.cd.map(x => x.metadata.name)).toEqual(['gitops-backstage']);
  });
});

describe('deployedApp', () => {
  it('uses the everesto.live/deploys annotation, else the <app>-gitops convention', () => {
    expect(deployedApp(e('Resource', 'gitops-backstage', 'gitops', { 'everesto.live/deploys': 'backstage-app' }))).toBe('backstage-app');
    expect(deployedApp(e('Resource', 'agency-backend-gitops', 'gitops'))).toBe('agency-backend');
  });
});
