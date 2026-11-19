import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>((done) => {
      child.once('exit', () => done());
      setTimeout(done, 2000).unref();
    });
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }));
});

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法获取测试端口。');
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

async function waitForHealth(base: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('API 提前退出。');
    try {
      const response = await fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch { /* Process may still be booting. */ }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('API 未能在 4 秒内完成本地启动。');
}

describe.each([
  { mode: 'compiled', args: [resolve(process.cwd(), 'dist/main.js')] },
  { mode: 'development', args: ['--import', 'tsx', resolve(process.cwd(), 'src/main.ts')] },
])('$mode API loopback HTTP without database credentials', ({ args }) => {
  it('exposes health and fails closed when MySQL is not configured', async () => {
    const port = await unusedLoopbackPort();
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: 'ignore',
      env: { ...process.env, AUTH_MODE: 'local', NODE_ENV: 'test', API_HOST: '127.0.0.1', DATABASE_URL: '', PORT: String(port) },
    });
    children.push(child);
    const base = `http://127.0.0.1:${port}`;
    await waitForHealth(base, child);
    const health = await fetch(`${base}/api/v1/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok', service: 'forgekit-api' });

    const ready = await fetch(`${base}/api/v1/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ status: 'unavailable', database: 'unavailable' });

    const projects = await fetch(`${base}/api/v1/projects`);
    expect(projects.status).toBe(503);
    const whoami = await fetch(`${base}/api/v1/auth/whoami`);
    expect(whoami.status).toBe(503);
  }, 10_000);
});
