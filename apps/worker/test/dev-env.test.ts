import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadWorkerDevelopmentEnv } from '../src/dev-env';
import { resolveWorkerConfig } from '../src/config';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forgekit-worker-env-'));
  mkdirSync(join(root, 'apps/api'), { recursive: true });
  mkdirSync(join(root, 'apps/worker'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('worker development environment', () => {
  it('loads the same API .env before resolving database, Redis and runner settings', () => {
    writeFileSync(join(root, 'apps/api/.env'), 'DATABASE_URL=mysql://test:test@127.0.0.1:3306/test_db\nREDIS_URL=redis://127.0.0.1:6379/2\nWORKER_CONCURRENCY=3\nFORGEKIT_BUILD_RUNNER=noop\n');
    const env: NodeJS.ProcessEnv = {};
    loadWorkerDevelopmentEnv(env, root);
    const config = resolveWorkerConfig(env);
    expect(config.connection.db).toBe(2);
    expect(config.concurrency).toBe(3);
    expect(config.runner).toBe('noop');
  });

  it('preserves explicit process values and prefers worker then API then root values', () => {
    writeFileSync(join(root, '.env'), 'DATABASE_URL=root\nREDIS_URL=root\nROOT_ONLY=present\n');
    writeFileSync(join(root, 'apps/api/.env'), 'DATABASE_URL=api\nREDIS_URL=api\nAPI_ONLY=present\n');
    writeFileSync(join(root, 'apps/worker/.env'), 'DATABASE_URL=worker\n');
    const env: NodeJS.ProcessEnv = { REDIS_URL: 'explicit', WORKER_CONCURRENCY: '' };
    loadWorkerDevelopmentEnv(env, root);
    expect(env).toEqual({ DATABASE_URL: 'worker', REDIS_URL: 'explicit', WORKER_CONCURRENCY: '', API_ONLY: 'present', ROOT_ONLY: 'present' });
  });

  it('supports an explicit dotenv path without reading other files', () => {
    writeFileSync(join(root, 'apps/api/.env'), 'API_ONLY=ignored\n');
    const path = join(root, 'custom.env');
    writeFileSync(path, 'CUSTOM_ONLY=present\n');
    const env: NodeJS.ProcessEnv = { DOTENV_CONFIG_PATH: path };
    loadWorkerDevelopmentEnv(env, root);
    expect(env.CUSTOM_ONLY).toBe('present');
    expect(env.API_ONLY).toBeUndefined();
  });

  it('allows missing files in dev but never reads .env in production or supplies production defaults', () => {
    const dev: NodeJS.ProcessEnv = {};
    expect(() => loadWorkerDevelopmentEnv(dev, root)).not.toThrow();
    expect(() => resolveWorkerConfig(dev)).toThrow();
    writeFileSync(join(root, 'apps/api/.env'), 'DATABASE_URL=mysql://test:test@127.0.0.1:3306/test_db\nREDIS_URL=redis://127.0.0.1:6379\n');
    const production: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
    loadWorkerDevelopmentEnv(production, root);
    expect(production.DATABASE_URL).toBeUndefined();
    expect(() => resolveWorkerConfig(production)).toThrow();
  });
});
