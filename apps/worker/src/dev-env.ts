import { config } from 'dotenv';
import { resolve } from 'node:path';

/** Dev entry only: use the API's local configuration without overriding explicit process env. */
export function loadWorkerDevelopmentEnv(env: NodeJS.ProcessEnv = process.env, workspaceRoot = resolve(__dirname, '../../..')): void {
  if (env.NODE_ENV === 'production') return;
  const paths = env.DOTENV_CONFIG_PATH ? [env.DOTENV_CONFIG_PATH] : [
    resolve(workspaceRoot, 'apps/worker/.env'),
    resolve(workspaceRoot, 'apps/api/.env'),
    resolve(workspaceRoot, '.env'),
  ];
  for (const path of paths) {
    const values: Record<string, string> = {};
    const result = config({ path, processEnv: values });
    if (result.error && (result.error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Worker 开发环境配置文件无法读取。');
    }
    for (const [name, value] of Object.entries(values)) {
      if (env[name] === undefined) env[name] = value;
    }
  }
}
