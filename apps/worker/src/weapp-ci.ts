/** Trusted container entry point. Never imported by API or the worker orchestrator. */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WeappJobInput } from '@forgekit/contracts';
export async function runWeappCi(input: WeappJobInput & { appId: string }, privateKey: string, output = '/output',
  progress: (step: string) => void = () => {}) {
  const ci = await import('miniprogram-ci');
  // Ignore all project compilation settings/scripts. SDK uses its own trusted implementation.
  const project = new ci.Project({ appid: input.appId, type: 'miniProgram', projectPath: '/tmp/project',
    privateKey, ignores: ['node_modules/**/*'] });
  const options = { project, version: input.version, desc: input.description, robot: input.robot, threads: 2,
    setting: { es6: false, minify: true }, onProgressUpdate: () => progress('微信 CI 正在处理。\n') };
  if (input.action !== 'preview') { progress('正在上传开发版本。\n'); await ci.upload(options); progress('开发版本上传完成。\n'); }
  if (input.action !== 'upload') {
    progress('正在生成预览二维码。\n');
    await ci.preview({ ...options, qrcodeFormat: 'image', qrcodeOutputDest: join(output, 'qrcode.jpg') });
    progress('预览二维码已生成。\n');
  }
}
if (require.main === module) {
  // Suppress SDK diagnostics at source; callbacks emit only fixed, platform-owned text.
  const emit = (step: string) => process.stdout.write(step);
  console.log = console.info = console.warn = console.error = console.debug = () => {};
  void (async () => {
    // Consume the one-shot pipe completely before any compiler/source-map loader runs.
    // Never persist the signing key where an artifact-controlled path could read it.
    let privateKey = '';
    for await (const chunk of process.stdin) privateKey += chunk.toString('utf8');
    if (!privateKey) throw new Error('weapp_private_key_missing');
    const { cp, mkdir } = await import('node:fs/promises');
    await cp('/input/project', '/tmp/project', { recursive: true, dereference: false });
    const input = JSON.parse(await readFile('/input/job.json', 'utf8')) as WeappJobInput & { appId: string };
    // Replace untrusted project config. Never load project-local JS, plugins or dependencies.
    await writeFile('/tmp/project/project.config.json', JSON.stringify({ appid: input.appId, compileType: 'miniprogram', miniprogramRoot: './', setting: {} }));
    await mkdir('/output', { recursive: true });
    let last = 0;
    await runWeappCi(input, privateKey, '/output', step => {
      if (!step.includes('正在处理') || Date.now() - last > 1000) { emit(step); last = Date.now(); }
    });
  })().catch(() => { emit('微信 CI 执行失败，请检查 AppID、密钥、IP 白名单及网络。\n'); process.exitCode = 1; });
}
