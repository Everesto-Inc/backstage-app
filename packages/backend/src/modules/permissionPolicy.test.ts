import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { announcementCreatePermission, announcementDeletePermission } from '@backstage-community/plugin-announcements-common';
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

  it('lets maintainers, managers, entity managers and platform-team run templates', async () => {
    expect(await decide(taskCreatePermission, ['group:default/orchid-maintainers'])).toBe(AuthorizeResult.ALLOW);
    expect(await decide(taskCreatePermission, ['group:default/orchid-managers'])).toBe(AuthorizeResult.ALLOW);
    expect(await decide(taskCreatePermission, ['group:default/blackbuck-admins'])).toBe(AuthorizeResult.ALLOW); // entity admin
    expect(await decide(taskCreatePermission, ['group:default/platform-team'])).toBe(AuthorizeResult.ALLOW);
  });

  it('lets developers run templates (Create pipeline / repository); denies viewers and users without a space', async () => {
    expect(await decide(taskCreatePermission, ['group:default/orchid-developers'])).toBe(AuthorizeResult.ALLOW);
    expect(await decide(taskCreatePermission, ['group:default/orchid-viewers'])).toBe(AuthorizeResult.DENY);
    expect(await decide(taskCreatePermission, [])).toBe(AuthorizeResult.DENY);
  });

  it('denies catalog writes to maintainers and entity admins (platform-team only)', async () => {
    expect(await decide(catalogEntityDeletePermission, ['group:default/orchid-maintainers'])).toBe(AuthorizeResult.DENY);
    expect(await decide(catalogEntityDeletePermission, ['group:default/blackbuck-admins'])).toBe(AuthorizeResult.DENY);
  });

  it('denies privileged actions to anonymous callers', async () => {
    expect((await policy.handle({ permission: catalogEntityDeletePermission } as any, undefined)).result).toBe(AuthorizeResult.DENY);
  });
});

describe('announcements', () => {
  it('only the platform team posts, edits or deletes announcements', async () => {
    expect(await decide(announcementCreatePermission, ['group:default/platform-team'])).toBe(AuthorizeResult.ALLOW);
    expect(await decide(announcementCreatePermission, ['group:default/orchid-managers'])).toBe(AuthorizeResult.DENY);
    expect(await decide(announcementDeletePermission, ['group:default/blackbuck-admins'])).toBe(AuthorizeResult.DENY);
  });
});
