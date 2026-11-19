import { useEntity } from '@backstage/plugin-catalog-react';
import { RealSecurityTab } from '../space/RealMetrics';

/** Application → "Security": results of the scanners in the last main CI run (Gitleaks, Semgrep, Trivy, SonarQube). */
export const SecurityTab = () => {
  const { entity } = useEntity();
  return <RealSecurityTab entity={entity} />;
};
