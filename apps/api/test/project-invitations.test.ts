import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { InvitationRedemptionController, parseInvitationCode, parseInvitationRole } from '../src/project-invitations.controller';
import { ProjectInvitationsService } from '../src/project-invitations.service';

describe('secure invitation boundaries', () => {
  it('only issues non-owner roles', () => {
    expect(parseInvitationRole({ role: 'editor' })).toBe('editor');
    expect(() => parseInvitationRole({ role: 'owner' })).toThrow(BadRequestException);
  });
  it('requires high-entropy base64url code shape', () => {
    expect(parseInvitationCode({ code: 'a'.repeat(43) })).toHaveLength(43);
    expect(() => parseInvitationCode({ code: '../short' })).toThrow(BadRequestException);
    expect(() => parseInvitationCode(null)).toThrow(BadRequestException);
  });
  it('cannot issue or redeem invitations without authenticated OIDC identity', async () => {
    const service = new ProjectInvitationsService({} as never, {} as never, {} as never);
    await expect(service.create('demo', 'viewer', { mode: 'local' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.redeem('a'.repeat(43), { mode: 'local' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.revoke('demo', 'any-id', { mode: 'local' })).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('rejects malformed invitation IDs before accessing project data', async () => {
    const service = new ProjectInvitationsService({} as never, {} as never, {} as never);
    await expect(service.revoke('demo', '../invalid', { mode: 'oidc', issuer: 'https://example.test', subject: 'user-1' }))
      .rejects.toMatchObject({ status: 404 });
  });
  it('consumes quota before rejecting malformed redemption input', async () => {
    const limitRedemption = vi.fn().mockResolvedValue(undefined);
    const redeem = vi.fn();
    const controller = new InvitationRedemptionController({ limitRedemption, redeem } as never);
    const request = { projectAuth: { mode: 'oidc', issuer: 'https://example.test', subject: 'user-1' } } as never;
    await expect(controller.redeem({ code: 'invalid' }, request)).rejects.toBeInstanceOf(BadRequestException);
    expect(limitRedemption).toHaveBeenCalledOnce();
    expect(redeem).not.toHaveBeenCalled();
  });
});
