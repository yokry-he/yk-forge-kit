import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { AlipayLogEventSchema, type AlipayLogEvent } from '@forgekit/contracts';
import type { DatabaseClient } from './index';
import { alipayLogChunks, alipayJobs } from './schema';
import { AlipayConflictError } from './alipay-repository';
type Database = DatabaseClient['db'];
export class AlipayLogRepository {
  constructor(private readonly db: Database) {}
  async append(input: Omit<AlipayLogEvent, 'seq' | 'ts'>) {
    const row = { ...input, ts: new Date(), seq: 1 };
    AlipayLogEventSchema.parse({ ...row, ts: row.ts.toISOString() });
    return this.db.transaction(async tx => {
      const [job] = await tx.select({ id: alipayJobs.id }).from(alipayJobs).where(eq(alipayJobs.id, input.jobId)).for('update');
      if (!job) throw new AlipayConflictError();
      const [last] = await tx.select({ seq: alipayLogChunks.seq }).from(alipayLogChunks).where(eq(alipayLogChunks.jobId, input.jobId)).orderBy(desc(alipayLogChunks.seq)).limit(1).for('update');
      row.seq = (last?.seq ?? 0) + 1;
      if (row.seq > 4294967295) throw new RangeError('alipay_log_sequence_exhausted');
      await tx.insert(alipayLogChunks).values(row); return row;
    }, { isolationLevel: 'read committed' });
  }
  async highestSeq(jobId: string) {
    const [row] = await this.db.select({ seq: alipayLogChunks.seq }).from(alipayLogChunks).where(eq(alipayLogChunks.jobId, jobId)).orderBy(desc(alipayLogChunks.seq)).limit(1);
    return row?.seq ?? 0;
  }
  listSince(jobId: string, seq = 0, limit = 500) {
    if (!Number.isInteger(seq) || seq < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('invalid_alipay_log_cursor');
    return this.db.select().from(alipayLogChunks).where(and(eq(alipayLogChunks.jobId, jobId), gt(alipayLogChunks.seq, seq)))
      .orderBy(asc(alipayLogChunks.seq)).limit(limit);
  }
}
