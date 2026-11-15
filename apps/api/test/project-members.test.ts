import { describe, expect, it } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { parseMemberRole } from '../src/project-members.controller';
import { ProjectMembersService } from '../src/project-members.service';

describe('member role update input', () => {
  it('allows editor and viewer only', () => {
    expect(parseMemberRole({ role: 'editor' })).toBe('editor');
    expect(parseMemberRole({ role: 'viewer' })).toBe('viewer');
  });
  it.each([null, {}, { role: 'owner' }, { role: 'admin' }, { role: 42 }, []])
    ('rejects dangerous role changes', (value) => {
      expect(() => parseMemberRole(value)).toThrow(BadRequestException);
    });
  it('never authorizes role mutation in local development mode', async () => {
    const members = new ProjectMembersService({} as never, {} as never);
    await expect(members.updateRole('demo', 'someone', 'viewer', { mode: 'local' })).rejects.toBeInstanceOf(ForbiddenException);
  });
});
