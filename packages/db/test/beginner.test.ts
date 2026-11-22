import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BeginnerRepository, BeginnerKeyRequiredError } from '../src/beginner-repository';
import { decryptBeginnerKey, decryptVariable, encryptBeginnerKey, encryptAlipayKey } from '../src/deploy-secrets';
import { beginnerAiConfigs, users } from '../src/schema';
import type { DatabaseClient } from '../src/index';
const settings = { provider: 'DeepSeek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/' };

describe('B21 secrets and repository', () => {
  it('authenticates user UUID and B21 namespace with randomized AES-GCM ciphertext', () => {
    const key = randomBytes(32), userId = randomUUID(), secret = 'sk-only-write-b21';
    const first = encryptBeginnerKey(secret, key, userId, settings), second = encryptBeginnerKey(secret, key, userId, settings);
    expect(first).not.toBe(second); expect(first).not.toContain(secret);
    expect(decryptBeginnerKey(first, key, userId, settings).toString()).toBe(secret);
    expect(() => decryptBeginnerKey(first, key, randomUUID(), settings)).toThrow();
    expect(() => decryptBeginnerKey(first, randomBytes(32), userId, settings)).toThrow();
    for (const change of [{ baseUrl: 'https://other.example.com' }, { provider: 'Other' }, { model: 'other-model' }]) {
      expect(() => decryptBeginnerKey(first, key, userId, { ...settings, ...change })).toThrow();
    }
    expect(() => decryptBeginnerKey(encryptAlipayKey(secret, key, userId), key, userId, settings)).toThrow();
    expect(() => decryptVariable(first, key, userId, '', '')).toThrow();
    const parts = first.split('.'); parts[2] = randomBytes(16).toString('base64');
    expect(() => decryptBeginnerKey(parts.join('.'), key, userId, settings)).toThrow();
  });
  it('rejects legacy ciphertext without a destination binding', () => {
    const key = randomBytes(32), iv = randomBytes(12), userId = randomUUID();
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`b21:${userId}`));
    const ciphertext = Buffer.concat([cipher.update('legacy-test-key'), cipher.final()]);
    const legacy = ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
    expect(() => decryptBeginnerKey(legacy, key, userId, settings)).toThrow();
  });
  function fixture(existing?: { encryptedApiKey: string; baseUrl?: string; provider?: string; model?: string }) {
    const forUpdate = vi.fn().mockResolvedValue([{ id: 'user' }]);
    const select = vi.fn().mockReturnValueOnce({ from: () => ({ where: () => ({ for: forUpdate }) }) })
      .mockReturnValueOnce({ from: () => ({ where: async () => existing ? [{ ...settings, ...existing }] : [] }) });
    const values = vi.fn(() => ({ onDuplicateKeyUpdate: vi.fn().mockResolvedValue(undefined) }));
    const insert = vi.fn(() => ({ values }));
    const deleted = vi.fn().mockResolvedValue(undefined), remove = vi.fn(() => ({ where: deleted }));
    const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ select, insert, delete: remove }));
    const repository = new BeginnerRepository({ transaction } as unknown as DatabaseClient['db']);
    return { repository, forUpdate, select, values, insert, remove, transaction };
  }
  it('retains ciphertext on an empty replacement and locks the owning user before upsert', async () => {
    const f = fixture({ encryptedApiKey: 'existing-ciphertext' });
    const result = await f.repository.save('user', settings);
    expect(result.encryptedApiKey).toBe('existing-ciphertext'); expect(result.baseUrl).toBe('https://api.deepseek.com');
    expect(f.forUpdate).toHaveBeenCalledWith('update'); expect(f.select).toHaveBeenCalledTimes(2);
    expect(f.insert).toHaveBeenCalledWith(beginnerAiConfigs);
    expect(f.values).toHaveBeenCalledWith(result);
    expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'read committed' });
  });
  it('requires first key, replaces only when supplied, and serializes delete on the same user lock', async () => {
    const missing = fixture(); await expect(missing.repository.save('user', settings)).rejects.toBeInstanceOf(BeginnerKeyRequiredError);
    expect(missing.insert).not.toHaveBeenCalled();
    const f = fixture({ encryptedApiKey: 'old' });
    expect((await f.repository.save('user', settings, 'new-ciphertext')).encryptedApiKey).toBe('new-ciphertext');
    const removal = fixture(); await removal.repository.remove('user');
    expect(removal.select).toHaveBeenCalledWith({ id: users.id }); expect(removal.forUpdate).toHaveBeenCalledWith('update');
    expect(removal.remove).toHaveBeenCalledWith(beginnerAiConfigs);
  });
  it.each([{ baseUrl: 'https://other.example.com/v1' }, { provider: 'Other' }, { model: 'other-model' }])('requires replacement for destination changes: %j', async change => {
    const f = fixture({ encryptedApiKey: 'old' });
    await expect(f.repository.save('user', { ...settings, ...change })).rejects.toBeInstanceOf(BeginnerKeyRequiredError);
    expect(f.insert).not.toHaveBeenCalled();
    const updated = await fixture({ encryptedApiKey: 'old' }).repository.save('user', { ...settings, ...change }, 'new');
    expect(updated).toMatchObject({ ...change, encryptedApiKey: 'new' });
  });
  it('normalizes equivalent URLs before deciding whether the key can be retained', async () => {
    const f = fixture({ encryptedApiKey: 'old' });
    expect((await f.repository.save('user', { ...settings, baseUrl: 'https://API.DEEPSEEK.COM:443' })).encryptedApiKey).toBe('old');
  });
});
