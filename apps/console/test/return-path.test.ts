import { describe, expect, it } from 'vitest';
import { requiresOidcProjectAccess, returnPathFromOidcState, safeProjectReturnPath } from '../src/auth/return-path';

describe('safe OIDC post-login navigation', () => {
  it('keeps internal project routes and their local query parameters', () => {
    expect(safeProjectReturnPath('/projects/new')).toBe('/projects/new');
    expect(safeProjectReturnPath('/projects/demo?tab=members')).toBe('/projects/demo?tab=members');
    expect(returnPathFromOidcState({ returnTo: '/projects/demo' })).toBe('/projects/demo');
  });

  it.each(['https://evil.example', '//evil.example', '/projects.evil/path', '/assets', '/auth/callback',
    '/projects\\evil', '/projects\nother', 'x'.repeat(513), null, undefined])
  ('never redirects outside authorized project paths: %s', (value) => {
    expect(safeProjectReturnPath(value)).toBe('/projects');
  });

  it('defaults safely when callback state is missing or malformed', () => {
    expect(returnPathFromOidcState(null)).toBe('/projects');
    expect(returnPathFromOidcState({ returnTo: '//other-site' })).toBe('/projects');
    expect(returnPathFromOidcState([])).toBe('/projects');
  });

  it('only guards actual project routes', () => {
    expect(requiresOidcProjectAccess('/projects')).toBe(true);
    expect(requiresOidcProjectAccess('/projects/new')).toBe(true);
    expect(requiresOidcProjectAccess('/projects/demo')).toBe(true);
    expect(requiresOidcProjectAccess('/projects.evil')).toBe(false);
    expect(requiresOidcProjectAccess('/auth/callback')).toBe(false);
    expect(requiresOidcProjectAccess('/assets')).toBe(false);
  });
});
