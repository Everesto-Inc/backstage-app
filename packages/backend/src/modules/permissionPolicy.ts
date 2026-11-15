/*
 * Permission policy — replaces the stock `allow-all` policy.
 *
 * Model: read-only for everyone who can sign in; the dangerous write actions
 * (running scaffolder templates, registering/deleting catalog locations,
 * creating/deleting catalog entities) are restricted to the `platform-team`
 * group. This caps the blast radius if a single user token ever leaks — a
 * leaked read token can browse the catalog but cannot reach the scaffolder's
 * GitHub token or register an SSRF catalog location.
 *
 * To grant someone these rights: add them to `platform-team` in everesto-catalog/platform/org.yaml.
 */
import { createBackendModule } from '@backstage/backend-plugin-api';
import { policyExtensionPoint } from '@backstage/plugin-permission-node/alpha';
import {
  PermissionPolicy,
  PolicyQuery,
  PolicyQueryUser,
} from '@backstage/plugin-permission-node';
import {
  AuthorizeResult,
  PolicyDecision,
  isPermission,
} from '@backstage/plugin-permission-common';
import {
  catalogEntityCreatePermission,
  catalogEntityDeletePermission,
  catalogLocationCreatePermission,
  catalogLocationDeletePermission,
} from '@backstage/plugin-catalog-common/alpha';
import {
  actionExecutePermission,
  taskCreatePermission,
  templateManagementPermission,
} from '@backstage/plugin-scaffolder-common/alpha';

// The group that is allowed to perform privileged actions.
const PRIVILEGED_GROUP = 'group:default/platform-team';

// Permissions that are denied unless the caller is in the privileged group.
// Running templates (Create pipeline): members of any DevOps space (developer and up) + platform-team.
// The template's first step (everesto:space:require-member) then checks membership of the CHOSEN space.
const TEMPLATE_RUN_PERMISSIONS = [actionExecutePermission, taskCreatePermission];
const SPACE_MEMBER = /^group:default\/[a-z0-9-]+-(owners|maintainers|developers)$/;

const PRIVILEGED_PERMISSIONS = [
  // Scaffolder: editing templates stays with the platform team.
  templateManagementPermission,
  // Catalog: registering a location makes the backend fetch an arbitrary URL
  // (SSRF to cloud metadata / internal services). Deleting/creating entities
  // mutates the catalog. Reading stays open to all.
  catalogLocationCreatePermission,
  catalogLocationDeletePermission,
  catalogEntityCreatePermission,
  catalogEntityDeletePermission,
];

export class PlatformTeamPermissionPolicy implements PermissionPolicy {
  async handle(
    request: PolicyQuery,
    user?: PolicyQueryUser,
  ): Promise<PolicyDecision> {
    const isPrivileged = PRIVILEGED_PERMISSIONS.some(permission =>
      isPermission(request.permission, permission),
    );

    const refs = user?.info.ownershipEntityRefs ?? [];
    if (TEMPLATE_RUN_PERMISSIONS.some(p => isPermission(request.permission, p))) {
      const ok = refs.includes(PRIVILEGED_GROUP) || refs.some(r => SPACE_MEMBER.test(r));
      return { result: ok ? AuthorizeResult.ALLOW : AuthorizeResult.DENY };
    }

    if (isPrivileged) {
      const inGroup =
        user?.info.ownershipEntityRefs.includes(PRIVILEGED_GROUP) ?? false;
      return {
        result: inGroup ? AuthorizeResult.ALLOW : AuthorizeResult.DENY,
      };
    }

    // Everything else (reads, user-settings, search, etc.) is allowed for any
    // signed-in user. Unauthenticated access is still blocked by the default
    // auth policy, independently of this file.
    return { result: AuthorizeResult.ALLOW };
  }
}

export const permissionPolicyModule = createBackendModule({
  pluginId: 'permission',
  moduleId: 'platform-team-policy',
  register(reg) {
    reg.registerInit({
      deps: { policy: policyExtensionPoint },
      async init({ policy }) {
        policy.setPolicy(new PlatformTeamPermissionPolicy());
      },
    });
  },
});
