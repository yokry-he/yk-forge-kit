#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createProjectPlan, renderProjectFiles, ProjectValidationError, type ProjectFeature } from '@forgekit/project-core';

async function createProject(args: string[]): Promise<void> {
  const name = args[0];
  if (!name || name.startsWith('--')) throw new ProjectValidationError('请提供项目名称，例如：forgekit create my-app');
  const allowedFlags = new Set(['--features', '--dir']);
  const flags = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key || !allowedFlags.has(key) || !value || value.startsWith('--') || flags.has(key)) {
      throw new ProjectValidationError('无效参数。支持 --features 和 --dir，且每个参数只能出现一次。');
    }
    flags.set(key, value);
  }
  const featureArg = flags.get('--features') ?? 'theme';
  const features = featureArg === 'none' ? [] : featureArg.split(',').filter(Boolean) as ProjectFeature[];
  const plan = createProjectPlan({ name, template: 'vue-web', features });
  const parent = resolve(flags.get('--dir') ?? process.cwd());
  const target = join(parent, plan.options.name);
  if (existsSync(target)) throw new ProjectValidationError(`目标目录已存在：${target}`);

  // Stage beside the destination so that the final rename is atomic on one filesystem.
  const staging = await mkdtemp(join(parent, '.forgekit-'));
  try {
    for (const [path, contents] of Object.entries(renderProjectFiles(plan.options))) {
      const output = join(staging, path);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, contents, { flag: 'wx' });
    }
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  console.log(`✓ 已创建 ${plan.options.name} (${plan.files.length} 个文件)\n\n下一步：\n  ${plan.commands.join('\n  ')}`);
}

const [command] = process.argv.slice(2);
if (command === 'version' || command === '--version') {
  console.log('ForgeKit CLI 0.0.0');
} else if (command === 'help' || command === '--help' || !command) {
  console.log('ForgeKit CLI\n\nCommands:\n  create <name> [--features theme,router,pinia] [--dir parent-directory]\n  version\n  help');
} else if (command === 'create') {
  createProject(process.argv.slice(3)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : '项目创建失败');
    process.exitCode = 1;
  });
} else {
  console.error(`Unknown command: ${command}`);
  process.exitCode = 1;
}
