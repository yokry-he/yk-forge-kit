import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { DomainLogEventSchema, type DomainLogEvent } from '@forgekit/contracts';
import type { DatabaseClient } from './index';
import { domainLogChunks, domainOperations } from './schema';
import { DeployNotFoundError } from './deploy-repository';
type Database = DatabaseClient['db'];
export class DomainLogRepository {
  constructor(private readonly db: Database) {}
  async append(input: Omit<DomainLogEvent, 'seq' | 'ts'>) {
    const row = { ...input, ts: new Date(), seq: 1 };
    DomainLogEventSchema.parse({ ...row, ts: row.ts.toISOString() });
    return this.db.transaction(async tx => {
      const [operation] = await tx.select({ id: domainOperations.id }).from(domainOperations).where(eq(domainOperations.id, input.operationId)).for('update');
      if (!operation) throw new DeployNotFoundError();
      const [last] = await tx.select({ seq: domainLogChunks.seq }).from(domainLogChunks).where(eq(domainLogChunks.operationId, input.operationId)).orderBy(desc(domainLogChunks.seq)).limit(1).for('update');
      row.seq = (last?.seq ?? 0) + 1;
      if (row.seq > 4294967295) throw new RangeError('domain_log_sequence_exhausted');
      await tx.insert(domainLogChunks).values(row); return row;
    }, { isolationLevel: 'read committed' });
  }
  async highestSeq(operationId: string) {
    const [row] = await this.db.select({ seq: domainLogChunks.seq }).from(domainLogChunks).where(eq(domainLogChunks.operationId, operationId)).orderBy(desc(domainLogChunks.seq)).limit(1);
    return row?.seq ?? 0;
  }
  listSince(operationId: string, seq = 0, limit = 500) {
    if (!Number.isInteger(seq) || seq < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('invalid_domain_log_cursor');
    return this.db.select().from(domainLogChunks).where(and(eq(domainLogChunks.operationId, operationId), gt(domainLogChunks.seq, seq)))
      .orderBy(asc(domainLogChunks.seq)).limit(limit);
  }
}
