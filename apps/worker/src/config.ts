import { validateDatabaseUrl } from '@forgekit/db';

export function redisConnection(value: string | undefined) {
  let url: URL;
  try { url = new URL(value ?? ''); } catch { throw new Error('REDIS_URL 未配置或格式无效。'); }
  if (!['redis:', 'rediss:'].includes(url.protocol) || !url.hostname || url.search || url.hash ||
      !/^\/(\d+)?$/.test(url.pathname || '/') || Number(url.port || 6379) < 1) throw new Error('REDIS_URL 格式无效。');
  return { host: url.hostname, port: Number(url.port || 6379), db: Number(url.pathname.slice(1) || 0),
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}), connectTimeout: 3000 };
}
function integer(value: string | undefined, fallback: number, max: number): number {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1 || number > max) throw new Error('Worker 数值配置超出范围。');
  return number;
}
export function resolveWorkerConfig(env: Record<string, string | undefined>) {
  return { databaseUrl: validateDatabaseUrl(env.DATABASE_URL), connection: redisConnection(env.REDIS_URL),
    concurrency: integer(env.WORKER_CONCURRENCY, 2, 32),
    timeoutMs: integer(env.BUILD_TIMEOUT_MS, 600000, 3600000),
    heartbeatMs: integer(env.WORKER_HEARTBEAT_MS, 30000, 300000) };
}
