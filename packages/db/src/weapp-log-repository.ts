import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { WeappLogEventSchema, type WeappLogEvent } from '@forgekit/contracts';
import type { DatabaseClient } from './index';
import { weappLogChunks, weappJobs } from './schema';
import { WeappConflictError } from './weapp-repository';
type Database = DatabaseClient['db'];
export class WeappLogRepository {
  constructor(private readonly db: Database) {}
  async append(input: Omit<WeappLogEvent, 'seq' | 'ts'>) {
    const row = { ...input, ts: new Date(), seq: 1 };
    WeappLogEventSchema.parse({ ...row, ts: row.ts.toISOString() });
    return this.db.transaction(async tx => {
      const [job] = await tx.select({ id: weappJobs.id }).from(weappJobs).where(eq(weappJobs.id, input.jobId)).for('update');
      if (!job) throw new WeappConflictError();
      const [last] = await tx.select({ seq: weappLogChunks.seq }).from(weappLogChunks).where(eq(weappLogChunks.jobId, input.jobId)).orderBy(desc(weappLogChunks.seq)).limit(1).for('update');
      row.seq = (last?.seq ?? 0) + 1;
      if (row.seq > 4294967295) throw new RangeError('weapp_log_sequence_exhausted');
      await tx.insert(weappLogChunks).values(row); return row;
    }, { isolationLevel: 'read committed' });
  }
  async highestSeq(jobId: string) {
    const [row] = await this.db.select({ seq: weappLogChunks.seq }).from(weappLogChunks).where(eq(weappLogChunks.jobId, jobId)).orderBy(desc(weappLogChunks.seq)).limit(1);
    return row?.seq ?? 0;
  }
  listSince(jobId: string, seq = 0, limit = 500) {
    if (!Number.isInteger(seq) || seq < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('invalid_weapp_log_cursor');
    return this.db.select().from(weappLogChunks).where(and(eq(weappLogChunks.jobId, jobId), gt(weappLogChunks.seq, seq)))
      .orderBy(asc(weappLogChunks.seq)).limit(limit);
  }
}
