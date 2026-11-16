// Role sets — no imports, so every module can use them at load time (no import cycles).
/**
 * Space roles (decided 2026-11-16). Owner = platform-team (always allowed). Entity Manager (<entity>-admins) = Manager of
 * every space of the entity. One person may be Maintainer AND Manager (union of both).
 *   Developer : push code via PR, dev secrets, Run build — creates nothing, deletes nothing
 *   Maintainer: + create CI/repo/CD, Deploy to dev, change tools, delete deployments
 *   Manager   : + Promote to prod, prod secrets, delete applications, members of the space
 */
export const ROLE = {
  MEMBER: ['managers', 'maintainers', 'developers', 'viewers'],
  DEV: ['managers', 'maintainers', 'developers'],
  CREATE: ['managers', 'maintainers'],
  PROD: ['managers'],
} as const;
