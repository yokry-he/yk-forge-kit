import type { ServerResponse } from 'node:http';
import { Inject, Injectable, HttpException, HttpStatus, Logger, ServiceUnavailableException, type OnModuleDestroy } from '@nestjs/common';
import { WeappLogRepository } from '@forgekit/db';
import type { WeappJob, BuildStreamError } from '@forgekit/contracts';
import { DatabaseService } from './database.service';
import { WeappService } from './weapp.service';
import type { WeappStreamIdentity } from './weapp-stream-tickets';

const active = (job: WeappJob) => job.status === 'queued' || job.status === 'running';
@Injectable()
export class WeappStreamsService implements OnModuleDestroy {
  private readonly logger = new Logger(WeappStreamsService.name);
  private readonly connections = new Map<ServerResponse, AbortController>();
  private readonly principals = new Map<string, number>();
  constructor(@Inject(WeappService) private readonly weapp: WeappService,
    @Inject(DatabaseService) private readonly database: DatabaseService) {}

  async open(identity: WeappStreamIdentity, cursor: number, response: ServerResponse): Promise<void> {
    const { projectId, jobId, auth, expires } = identity;
    const principal = auth.mode === 'local' ? 'local' : JSON.stringify([auth.issuer, auth.subject]);
    // Reserve before any await so concurrent handshakes cannot bypass limits.
    const count = this.principals.get(principal) ?? 0;
    if (this.connections.size >= 100 || count >= 4) throw new HttpException('日志连接过多，请稍后重试。', HttpStatus.TOO_MANY_REQUESTS);
    const abort = new AbortController();
    this.connections.set(response, abort); this.principals.set(principal, count + 1);
    const close = () => abort.abort();
    response.on('close', close); response.on('error', close);
    const wait = (ms: number) => new Promise<void>((resolve) => {
      if (abort.signal.aborted) return resolve();
      const done = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, ms);
      abort.signal.addEventListener('abort', done, { once: true });
    });
    const write = async (frame: string) => {
      if (abort.signal.aborted) throw new Error('closed');
      if (response.write(frame)) return;
      await new Promise<void>((resolve, reject) => {
        const clean = () => { clearTimeout(timer); response.off('drain', drain); abort.signal.removeEventListener('abort', stopped); };
        const drain = () => { clean(); resolve(); };
        const stopped = () => { clean(); reject(new Error('closed')); };
        const timer = setTimeout(() => { clean(); reject(new Error('slow_reader')); }, 5000);
        response.once('drain', drain); abort.signal.addEventListener('abort', stopped, { once: true });
      });
    };
    const send = (event: string, data: unknown, id?: number) => write(`event: ${event}\n${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(data)}\n\n`);
    const fail = (code: BuildStreamError['code'], message: string) => send('stream-error', { code, message });
    try {
      let job = await this.weapp.get(projectId, jobId, auth);
      if (abort.signal.aborted) return;
      const logs = new WeappLogRepository(this.database.db);
      let high: number | undefined = active(job) ? undefined : await logs.highestSeq(jobId);
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
      response.flushHeaders();
      await send('status', { job });
      let sentStatus = job.status;
      let checked = Date.now(), heartbeat = checked, frames = 0;
      const refresh = async () => {
        job = await this.weapp.get(projectId, jobId, auth);
        checked = Date.now();
        if (!active(job) && high === undefined) high = await logs.highestSeq(jobId);
        if (job.status !== sentStatus && active(job)) { await send('status', { job }); sentStatus = job.status; }
      };
      while (!abort.signal.aborted) {
        if (Date.now() >= expires) { await fail('ticket_expired', '日志连接凭证已到期。'); break; }
        if (Date.now() - checked >= 15_000) await refresh();
        // Terminal is immutable. Capture H once; future system appends belong to a new connection.
        if (!active(job) && high === undefined) high = await logs.highestSeq(jobId);
        const batch = await logs.listSince(jobId, cursor, 500);
        for (const row of batch) {
          if (high !== undefined && row.seq > high) break;
          if (Date.now() - checked >= 15_000) {
            await refresh();
          }
          if (Date.now() - heartbeat >= 15_000) { await write(': heartbeat\n\n'); heartbeat = Date.now(); }
          if (++frames > 10_000) throw new Error('connection_frame_limit');
          if (Date.now() >= expires) { await fail('ticket_expired', '日志连接凭证已到期。'); return; }
          await send('log', { seq: row.seq, stream: row.stream, content: row.content, ts: row.ts.toISOString() }, row.seq);
          cursor = row.seq;
        }
        if (Date.now() >= expires) { await fail('ticket_expired', '日志连接凭证已到期。'); break; }
        if (high !== undefined && cursor >= high) {
          await send('status', { job });
          await send('end', { jobId, status: job.status, lastSeq: high }); break;
        }
        if (Date.now() - heartbeat >= 15_000) { await write(': heartbeat\n\n'); heartbeat = Date.now(); }
        if (batch.length < 500) {
          await wait(500);
          if (abort.signal.aborted) break;
          // Recheck membership before exposing the next status, even between periodic checks.
          await refresh();
        }
      }
    } catch (error) {
      if (!response.headersSent) {
        if (error instanceof HttpException) throw error;
        throw new ServiceUnavailableException('日志服务暂不可用。');
      }
      if (!abort.signal.aborted) {
        this.logger.warn('日志流中断（访问撤销、读取失败或慢连接），连接已关闭。');
        const revoked = error instanceof HttpException && [401, 403, 404].includes(error.getStatus());
        // A stalled reader must not accumulate an additional error frame.
        if (response.writableNeedDrain) response.destroy();
        else await fail(revoked ? 'access_revoked' : 'unavailable', revoked ? '项目访问权限已撤销。' : '日志服务暂不可用。').catch(() => response.destroy());
      }
    } finally {
      abort.abort(); response.off('close', close); response.off('error', close);
      this.connections.delete(response);
      const remaining = (this.principals.get(principal) ?? 1) - 1;
      if (remaining) this.principals.set(principal, remaining); else this.principals.delete(principal);
      if (response.headersSent && !response.destroyed) response.end();
    }
  }
  onModuleDestroy(): void {
    for (const [response, abort] of this.connections) { abort.abort(); response.destroy(); }
  }
}
