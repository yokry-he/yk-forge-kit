import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

// Share installed third-party dependencies, but point workspace links at copied sources.
// This keeps existing dist directories out of both CommonJS resolution and compilation.
async function linkDependencies(source, destination, fixture) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      await linkDependencies(from, to, fixture);
    } else {
      const target = await realpath(from);
      const workspacePath = relative(root, target);
      const isWorkspacePackage = /^(packages|apps)\/[^/]+$/.test(workspacePath);
      await symlink(isWorkspacePackage ? join(fixture, workspacePath) : target, to);
    }
  }
}

async function cleanWorkspace() {
  const fixture = await mkdtemp(join(tmpdir(), 'forgekit-startup-'));
  try {
    for (const file of ['package.json', 'pnpm-workspace.yaml', 'tsconfig.base.json']) {
      await cp(join(root, file), join(fixture, file));
    }
    for (const group of ['packages', 'apps']) {
      await cp(join(root, group), join(fixture, group), {
        recursive: true,
        filter: (path) => !['node_modules', 'dist'].includes(basename(path)) && !basename(path).startsWith('.env'),
      });
      for (const name of await readdir(join(root, group))) {
        await linkDependencies(join(root, group, name, 'node_modules'), join(fixture, group, name, 'node_modules'), fixture);
      }
    }
    await symlink(join(root, 'node_modules'), join(fixture, 'node_modules'));
    assert.equal(await realpath(join(fixture, 'packages/db/node_modules/@forgekit/contracts')),
      resolve(fixture, 'packages/contracts'));
    return fixture;
  } catch (error) {
    await rm(fixture, { recursive: true, force: true });
    throw error;
  }
}

async function unusedPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
  return port;
}

function run(fixture, args, env = {}) {
  const child = spawn('corepack', ['pnpm', ...args], {
    cwd: fixture, detached: true,
    env: { ...process.env, DATABASE_URL: '', AUTH_MODE: 'local', NODE_ENV: 'test', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const finished = once(child, 'close');
  // Register rejection handling immediately; assertions below still report spawn failures.
  finished.catch(() => {});
  return { child, finished, output: () => output };
}

async function stop({ child, finished }) {
  const kill = (signal) => {
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  kill('SIGTERM');
  await Promise.race([finished, delay(2000)]);
  kill('SIGKILL');
  await finished;
}

test('pnpm dev builds dependencies and starts the API from clean sources', { timeout: 60_000 }, async (t) => {
  const fixture = await cleanWorkspace();
  const port = await unusedPort();
  const process = run(fixture, ['dev'], { PORT: String(port), API_HOST: '127.0.0.1' });
  t.after(async () => {
    try { await stop(process); }
    finally { await rm(fixture, { recursive: true, force: true }); }
  });
  for (let attempt = 0; attempt < 500; attempt++) {
    assert.equal(process.child.exitCode, null, process.output());
    assert.equal(process.child.signalCode, null, process.output());
    assert.doesNotMatch(process.output(), /MODULE_NOT_FOUND|Failed to resolve entry for package/);
    let response;
    try { response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(500) }); }
    catch { /* The dependency build or API startup may still be running. */ }
    if (response?.ok) {
      assert.equal((await response.json()).service, 'forgekit-api');
      return;
    }
    await delay(100);
  }
  assert.fail(`API startup timed out:\n${process.output()}`);
});

test('db:check loads the database package from clean sources', { timeout: 60_000 }, async (t) => {
  const fixture = await cleanWorkspace();
  const process = run(fixture, ['--filter', '@forgekit/db', 'db:check']);
  t.after(async () => {
    try { await stop(process); }
    finally { await rm(fixture, { recursive: true, force: true }); }
  });
  const [code] = await process.finished;
  // Reaching the configuration error proves that CommonJS loaded db and contracts.
  assert.equal(code, 1, process.output());
  assert.match(process.output(), /DATABASE_URL 未配置；未进行连接检查。/);
  assert.doesNotMatch(process.output(), /MODULE_NOT_FOUND|Cannot find module/);
});
