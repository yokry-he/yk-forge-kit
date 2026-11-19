import { randomUUID } from 'node:crypto';
import { Inject, BadRequestException, ConflictException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { externalIdentities, users } from '@forgekit/db';
import { DatabaseService } from './database.service';
import type { ProjectAuthContext } from './project-auth-context';

type OidcAuth = Extract<ProjectAuthContext, { mode: 'oidc' }>;

/** OIDC subjects are case-sensitive even if MySQL's default collation isn't. */
export function identityMatches(auth: OidcAuth) {
  return and(sql`BINARY ${externalIdentities.issuer} = BINARY ${auth.issuer}`,
    sql`BINARY ${externalIdentities.subject} = BINARY ${auth.subject}`);
}

/** Account display names are metadata, never trusted as OIDC identity claims. */
export function parseDisplayName(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).length !== 1 || !('displayName' in body) || typeof body.displayName !== 'string') {
    throw new BadRequestException('只能提交 displayName 字符串。');
  }
  const name = body.displayName.normalize('NFC').trim();
  if (!name || Array.from(name).length > 60 || /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(name)) {
    throw new BadRequestException('展示名须为 1–60 个字符，不得包含控制字符或双向控制符。');
  }
  return name;
}

function hasMysqlCode(error: unknown, code: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; cause?: unknown };
  return value.code === code || (value.cause !== error && hasMysqlCode(value.cause, code));
}

@Injectable()
export class IdentityAccountsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async findUserId(auth: OidcAuth): Promise<string | null> {
    const [identity] = await this.database.db.select({ userId: externalIdentities.userId })
      .from(externalIdentities).where(identityMatches(auth)).limit(1);
    return identity?.userId ?? null;
  }

  async ensureUser(auth: OidcAuth): Promise<string> {
    const existing = await this.findUserId(auth);
    if (existing) return existing;
    const userId = randomUUID();
    try {
      await this.database.db.transaction(async (tx) => {
        await tx.insert(users).values({ id: userId, displayName: 'YKForgeKit 用户' });
        await tx.insert(externalIdentities).values({ userId, issuer: auth.issuer, subject: auth.subject });
      });
      return userId;
    } catch (error) {
      if (!hasMysqlCode(error, 'ER_DUP_ENTRY')) throw error;
      const concurrent = await this.findUserId(auth);
      if (concurrent) return concurrent;
      // Do not merge subjects whose only similarity comes from case folding.
      throw new ConflictException('身份标识冲突，请联系管理员检查数据库排序规则。');
    }
  }

  async getProfile(auth: OidcAuth) {
    const [profile] = await this.database.db.select({ id: users.id, displayName: users.displayName, createdAt: users.createdAt })
      .from(users).innerJoin(externalIdentities, eq(externalIdentities.userId, users.id))
      .where(identityMatches(auth)).limit(1);
    return profile ?? null;
  }

  /** Only a successfully verified bearer token can create a provider-neutral account. */
  async initializeAccount(auth: OidcAuth) {
    await this.ensureUser(auth);
    const profile = await this.getProfile(auth);
    if (!profile) throw new InternalServerErrorException('账户初始化后未能读取用户档案。');
    return profile;
  }

  async updateDisplayName(auth: OidcAuth, displayName: string) {
    const id = await this.findUserId(auth);
    if (!id) throw new NotFoundException('请先初始化 YKForgeKit 账户。');
    await this.database.db.update(users).set({ displayName }).where(eq(users.id, id));
    const profile = await this.getProfile(auth);
    if (!profile) throw new InternalServerErrorException('更新后无法读取账户档案。');
    return profile;
  }
}
