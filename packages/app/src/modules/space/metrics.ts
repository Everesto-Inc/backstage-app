import { Entity } from '@backstage/catalog-model';

/**
 * DUMMY metrics per application — deterministic from the entity name so the
 * preview is stable between reloads. Replaced later by GitHub / SonarQube /
 * Fortify / Nexus IQ / ArgoCD / Grafana APIs.
 */
const seed = (s: string) => {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ (c.codePointAt(0) ?? 0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h >>> 0) % 1000) / 1000;
  };
};

export type AppMetrics = {
  commits: number[]; // per day, 14 days
  lastBuild: { id: number; ok: boolean; ago: string; minutes: number };
  successRate: number; // %
  coverage: number; // %
  gatePassed: boolean;
  newCodeCoverage: number; // %
  newIssues: number;
  topIssue: string;
  secretsFound: number;
  semgrep: { critical: number; high: number };
  trivy: { critical: number; high: number };
  sast: { critical: number; high: number }; // Fortify
  deps: { critical: number; high: number }; // Nexus IQ
  deploys: number[]; // per day, 14 days
  lastDeploy: string;
  health: 'Healthy' | 'Degraded';
};

export const metricsFor = (e: Entity): AppMetrics => {
  const r = seed(e.metadata.name);
  const commits = Array.from({ length: 14 }, (_, i) => Math.round(r() * 8 + (i % 7 >= 5 ? 0 : 2)));
  const ok = r() > 0.2;
  return {
    commits,
    lastBuild: { id: 30 + Math.round(r() * 40), ok, ago: `${1 + Math.round(r() * 20)} h ago`, minutes: 3 + r() * 5 },
    successRate: Math.round(82 + r() * 17),
    coverage: Math.round((60 + r() * 30) * 10) / 10,
    gatePassed: r() > 0.25,
    newCodeCoverage: Math.round(70 + r() * 25),
    newIssues: Math.round(r() * 4),
    topIssue: ['unused variable in OrderService.java:31', 'missing null check in PriceCalc.py:18', 'duplicated block in api/routes.py'][Math.floor(r() * 3)],
    secretsFound: r() > 0.9 ? 1 : 0,
    semgrep: { critical: 0, high: Math.round(r() * 2) },
    trivy: { critical: r() > 0.85 ? 1 : 0, high: Math.round(r() * 3) },
    sast: { critical: r() > 0.8 ? 1 : 0, high: Math.round(r() * 2) },
    deps: { critical: r() > 0.85 ? 1 : 0, high: Math.round(r() * 3) },
    deploys: Array.from({ length: 14 }, () => Math.round(r() * 3)),
    lastDeploy: `${1 + Math.round(r() * 30)} h ago`,
    health: r() > 0.15 ? 'Healthy' : 'Degraded',
  };
};

export const days = (vals: number[]) =>
  vals.map((v, i) => ({ t: vals.length - i - 1 === 0 ? 'today' : `${vals.length - i - 1}d ago`, v }));
