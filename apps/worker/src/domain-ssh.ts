import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuildIdSchema, DeployTargetCreateSchema, DomainNameSchema, DomainTlsModeSchema } from '@forgekit/contracts';
import { decryptDeployKey, type DeployTargetRow, type DomainOperationRow, type DomainRow } from '@forgekit/db';
import { boundedCommand, sshArguments } from './ssh-command';
import { shellQuote, releaseRoot } from './ssh-release';
import { domainRemoteProgram } from './domain-remote';
import { DomainError } from './domain-dns';
export interface DomainCertificate { expiresAt: Date; fingerprint: string }
export interface DomainHost {
  run(domain: DomainRow, operation: DomainOperationRow, target: DeployTargetRow, signal: AbortSignal): Promise<DomainCertificate | null>;
}
export function domainCommand(input: { basePath: string; siteRoot: string; id: string; hostname: string; tlsMode: string; action: string }) {
  const root = input.basePath + '/.forgekit-caddy';
  const payload = Buffer.from(JSON.stringify(input)).toString('base64');
  return `set -eu; umask 077; [ -d ${shellQuote(root)} ] || { printf 'B13_ERROR:domain_host_not_prepared\\n'; exit 0; }; exec timeout --signal=TERM --kill-after=5s 240s flock -w 10 ${shellQuote(root + '/.lock')} python3 -c ${shellQuote(domainRemoteProgram)} ${shellQuote(payload)}`;
}
export class SshDomainHost implements DomainHost {
  constructor(private readonly encryptionKey: Buffer) {}
  async run(domain: DomainRow, operation: DomainOperationRow, target: DeployTargetRow, signal: AbortSignal) {
    const validated = DeployTargetCreateSchema.omit({ privateKey: true }).parse({ name: target.name, host: target.host, port: target.port,
      username: target.username, hostKey: target.hostKey, basePath: target.basePath, retention: target.retention });
    if (!target.encryptedPrivateKey) throw new DomainError('domain_target_unavailable');
    const input = { basePath: validated.basePath, siteRoot: releaseRoot(validated.basePath, domain.projectId, target.id) + '/current',
      id: BuildIdSchema.parse(domain.id), hostname: DomainNameSchema.parse(domain.hostname), tlsMode: DomainTlsModeSchema.parse(domain.tlsMode), action: operation.action };
    const work = await mkdtemp(join(tmpdir(), 'forgekit-domain-'));
    let plaintext: Buffer | undefined;
    try {
      plaintext = decryptDeployKey(target.encryptedPrivateKey, this.encryptionKey, domain.projectId, target.id);
      const keyFile = join(work, 'identity'), hostsFile = join(work, 'known_hosts');
      await writeFile(keyFile, plaintext, { mode: 0o600 }); plaintext.fill(0); plaintext = undefined;
      await writeFile(hostsFile, `forgekit-target ${validated.hostKey}\n`, { mode: 0o600 });
      await boundedCommand('ssh-keygen', ['-y', '-P', '', '-f', keyFile], signal);
      const output = await boundedCommand('ssh', sshArguments(validated, keyFile, hostsFile, domainCommand(input)), signal);
      const lines = output.trim().split('\n');
      if (lines.length !== 1) throw new DomainError('domain_remote_result_invalid');
      const failure = /^B13_ERROR:(domain_[a-z_]{1,50})$/.exec(lines[0]!);
      if (failure) throw new DomainError(failure[1]);
      if (!lines[0]?.startsWith('B13_RESULT:')) throw new DomainError('domain_remote_result_invalid');
      const result: unknown = JSON.parse(lines[0].slice('B13_RESULT:'.length));
      if (operation.action === 'remove') return null;
      if (!result || typeof result !== 'object' || !('expiresAt' in result) || typeof result.expiresAt !== 'string' ||
        !('fingerprint' in result) || typeof result.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(result.fingerprint)) throw new DomainError('domain_remote_result_invalid');
      const expiresAt = new Date(result.expiresAt);
      if (!Number.isFinite(expiresAt.getTime())) throw new DomainError('domain_remote_result_invalid');
      return { expiresAt, fingerprint: result.fingerprint };
    } finally { plaintext?.fill(0); await rm(work, { recursive: true, force: true }); }
  }
}
