import { ForbiddenException, Inject, Injectable, NotFoundException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { EnvironmentVariableSchema, type VariableInput } from '@forgekit/contracts';
import { EnvironmentVariableRepository, VariableNotFoundError, VariableLimitError, deployEncryptionKey, encryptVariable, type VariableRow } from '@forgekit/db';
import { DatabaseService } from './database.service';
import { ProjectsService } from './projects.service';
import { InvitationRateLimiter } from './invitation-rate-limiter';
import type { ProjectAuthContext } from './project-auth-context';

@Injectable()
export class EnvironmentVariablesService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(InvitationRateLimiter) private readonly limiter: InvitationRateLimiter) {}
  private get repository() { return new EnvironmentVariableRepository(this.database.db); }
  private async authorize(projectId: string, auth: ProjectAuthContext, write = false) {
    if (auth.mode !== 'oidc') throw new ForbiddenException('环境变量需要已验证的 OIDC 项目成员身份。');
    await this.projects.findById(projectId, auth, write ? 'variable:manage' : 'variable:read');
    const actor = await this.projects.findUserId(auth);
    if (!actor) throw new ForbiddenException('项目成员身份不存在。');
    if (write) await this.limiter.consume('variable-write', auth.issuer, auth.subject);
    return actor;
  }
  async environments(projectId: string, auth: ProjectAuthContext) {
    await this.authorize(projectId, auth);
    const rows = await this.repository.environments(projectId);
    return [...new Set(['preview', 'production', ...rows.map(row => row.name)])].map(name => ({ name }));
  }
  async list(projectId: string, environment: string, auth: ProjectAuthContext) {
    await this.authorize(projectId, auth);
    return (await this.repository.list(projectId, environment)).map(serializeVariable);
  }
  async get(projectId: string, environment: string, name: string, auth: ProjectAuthContext) {
    const row = (await this.list(projectId, environment, auth)).find(row => row.name === name);
    if (!row) throw new NotFoundException('环境变量不存在。');
    return row;
  }
  async save(projectId: string, environment: string, name: string, input: VariableInput, auth: ProjectAuthContext) {
    const actor = await this.authorize(projectId, auth, true);
    let key: Buffer | undefined;
    try {
      if (input.kind === 'secret') {
        try { key = deployEncryptionKey(process.env.FORGEKIT_DEPLOY_ENCRYPTION_KEY); }
        catch { throw new ServiceUnavailableException('秘密值加密尚未配置。'); }
      }
      const row = await this.repository.save(projectId, environment, name, input, actor,
        (value, environmentId) => encryptVariable(value, key!, projectId, environmentId, name));
      return serializeVariable(row);
    } catch (error) { throw variableHttpError(error); }
    finally { key?.fill(0); }
  }
  async remove(projectId: string, environment: string, name: string, auth: ProjectAuthContext) {
    const actor = await this.authorize(projectId, auth, true);
    try { await this.repository.remove(projectId, environment, name, actor); }
    catch (error) { throw variableHttpError(error); }
  }
}
function variableHttpError(error: unknown) {
  if (error instanceof VariableNotFoundError) return new NotFoundException('环境变量不存在。');
  if (error instanceof VariableLimitError) return new ConflictException('每项目最多 100 个环境，每环境最多 100 个变量。');
  // Never return DB driver errors, SQL parameters, plaintext, ciphertext or crypto errors.
  if (error instanceof ServiceUnavailableException) return error;
  return new ServiceUnavailableException('环境变量操作失败，请稍后重试。');
}
export function serializeVariable(row: VariableRow) {
  return EnvironmentVariableSchema.parse({ name: row.name, kind: row.kind,
    ...(row.kind === 'plain' ? { value: row.plainValue ?? '' } : {}),
    updatedAt: row.updatedAt.toISOString(), updatedBy: row.updatedBy });
}
