import { describe, expect, it, vi } from 'vitest';
import { invitationBucketKey, InvitationRateLimiter } from '../src/invitation-rate-limiter';

describe('invitation rate limiting', () => {
  it('separates issuer/subject identities and independent quota windows', () => {
    const first = invitationBucketKey('redeem', 'issuer-a', 'subject', 0);
    expect(first).toBe(invitationBucketKey('redeem', 'issuer-a', 'subject', 1000));
    expect(first).not.toBe(invitationBucketKey('redeem', 'issuer-b', 'subject', 0));
    expect(first).not.toBe(invitationBucketKey('redeem', 'issuer-a', 'subject', 900_000));
    expect(first).not.toBe(invitationBucketKey('create', 'issuer-a', 'subject', 0));
    expect(first).not.toContain('issuer-a');
    expect(first).not.toContain('subject');
  });

  it('checks the counter inside the same database transaction as atomic upsert', async () => {
    const insert = vi.fn(() => ({ values: () => ({ onDuplicateKeyUpdate: vi.fn().mockResolvedValue(undefined) }) }));
    const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [{ attempts: 31 }] }) }) }));
    const transaction = vi.fn(async (callback: (tx: unknown) => Promise<void>) => callback({ insert, select }));
    const limiter = new InvitationRateLimiter({ db: { transaction } } as never);
    await expect(limiter.consume('redeem', 'issuer', 'sub')).rejects.toMatchObject({ status: 429 });
    expect(insert).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledOnce();
    expect(transaction).toHaveBeenCalledOnce();
  });

  it('accepts the exact quota limit', async () => {
    const tx = {
      insert: () => ({ values: () => ({ onDuplicateKeyUpdate: async () => undefined }) }),
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ attempts: 10 }] }) }) }),
    };
    const limiter = new InvitationRateLimiter({ db: { transaction: (callback: (tx: unknown) => Promise<void>) => callback(tx) } } as never);
    await expect(limiter.consume('create', 'issuer', 'sub')).resolves.toBeUndefined();
  });
});
