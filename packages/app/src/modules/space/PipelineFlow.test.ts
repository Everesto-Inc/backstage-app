import { toolUrl } from './PipelineFlow';

const ci = { apiVersion: 'v1', kind: 'Component', metadata: { name: 'python-backend', annotations: {
  'github.com/project-slug': 'Everesto-Inc/python-backend', 'sonarqube.org/project-key': 'python-backend' } } } as any;
const cd = { apiVersion: 'v1', kind: 'Resource', metadata: { name: 'python-backend-gitops', annotations: {
  'github.com/project-slug': 'Everesto-Inc/python-backend-gitops' } } } as any;

describe('toolUrl', () => {
  it('links every icon to THIS app', () => {
    expect(toolUrl(ci, 'ci')).toBe('https://github.com/Everesto-Inc/python-backend/actions');
    expect(toolUrl(ci, 'quality')).toBe('https://sonar.everesto.live/dashboard?id=python-backend');
    expect(toolUrl(ci, 'registry')).toBe('https://github.com/orgs/Everesto-Inc/packages/container/package/python-backend');
  });
  it('CD: own gitops repo, own image, own ArgoCD apps', () => {
    expect(toolUrl(cd, 'code')).toBe('https://github.com/Everesto-Inc/python-backend-gitops');
    expect(toolUrl(cd, 'registry')).toBe('https://github.com/orgs/Everesto-Inc/packages/container/package/python-backend');
    expect(toolUrl(cd, 'cd')).toContain('search=python-backend');
  });
  it('no SonarQube link when SonarQube is off', () => {
    expect(toolUrl(cd, 'quality')).toBeUndefined();
  });
});
