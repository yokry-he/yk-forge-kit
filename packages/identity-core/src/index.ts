/** Authorization policy is pure and provider-independent. The HTTP guard must supply trusted membership data. */
export { createOidcTokenVerifier, validateOidcVerifierConfig } from './oidc.js';
export type { AuthenticatedSubject, OidcVerifierConfig } from './oidc.js';
export type ProjectRole = 'owner' | 'editor' | 'viewer';
export type ProjectPermission =
  | 'project:read' | 'project:update' | 'project:delete'
  | 'asset:read' | 'asset:plan'
  | 'member:read' | 'member:manage'
  | 'build:read' | 'build:run' | 'build:cancel';

const permissions: Readonly<Record<ProjectRole, ReadonlySet<ProjectPermission>>> = {
  owner: new Set(['project:read', 'project:update', 'project:delete', 'asset:read', 'asset:plan', 'member:read', 'member:manage', 'build:read', 'build:run', 'build:cancel']),
  editor: new Set(['project:read', 'project:update', 'asset:read', 'asset:plan', 'member:read', 'build:read', 'build:run', 'build:cancel']),
  viewer: new Set(['project:read', 'asset:read', 'member:read', 'build:read']),
};

/** Unknown roles, missing memberships and unrecognized permissions always deny. */
export function canAccessProject(role: string | null | undefined, permission: ProjectPermission): boolean {
  return !!role && Object.hasOwn(permissions, role) && permissions[role as ProjectRole].has(permission);
}

/** Owners cannot silently demote/remove themselves or the final owner. Enforcement is transaction-scoped later. */
export function canManageMembership(actor: ProjectRole | null, targetRole: ProjectRole, isSelf: boolean): boolean {
  return canAccessProject(actor, 'member:manage') && !isSelf && (targetRole === 'editor' || targetRole === 'viewer');
}
