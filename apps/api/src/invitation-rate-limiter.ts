import { createHash } from 'node:crypto';
import { Inject, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { invitationRateBuckets } from '@forgekit/db';
import { DatabaseService } from './database.service';

type QuotaType = 'beginner-classify' | 'beginner-config-write' | 'alipay-write' | 'android-write' | 'weapp-write' | 'runtime-start' | 'runtime-poll' | 'create' | 'redeem' | 'build-trigger' | 'build-cancel' | 'preview-create' | 'preview-revoke' | 'deploy-write' | 'variable-write';
const LIMITS: Record<QuotaType, { attempts: number; windowMs: number }> = {
  'beginner-classify': { attempts: 12, windowMs: 60 * 1000 },
  'beginner-config-write': { attempts: 30, windowMs: 60 * 60 * 1000 },
  'runtime-start': { attempts: 12, windowMs: 60 * 1000 },
  'runtime-poll': { attempts: 120, windowMs: 60 * 1000 },
  'preview-create': { attempts: 30, windowMs: 60 * 60 * 1000 },
  'preview-revoke': { attempts: 60, windowMs: 60 * 60 * 1000 },
  'build-trigger': { attempts: 30, windowMs: 60 * 60 * 1000 },
  'build-cancel': { attempts: 60, windowMs: 60 * 60 * 1000 },
  'variable-write': { attempts: 60, windowMs: 60 * 60 * 1000 },
  'android-write': { attempts: 60, windowMs: 60 * 60 * 1000 },
  'alipay-write': { attempts: 60, windowMs: 60 * 60 * 1000 },
  'weapp-write': { attempts: 60, windowMs: 60 * 60 * 1000 },
  'deploy-write': { attempts: 60, windowMs: 60 * 60 * 1000 },
  create: { attempts: 10, windowMs: 60 * 60 * 1000 },
  redeem: { attempts: 30, windowMs: 15 * 60 * 1000 },
};

/** Identity fields are length-prefixed before hashing to avoid concatenation ambiguity. */
export function invitationBucketKey(type: QuotaType, issuer: string, subject: string, now = Date.now()): string {
  const window = Math.floor(now / LIMITS[type].windowMs);
  const principal = createHash('sha256').update(JSON.stringify([issuer, subject])).digest('hex');
  return `${type}:${window}:${principal}`;
}

@Injectable()
export class InvitationRateLimiter {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async consume(type: QuotaType, issuer: string, subject: string): Promise<void> {
    const key = invitationBucketKey(type, issuer, subject);
    // The unique primary key makes this counter atomic across API processes/containers.
    // Rejecting rolls back the increment; the quota remains saturated until window rollover.
    await this.database.db.transaction(async (tx) => {
      await tx.insert(invitationRateBuckets).values({ key, attempts: 1 }).onDuplicateKeyUpdate({
        set: { attempts: sql`${invitationRateBuckets.attempts} + 1` },
      });
      const [bucket] = await tx.select({ attempts: invitationRateBuckets.attempts })
        .from(invitationRateBuckets).where(eq(invitationRateBuckets.key, key)).limit(1);
      if (!bucket || bucket.attempts > LIMITS[type].attempts) {
        throw new HttpException('请求过于频繁，请稍后重试。', HttpStatus.TOO_MANY_REQUESTS);
      }
    });
  }
}
