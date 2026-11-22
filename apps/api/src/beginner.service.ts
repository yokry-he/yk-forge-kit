import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { BeginnerSuggestionSchema, type BeginnerConfigInput, type BeginnerConfigMetadata, type BeginnerResult } from '@forgekit/contracts';
import { BeginnerKeyRequiredError, BeginnerRepository, deployEncryptionKey, encryptBeginnerKey, decryptBeginnerKey, type BeginnerConfigRow } from '@forgekit/db';
import { DatabaseService } from './database.service';
import { IdentityAccountsService } from './identity-accounts.service';
import { InvitationRateLimiter } from './invitation-rate-limiter';
import type { ProjectAuthContext } from './project-auth-context';
import { classifyKeywords, compatibleSuggestion } from './beginner-classifier';
import { BeginnerAiClient, BEGINNER_AI_TIMEOUT_MS } from './beginner-ai';

@Injectable()
export class BeginnerService {
  private readonly logger = new Logger(BeginnerService.name);
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityAccountsService) private readonly identities: IdentityAccountsService,
    @Inject(InvitationRateLimiter) private readonly limiter: InvitationRateLimiter,
    @Inject(BeginnerAiClient) private readonly ai: BeginnerAiClient) {}
  private get repository() { return new BeginnerRepository(this.database.db); }
  private async actor(auth: ProjectAuthContext, quota?: 'beginner-classify' | 'beginner-config-write') {
    if (auth.mode !== 'oidc') throw new ForbiddenException('新手模式需要已验证的 OIDC 身份。');
    if (quota) await this.limiter.consume(quota, auth.issuer, auth.subject);
    try { return await this.identities.ensureUser(auth); }
    catch { throw new ServiceUnavailableException('新手模式账户暂不可用。'); }
  }
  async config(auth: ProjectAuthContext): Promise<BeginnerConfigMetadata> {
    const userId = await this.actor(auth);
    try { return metadata(await this.repository.config(userId)); }
    catch { throw new ServiceUnavailableException('AI 配置读取失败，请稍后重试。'); }
  }
  async save(input: BeginnerConfigInput, auth: ProjectAuthContext): Promise<BeginnerConfigMetadata> {
    const userId = await this.actor(auth, 'beginner-config-write');
    let key: Buffer | undefined;
    try {
      let encrypted: string | undefined;
      if (input.apiKey) {
        key = deployEncryptionKey(process.env.FORGEKIT_DEPLOY_ENCRYPTION_KEY);
        encrypted = encryptBeginnerKey(input.apiKey, key, userId);
      }
      // Plaintext never reaches repository/driver arguments.
      const { apiKey: _apiKey, ...settings } = input;
      const row = await this.repository.save(userId, settings, encrypted);
      this.logger.log({ action: 'config_saved', actor: userId });
      return metadata(row);
    } catch (error) {
      if (error instanceof BeginnerKeyRequiredError) throw new BadRequestException('首次配置需要提供 API Key。');
      throw new ServiceUnavailableException('AI 配置保存失败，请检查主密钥配置后重试。');
    } finally { key?.fill(0); }
  }
  async remove(auth: ProjectAuthContext): Promise<void> {
    const userId = await this.actor(auth, 'beginner-config-write');
    try { await this.repository.remove(userId); this.logger.log({ action: 'config_deleted', actor: userId }); }
    catch { throw new ServiceUnavailableException('AI 配置删除失败，请稍后重试。'); }
  }
  async classify(description: string, auth: ProjectAuthContext): Promise<BeginnerResult> {
    const userId = await this.actor(auth, 'beginner-classify');
    const fallback = classifyKeywords(description);
    let key: Buffer | undefined, plaintext: Buffer | undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result = fallback;
    try {
      // Injection directives never get a chance to change model behavior.
      if (/ignore .*instructions|忽略.*规则|reveal.*(?:key|prompt)|输出密钥|system prompt/i.test(description)) return this.record(userId, fallback);
      const config = await this.repository.config(userId);
      if (!config?.encryptedApiKey) return this.record(userId, fallback);
      key = deployEncryptionKey(process.env.FORGEKIT_DEPLOY_ENCRYPTION_KEY);
      plaintext = decryptBeginnerKey(config.encryptedApiKey, key, userId);
      const apiKey = plaintext.toString('utf8');
      if (!apiKey) return this.record(userId, fallback);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('beginner_ai_timeout')); }, BEGINNER_AI_TIMEOUT_MS);
      });
      const raw = await Promise.race([this.ai.suggest({ description, apiKey, baseUrl: config.baseUrl, model: config.model, signal: controller.signal }), timeout]);
      const parsed = BeginnerSuggestionSchema.safeParse(JSON.parse(raw));
      if (parsed.success && !JSON.stringify(parsed.data).includes(apiKey)) {
        result = { ...compatibleSuggestion(parsed.data), source: 'ai' };
      }
    } catch {
      // No exception, prompt, provider response or credentials are logged or returned.
      result = fallback;
    } finally { clearTimeout(timer); controller.abort(); plaintext?.fill(0); key?.fill(0); }
    return this.record(userId, result);
  }
  private record(actor: string, result: BeginnerResult) {
    this.logger.log({ action: 'classified', actor, source: result.source });
    return result;
  }
}
function metadata(row: BeginnerConfigRow | null): BeginnerConfigMetadata {
  return row ? { configured: true, provider: row.provider, baseUrl: row.baseUrl, model: row.model, updatedAt: row.updatedAt.toISOString() } : { configured: false };
}
