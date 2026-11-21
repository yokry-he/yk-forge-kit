import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { Inject, Injectable, HttpException, HttpStatus, Logger, ServiceUnavailableException, type OnModuleDestroy } from '@nestjs/common';
import { RuntimeLogRepository } from '@forgekit/db';
import type { RuntimeLogSession, BuildStreamError } from '@forgekit/contracts';
import { DatabaseService } from './database.service';
import { RuntimeLogsService } from './runtime-logs.service';
import type { RuntimeStreamIdentity } from './runtime-stream-tickets';

const active = (session: RuntimeLogSession) => session.status === 'pending' || session.status === 'running';
@Injectable()
export class RuntimeStreamsService implements OnModuleDestroy {
  private readonly logger = new Logger(RuntimeStreamsService.name);
  private readonly connections = new Map<ServerResponse, AbortController>();
  private readonly principals = new Map<string, number>();
  constructor(@Inject(RuntimeLogsService) private readonly sessions: RuntimeLogsService,
    @Inject(DatabaseService) private readonly database: DatabaseService) {}

  async open(identity: RuntimeStreamIdentity, cursor: number, response: ServerResponse): Promise<void> {
    const { projectId, sessionId, auth, expires } = identity;
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
    const leaseOwner = randomUUID();
    const repository = new RuntimeLogRepository(this.database.db);
    let attached = false;
    try {
      let session = await this.sessions.get(projectId, sessionId, auth);
      if (abort.signal.aborted) return;
      attached = await repository.attach(sessionId, leaseOwner);
      if (!attached) throw new HttpException('此会话已有日志连接。', HttpStatus.TOO_MANY_REQUESTS);
      const logs = repository;
      let high: number | undefined = active(session) ? undefined : await logs.highestSeq(sessionId);
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
      response.flushHeaders();
      await send('status', { session });
      let sentStatus = session.status;
      let checked = Date.now(), heartbeat = checked, frames = 0;
      const refresh = async () => {
        session = await this.sessions.get(projectId, sessionId, auth);
        await repository.touch(sessionId, leaseOwner);
        checked = Date.now();
        if (!active(session) && high === undefined) high = await logs.highestSeq(sessionId);
        if (session.status !== sentStatus && active(session)) { await send('status', { session }); sentStatus = session.status; }
      };
      while (!abort.signal.aborted) {
        if (Date.now() >= expires) { await fail('ticket_expired', '日志连接凭证已到期。'); break; }
        if (Date.now() - checked >= 1000) await refresh();
        // Terminal is immutable. Capture H once; future system appends belong to a new connection.
        if (!active(session) && high === undefined) high = await logs.highestSeq(sessionId);
        const batch = await logs.listSince(sessionId, cursor, 500);
        for (const row of batch) {
          if (high !== undefined && row.seq > high) break;
          if (Date.now() - checked >= 1000) {
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
          await send('status', { session });
          await send('end', { sessionId, status: session.status, lastSeq: high }); break;
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
      if (attached) await repository.detach(sessionId, leaseOwner).catch(() => this.logger.warn('运行日志会话清理失败，将按租约超时结束。'));
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
