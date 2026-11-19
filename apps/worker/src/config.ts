import { validateDatabaseUrl } from '@forgekit/db';
import { isAbsolute } from 'node:path';
import type { DockerRunnerOptions } from './docker-runner';

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
  const runner = env.FORGEKIT_BUILD_RUNNER ?? 'noop';
  if (runner !== 'noop' && runner !== 'docker') throw new Error('FORGEKIT_BUILD_RUNNER 必须为 noop/docker。');
  const timeoutMs = integer(env.BUILD_TIMEOUT_MS, 600000, 3600000);
  return { databaseUrl: validateDatabaseUrl(env.DATABASE_URL), connection: redisConnection(env.REDIS_URL),
    concurrency: integer(env.WORKER_CONCURRENCY, 2, 32),
    timeoutMs, runner,
    docker: runner === 'docker' ? resolveDockerConfig(env, timeoutMs) : undefined,
    heartbeatMs: integer(env.WORKER_HEARTBEAT_MS, 30000, 300000) };
}

export function resolveDockerConfig(env: Record<string, string | undefined>, timeoutMs = 600000): DockerRunnerOptions & { artifactDir: string; maxArtifactBytes: number } {
  const image = env.FORGEKIT_BUILD_IMAGE ?? 'node:22';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,254}$/.test(image)) throw new Error('构建镜像格式无效。');
  const runtime = env.FORGEKIT_BUILD_RUNTIME;
  if (runtime !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(runtime)) throw new Error('构建 runtime 无效。');
  const installNetwork = env.FORGEKIT_BUILD_INSTALL_NETWORK ?? 'none';
  if (!['none', 'outbound', 'registry'].includes(installNetwork)) throw new Error('安装网络策略无效。');
  const registryNetwork = env.FORGEKIT_BUILD_REGISTRY_NETWORK;
  const registryProxy = env.FORGEKIT_BUILD_REGISTRY_PROXY;
  if (installNetwork === 'registry') {
    if (!registryNetwork || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(registryNetwork) ||
        ['host', 'bridge', 'none', 'default'].includes(registryNetwork)) throw new Error('需要隔离的 registry 网络。');
    let proxy: URL;
    try { proxy = new URL(registryProxy ?? ''); } catch { throw new Error('需要 registry 代理。'); }
    if (!['http:', 'https:'].includes(proxy.protocol) || proxy.username || proxy.password || proxy.search || proxy.hash || proxy.pathname !== '/') {
      throw new Error('registry 代理须为无凭证的 HTTP(S) origin。');
    }
  }
  const artifactDir = env.FORGEKIT_ARTIFACT_DIR;
  const workspaceRoot = env.FORGEKIT_BUILD_WORKSPACE_DIR;
  if (!artifactDir || !isAbsolute(artifactDir) || (workspaceRoot !== undefined && !isAbsolute(workspaceRoot))) {
    throw new Error('Docker runner 需要绝对路径的制品目录/工作目录。');
  }
  return { image, runtime, installNetwork: installNetwork as DockerRunnerOptions['installNetwork'], registryNetwork, registryProxy,
    workspaceRoot, artifactDir, timeoutMs,
    maxLogBytes: integer(env.FORGEKIT_BUILD_LOG_MAX_BYTES, 1048576, 16777216),
    maxArtifactBytes: integer(env.FORGEKIT_ARTIFACT_MAX_BYTES, 104857600, 1073741824),
    memoryMb: integer(env.FORGEKIT_BUILD_MEMORY_MB, 2048, 16384),
    cpus: integer(env.FORGEKIT_BUILD_CPUS, 2, 16),
    pidsLimit: integer(env.FORGEKIT_BUILD_PIDS_LIMIT, 256, 4096) };
}
