import { eq } from 'drizzle-orm';
import { beginnerCredentialDestination, type BeginnerConfigInput } from '@forgekit/contracts';
import type { DatabaseClient } from './index';
import { beginnerAiConfigs, users } from './schema';
export type BeginnerConfigRow = typeof beginnerAiConfigs.$inferSelect;
export class BeginnerKeyRequiredError extends Error {}
export class BeginnerRepository {
  constructor(private readonly db: DatabaseClient['db']) {}
  async config(userId: string): Promise<BeginnerConfigRow | null> {
    const [row] = await this.db.select().from(beginnerAiConfigs).where(eq(beginnerAiConfigs.userId, userId)).limit(1);
    return row ?? null;
  }
  async save(userId: string, input: BeginnerConfigInput, encryptedApiKey?: string): Promise<BeginnerConfigRow> {
    return this.db.transaction(async tx => {
      // Serialize replacement/keep/delete on the user row, including first-time inserts.
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      const [existing] = await tx.select().from(beginnerAiConfigs).where(eq(beginnerAiConfigs.userId, userId));
      if (!encryptedApiKey && existing && beginnerCredentialDestination(existing) !== beginnerCredentialDestination(input)) throw new BeginnerKeyRequiredError();
      const key = encryptedApiKey ?? existing?.encryptedApiKey;
      if (!key) throw new BeginnerKeyRequiredError();
      const row: BeginnerConfigRow = { userId, provider: input.provider, baseUrl: input.baseUrl.replace(/\/+$/, ''),
        model: input.model, encryptedApiKey: key, updatedAt: new Date() };
      await tx.insert(beginnerAiConfigs).values(row).onDuplicateKeyUpdate({ set: row });
      return row;
    }, { isolationLevel: 'read committed' });
  }
  async remove(userId: string): Promise<void> {
    await this.db.transaction(async tx => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      await tx.delete(beginnerAiConfigs).where(eq(beginnerAiConfigs.userId, userId));
    });
  }
}
