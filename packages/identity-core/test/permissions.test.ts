import { describe, expect, it } from 'vitest';
import { canAccessProject, canManageMembership } from '../src/index';

describe('project authorization policy', () => {
  it('denies anonymous and unknown roles', () => {
    expect(canAccessProject(null, 'project:read')).toBe(false);
    expect(canAccessProject('admin', 'project:delete')).toBe(false);
    expect(canAccessProject('__proto__', 'project:read')).toBe(false);
  });
  it('allows read-only viewers', () => {
    expect(canAccessProject('viewer', 'asset:read')).toBe(true);
    expect(canAccessProject('viewer', 'asset:plan')).toBe(false);
    expect(canAccessProject('viewer', 'project:delete')).toBe(false);
  });
  it('allows editors to update and plan but not delete or manage members', () => {
    expect(canAccessProject('editor', 'asset:plan')).toBe(true);
    expect(canAccessProject('editor', 'project:update')).toBe(true);
    expect(canAccessProject('editor', 'member:manage')).toBe(false);
    expect(canAccessProject('editor', 'project:delete')).toBe(false);
  });
  it('limits owner membership changes until last-owner protection is implemented', () => {
    expect(canManageMembership('owner', 'viewer', false)).toBe(true);
    expect(canManageMembership('owner', 'owner', false)).toBe(false);
    expect(canManageMembership('owner', 'editor', true)).toBe(false);
  });
});
