import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { AndroidLogEventSchema, type AndroidLogEvent } from '@forgekit/contracts';
import type { DatabaseClient } from './index';
import { androidLogChunks, androidJobs } from './schema';
import { AndroidConflictError } from './android-repository';
type Database = DatabaseClient['db'];
export class AndroidLogRepository {
  constructor(private readonly db: Database) {}
  async append(input: Omit<AndroidLogEvent, 'seq' | 'ts'>) {
    const row = { ...input, ts: new Date(), seq: 1 };
    AndroidLogEventSchema.parse({ ...row, ts: row.ts.toISOString() });
    return this.db.transaction(async tx => {
      const [job] = await tx.select({ id: androidJobs.id }).from(androidJobs).where(eq(androidJobs.id, input.jobId)).for('update');
      if (!job) throw new AndroidConflictError();
      const [last] = await tx.select({ seq: androidLogChunks.seq }).from(androidLogChunks).where(eq(androidLogChunks.jobId, input.jobId)).orderBy(desc(androidLogChunks.seq)).limit(1).for('update');
      row.seq = (last?.seq ?? 0) + 1;
      if (row.seq > 4294967295) throw new RangeError('android_log_sequence_exhausted');
      await tx.insert(androidLogChunks).values(row); return row;
    }, { isolationLevel: 'read committed' });
  }
  async highestSeq(jobId: string) {
    const [row] = await this.db.select({ seq: androidLogChunks.seq }).from(androidLogChunks).where(eq(androidLogChunks.jobId, jobId)).orderBy(desc(androidLogChunks.seq)).limit(1);
    return row?.seq ?? 0;
  }
  listSince(jobId: string, seq = 0, limit = 500) {
    if (!Number.isInteger(seq) || seq < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('invalid_android_log_cursor');
    return this.db.select().from(androidLogChunks).where(and(eq(androidLogChunks.jobId, jobId), gt(androidLogChunks.seq, seq)))
      .orderBy(asc(androidLogChunks.seq)).limit(limit);
  }
}
