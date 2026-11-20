import { createCipheriv, createDecipheriv, createPrivateKey, randomBytes } from 'node:crypto';

/** A control-plane key, never forwarded to build containers. Missing config disables writes. */
export function deployEncryptionKey(value: string | undefined): Buffer {
  if (!value || !/^[a-fA-F0-9]{64}$/.test(value)) throw new Error('deploy_encryption_not_configured');
  return Buffer.from(value, 'hex');
}
export function encryptDeployKey(plaintext: string, key: Buffer, projectId: string, targetId: string): string {
  return encryptAuthenticatedSecret(plaintext, key, `b12:${projectId}:${targetId}`);
}

function encryptAuthenticatedSecret(plaintext: string, key: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
}
export function decryptDeployKey(blob: string, key: Buffer, projectId: string, targetId: string): Buffer {
  return decryptAuthenticatedSecret(blob, key, `b12:${projectId}:${targetId}`);
}

function decryptAuthenticatedSecret(blob: string, key: Buffer, aad: string): Buffer {
  try {
    const [version, iv, tag, ciphertext, extra] = blob.split('.');
    if (version !== 'v1' || !iv || !tag || !ciphertext || extra !== undefined) throw new Error();
    const decodedIv = Buffer.from(iv, 'base64'), decodedTag = Buffer.from(tag, 'base64');
    if (decodedIv.length !== 12 || decodedTag.length !== 16) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, decodedIv, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(decodedTag);
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
  } catch { throw new Error('deploy_key_decryption_failed'); }
}

/** Reject encrypted keys before persistence; no passphrase or interactive-agent fallback. */
export function requireUnencryptedPrivateKey(value: string): void {
  try {
    if (value.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----')) {
      const data = Buffer.from(value.replace(/-----[^\n]+-----/g, '').replace(/\s/g, ''), 'base64');
      if (!data.subarray(0, 15).equals(Buffer.from('openssh-key-v1\0'))) throw new Error();
      let offset = 15;
      const string = () => {
        const size = data.readUInt32BE(offset); offset += 4;
        if (size > data.length - offset) throw new Error();
        const field = data.subarray(offset, offset + size); offset += size; return field;
      };
      if (string().toString() !== 'none' || string().toString() !== 'none' || string().length !== 0 || data.readUInt32BE(offset) !== 1) throw new Error();
      offset += 4;
      if (!string().length || !string().length || offset !== data.length) throw new Error();
    } else {
      // Loaded lazily only for PEM input. Import has no filesystem side effects.
      createPrivateKey({ key: value, passphrase: '' });
    }
  } catch { throw new Error('deploy_private_key_invalid_or_encrypted'); }
}

/** Separate namespace and unambiguous identity tuple; B12 wire format stays unchanged. */
export const variableAAD = (projectId: string, environmentId: string, name: string) =>
  `b14:${JSON.stringify([projectId, environmentId, name])}`;
export function encryptVariable(value: string, key: Buffer, projectId: string, environmentId: string, name: string) {
  return encryptAuthenticatedSecret(value, key, variableAAD(projectId, environmentId, name));
}
export function decryptVariable(value: string, key: Buffer, projectId: string, environmentId: string, name: string) {
  return decryptAuthenticatedSecret(value, key, variableAAD(projectId, environmentId, name));
}
