import { DomainJobPayloadSchema } from '@forgekit/contracts';
import { DomainClaimError, type DomainRepository, type DomainLogRepository, type DeployRepository, type DomainRow } from '@forgekit/db';
import { DomainError, type DomainDnsVerifier } from './domain-dns';
import type { DomainHost } from './domain-ssh';
import { SshDeployError } from './ssh-command';
const safeCodes = new Set(['domain_dns_unavailable', 'domain_target_unavailable', 'domain_host_not_prepared', 'domain_host_limit',
  'domain_reload_failed', 'domain_config_invalid', 'domain_certificate_timeout', 'domain_certificate_expired', 'domain_certificate_invalid',
  'domain_health_failed', 'domain_release_missing', 'domain_rollback_failed', 'domain_not_configured', 'domain_host_claim_conflict',
  'domain_remote_result_invalid', 'ssh_host_key_mismatch', 'ssh_auth_failed', 'ssh_command_failed', 'ssh_process_unavailable', 'ssh_output_limit']);
export class DomainProcessor {
  private stopping = false;
  private readonly active = new Set<AbortController>();
  constructor(private readonly domains: Pick<DomainRepository, 'operation' | 'get' | 'start' | 'claim' | 'update' | 'finish'>,
    private readonly targets: Pick<DeployRepository, 'target'>, private readonly logs: Pick<DomainLogRepository, 'append'>,
    private readonly dns: DomainDnsVerifier, private readonly host: DomainHost) {}
  shutdown() { this.stopping = true; for (const abort of this.active) abort.abort(); }
  async process(payload: unknown, jobId?: string) {
    if (this.stopping) throw new Error('domain_worker_stopping');
    const { operationId } = DomainJobPayloadSchema.parse(payload);
    if (jobId !== operationId) throw new Error('domain_job_id_invalid');
    const op = await this.domains.operation(operationId);
    if (!op || op.status !== 'pending' || !await this.domains.start(op.id)) return;
    const abort = new AbortController(); this.active.add(abort);
    const timer = setTimeout(() => abort.abort(), 270000);
    let domain: DomainRow | null = null;
    let bytes = 0;
    const log = async (content: string) => {
      bytes += Buffer.byteLength(content);
      if (bytes > 65536) throw new Error('domain_log_limit');
      await this.logs.append({ operationId, stream: 'system', content });
    };
    try {
      if (this.stopping) abort.abort();
      abort.signal.throwIfAborted();
      domain = await this.domains.get(op.domainId);
      const target = await this.targets.target(op.projectId, op.deployTargetId);
      if (!domain || domain.projectId !== op.projectId || domain.deployTargetId !== op.deployTargetId || domain.status === 'revoked' ||
        !target || target.disabledAt || !target.currentReleaseId || !target.host) throw new DomainError('domain_target_unavailable');
      if (op.action === 'remove' && !domain.verifiedAt) {
        await log('未验证域名从未写入远端配置，绑定记录已移除。\n');
        await this.domains.finish(op.id, 'succeeded', { status: 'revoked', lastCheckedAt: new Date(), errorCode: null });
        return;
      }
      if (op.action === 'verify') {
        await this.domains.update(domain.id, { status: 'verifying', errorCode: null });
        await log('正在验证域名 A/AAAA 指向及 TXT 所有权记录。\n');
        if (!await this.dns.verify(domain.hostname, target.host, domain.verificationToken)) {
          await log('DNS 尚未满足要求，请核对所有 A/AAAA 与 TXT 记录后重试。\n');
          await this.domains.finish(op.id, 'failed', { status: domain.verifiedAt ? (domain.status === 'active' || domain.status === 'expired' ? domain.status : 'failed') : 'pending_dns', lastCheckedAt: new Date(), errorCode: 'domain_dns_pending' }, 'domain_dns_pending');
          return;
        }
        abort.signal.throwIfAborted();
        await this.domains.claim(domain);
        await log('域名所有权已验证，正在校验配置并等待自动签发证书；证书就绪后才启用路由。\n');
      } else await log(op.action === 'remove' ? '正在安全移除域名路由及自动证书策略。\n' : '正在检查主机 HTTPS 服务及自动续期后的证书。\n');
      const cert = await this.host.run(domain, op, target, abort.signal);
      abort.signal.throwIfAborted();
      if (op.action !== 'remove' && !cert) throw new DomainError('domain_remote_result_invalid');
      const expired = !!cert && cert.expiresAt.getTime() <= Date.now();
      await log(op.action === 'remove' ? '域名已停用；主机证书缓存保留，不执行 CA 吊销。\n' : expired ? '证书已到期，请检查主机自动续期。\n' : 'HTTPS 检查完成，证书到期时间及指纹已刷新。\n');
      await this.domains.finish(op.id, 'succeeded', { status: op.action === 'remove' ? 'revoked' : expired ? 'expired' : 'active',
        ...(cert ? { certificateExpiresAt: cert.expiresAt, certificateFingerprint: cert.fingerprint } : {}), lastCheckedAt: new Date(), errorCode: null });
    } catch (error) {
      const code = abort.signal.aborted ? 'domain_timeout_or_shutdown' : error instanceof DomainClaimError ? 'domain_already_claimed' :
        (error instanceof DomainError || error instanceof SshDeployError) && safeCodes.has(error.message) ? error.message : 'domain_execution_failed';
      await log(`域名操作失败：${code}。请核对 DNS、主机及上一次配置后重试。\n`);
      await this.domains.finish(op.id, 'failed', { status: domain?.certificateExpiresAt && domain.certificateExpiresAt.getTime() <= Date.now() ? 'expired' :
        op.action !== 'refresh' && domain?.status === 'active' && ['domain_config_invalid', 'domain_reload_failed', 'domain_certificate_timeout', 'domain_certificate_invalid',
          'domain_health_failed', 'domain_release_missing', 'domain_host_claim_conflict', 'domain_dns_unavailable', 'domain_already_claimed'].includes(code) ? 'active' : 'failed', errorCode: code, lastCheckedAt: new Date() }, code);
    } finally { clearTimeout(timer); this.active.delete(abort); }
  }
}
