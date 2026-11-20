import { createCipheriv, randomBytes, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decryptDeployKey, deployEncryptionKey, encryptDeployKey, requireUnencryptedPrivateKey } from '../src/deploy-secrets';

describe('B12 secret storage', () => {
  it('uses random IVs, authenticates ciphertext and binds keys to the project and target', () => {
    const key = randomBytes(32), text = 'dedicated SSH key';
    const a = encryptDeployKey(text, key, 'project', 'target'), b = encryptDeployKey(text, key, 'project', 'target');
    expect(a).not.toBe(b); expect(a).not.toContain(text);
    expect(decryptDeployKey(a, key, 'project', 'target').toString()).toBe(text);
    for (const [secret, project, target] of [[randomBytes(32), 'project', 'target'], [key, 'other', 'target'], [key, 'project', 'other']] as const) {
      expect(() => decryptDeployKey(a, secret, project, target)).toThrow('deploy_key_decryption_failed');
    }
    const parts = a.split('.'); parts[2] = Buffer.alloc(16).toString('base64');
    expect(() => decryptDeployKey(parts.join('.'), key, 'project', 'target')).toThrow('deploy_key_decryption_failed');
    expect(() => deployEncryptionKey(undefined)).toThrow(); expect(() => deployEncryptionKey('bad')).toThrow();
    expect(deployEncryptionKey(key.toString('hex'))).toEqual(key);
  });
  it('rejects truncated or oversized authentication tags, including valid 32-bit tag prefixes', () => {
    const key = randomBytes(32), blob = encryptDeployKey('dedicated SSH key', key, 'project', 'target');
    const original = blob.split('.');
    expect(Buffer.from(original[1]!, 'base64')).toHaveLength(12);
    expect(Buffer.from(original[2]!, 'base64')).toHaveLength(16);
    for (const length of [0, 4, 8, 12, 13, 14, 15, 17]) {
      const parts = [...original];
      const tag = Buffer.from(original[2]!, 'base64');
      parts[2] = (length > 16 ? Buffer.concat([tag, Buffer.alloc(length - 16)]) : tag.subarray(0, length)).toString('base64');
      expect(() => decryptDeployKey(parts.join('.'), key, 'project', 'target')).toThrow(/^deploy_key_decryption_failed$/);
    }
  });
  it('rejects otherwise valid GCM ciphertexts with a non-96-bit IV', () => {
    const key = randomBytes(32);
    for (const length of [8, 11, 13, 16]) {
      const iv = randomBytes(length), cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
      cipher.setAAD(Buffer.from('b12:project:target'));
      const ciphertext = Buffer.concat([cipher.update('dedicated SSH key'), cipher.final()]);
      const blob = ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
      expect(() => decryptDeployKey(blob, key, 'project', 'target')).toThrow(/^deploy_key_decryption_failed$/);
    }
  });
  it('accepts unencrypted PEM and OpenSSH keys and rejects encrypted or malformed material without echoing it', () => {
    const key = generateKeyPairSync('ed25519').privateKey;
    requireUnencryptedPrivateKey(key.export({ format: 'pem', type: 'pkcs8' }).toString());
    const encrypted = key.export({ format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase: 'test-only' });
    expect(() => requireUnencryptedPrivateKey(encrypted.toString())).toThrow('deploy_private_key_invalid_or_encrypted');
    const work = mkdtempSync(join(tmpdir(), 'b12-key-'));
    try {
      const path = join(work, 'key');
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path]);
      requireUnencryptedPrivateKey(readFileSync(path, 'utf8'));
      execFileSync('ssh-keygen', ['-q', '-p', '-P', '', '-N', 'test-only', '-f', path]);
      expect(() => requireUnencryptedPrivateKey(readFileSync(path, 'utf8'))).toThrow('deploy_private_key_invalid_or_encrypted');
      expect(statSync(path).mode & 0o777).toBe(0o600);
      writeFileSync(path, 'secret malformed material');
      expect(() => requireUnencryptedPrivateKey(readFileSync(path, 'utf8'))).toThrow(/^deploy_private_key_invalid_or_encrypted$/);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
});
