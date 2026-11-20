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
  it('permits preview management only for owner/editor and metadata reads for members', () => {
    for (const role of ['owner', 'editor', 'viewer']) expect(canAccessProject(role, 'preview:read')).toBe(true);
    for (const role of ['owner', 'editor']) expect(canAccessProject(role, 'preview:manage')).toBe(true);
    for (const role of ['viewer', 'admin', null]) expect(canAccessProject(role, 'preview:manage')).toBe(false);
  });
  it('allows deploy reads to members and target/deploy writes only to owners and editors', () => {
    for (const role of ['owner', 'editor', 'viewer']) expect(canAccessProject(role, 'deploy:read')).toBe(true);
    for (const permission of ['deploy:run', 'deploy:manage'] as const) {
      for (const role of ['owner', 'editor']) expect(canAccessProject(role, permission)).toBe(true);
      for (const role of ['viewer', 'admin', null]) expect(canAccessProject(role, permission)).toBe(false);
    }
  });
  it('limits owner membership changes until last-owner protection is implemented', () => {
    expect(canManageMembership('owner', 'viewer', false)).toBe(true);
    expect(canManageMembership('owner', 'owner', false)).toBe(false);
    expect(canManageMembership('owner', 'editor', true)).toBe(false);
  });
});
