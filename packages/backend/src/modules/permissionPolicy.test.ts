import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { catalogEntityDeletePermission, catalogEntityReadPermission, catalogLocationCreatePermission } from '@backstage/plugin-catalog-common/alpha';
import { taskCreatePermission } from '@backstage/plugin-scaffolder-common/alpha';
import { PlatformTeamPermissionPolicy } from './permissionPolicy';

const user = (refs: string[]) => ({ info: { userEntityRef: 'user:default/x', ownershipEntityRefs: refs } }) as any;
const policy = new PlatformTeamPermissionPolicy();
const decide = async (permission: any, refs: string[]) => (await policy.handle({ permission } as any, user(refs))).result;

describe('PlatformTeamPermissionPolicy', () => {
  it('lets every signed-in user read the catalog', async () => {
    expect(await decide(catalogEntityReadPermission, [])).toBe(AuthorizeResult.ALLOW);
  });

  it('denies catalog writes and location registration (SSRF) to non-platform users', async () => {
    for (const p of [catalogEntityDeletePermission, catalogLocationCreatePermission]) {
      expect(await decide(p, ['group:default/orchid-owners'])).toBe(AuthorizeResult.DENY);
      expect(await decide(p, ['group:default/platform-team'])).toBe(AuthorizeResult.ALLOW);
    }
  });

  it('runs templates only for platform-team (current rule)', async () => {
    expect(await decide(taskCreatePermission, ['group:default/orchid-developers'])).toBe(AuthorizeResult.DENY);
    expect(await decide(taskCreatePermission, ['group:default/platform-team'])).toBe(AuthorizeResult.ALLOW);
  });

  it('denies privileged actions to anonymous callers', async () => {
    expect((await policy.handle({ permission: catalogEntityDeletePermission } as any, undefined)).result).toBe(AuthorizeResult.DENY);
  });
});
