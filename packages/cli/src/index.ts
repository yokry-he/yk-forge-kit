#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createProjectPlan, renderProjectFiles, ProjectValidationError, type ProjectFeature } from '@forgekit/project-core';
import { listAssets, parseAssetLock, planAssetInstall, type AssetInstallPlan } from '@forgekit/asset-core';

const LOCK_PATH = '.forgekit/assets.lock.json';

async function assertDirectory(path: string, optional = false): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`不允许使用符号链接或非目录：${path}`);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

async function readSafeFile(path: string): Promise<string | null> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`不允许访问非普通文件：${path}`);
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function getAssetPlan(id: string, projectDir: string): Promise<AssetInstallPlan> {
  await assertDirectory(projectDir);
  await assertDirectory(join(projectDir, 'src'));
  await assertDirectory(join(projectDir, 'src/forgekit'), true);
  await assertDirectory(join(projectDir, '.forgekit'), true);
  const source = await readSafeFile(join(projectDir, 'package.json'));
  if (!source) throw new ProjectValidationError('未找到 package.json，请指定有效 Vue 项目目录。');
  let config: { dependencies?: Record<string, string> };
  try { config = JSON.parse(source) as typeof config; }
  catch { throw new ProjectValidationError('package.json 不是有效 JSON。'); }
  if (!config.dependencies?.vue) throw new ProjectValidationError('当前仅支持 Vue Web 项目。');
  const files: Record<string, string | null> = {
    'src/style.css': await readSafeFile(join(projectDir, 'src/style.css')),
    'src/forgekit/theme.css': await readSafeFile(join(projectDir, 'src/forgekit/theme.css')),
  };
  return planAssetInstall(id, 'vue-web', files, parseAssetLock(await readSafeFile(join(projectDir, LOCK_PATH))));
}

async function assetCommand(args: string[]): Promise<void> {
  const [action, id, ...rest] = args;
  if (action === 'list' && !id) {
    for (const asset of listAssets()) console.log(`${asset.id}@${asset.version}  ${asset.name}  [${asset.target.join(',')}]`);
    return;
  }
  if ((action !== 'plan' && action !== 'add') || !id) {
    throw new ProjectValidationError('用法：forgekit asset list | plan/add <asset-id> [--dir project-path]');
  }
  if (rest.length !== 0 && (rest.length !== 2 || rest[0] !== '--dir' || !rest[1])) {
    throw new ProjectValidationError('只支持 --dir project-path 参数。');
  }
  const projectDir = resolve(rest[1] ?? process.cwd());
  const plan = await getAssetPlan(id, projectDir);
  if (plan.alreadyInstalled) {
    console.log(`✓ ${id} 已安装，版本和受管理文件均未变化。`);
    return;
  }
  console.log(`资产：${plan.asset.name}@${plan.asset.version}`);
  for (const item of plan.changes) console.log(`  ${item.action === 'create' ? '+' : '~'} ${item.path}`);
  console.log(`  + ${LOCK_PATH}`);
  if (action === 'plan') return;

  // Files touched by this operation are restored if a write fails.
  const changed: Array<{ path: string; before: string | null }> = [];
  try {
    for (const item of plan.changes) {
      const path = join(projectDir, item.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, item.after, { flag: item.before === null ? 'wx' : 'w' });
      changed.push({ path, before: item.before });
    }
    const lockFile = join(projectDir, LOCK_PATH);
    await mkdir(dirname(lockFile), { recursive: true });
    await writeFile(lockFile, JSON.stringify(plan.lock, null, 2) + '\n', { flag: 'wx' });
    changed.push({ path: lockFile, before: null });
  } catch (error) {
    for (const item of changed.reverse()) {
      try {
        if (item.before === null) await rm(item.path, { force: true });
        else await writeFile(item.path, item.before);
      } catch { /* Preserve original error; manual recovery may be necessary. */ }
    }
    throw error;
  }
  console.log(`✓ 安装完成：${id}。请查看 Git Diff 后提交。`);
}

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
  console.log('ForgeKit CLI\n\nCommands:\n  create <name> [--features theme,router,pinia] [--dir parent-directory]\n  asset list\n  asset plan/add <id> [--dir project-directory]\n  version\n  help');
} else if (command === 'create') {
  createProject(process.argv.slice(3)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : '项目创建失败');
    process.exitCode = 1;
  });
} else if (command === 'asset') {
  assetCommand(process.argv.slice(3)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : '资产操作失败');
    process.exitCode = 1;
  });
} else {
  console.error(`Unknown command: ${command}`);
  process.exitCode = 1;
}
