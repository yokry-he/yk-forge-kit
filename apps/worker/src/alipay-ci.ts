/** Trusted container entry point. Never imported by API or the worker orchestrator. */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AlipayJobInputSchema, qrImageType, type AlipayJobInput } from '@forgekit/contracts';

export type AlipayCiInput = AlipayJobInput & { appId: string; toolId: string };
/** Download only official raster QR URLs, with no credentials, redirects or unbounded response. */
export async function downloadAlipayQr(url: string, fetchImage: typeof fetch = fetch): Promise<Buffer> {
  const location = new URL(url);
  if (location.protocol !== 'https:' || location.username || location.password || location.port ||
    !['alipay.com', 'alipayobjects.com'].some(host => location.hostname === host || location.hostname.endsWith('.' + host))) throw new Error('alipay_qr_url_invalid');
  const response = await fetchImage(location, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  try {
    if (!response.ok || !response.body || Number(response.headers.get('content-length') ?? 0) > 1048576) throw new Error('alipay_qr_download_failed');
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 1048576) throw new Error('alipay_qr_size');
      chunks.push(Buffer.from(chunk));
    }
    const data = Buffer.concat(chunks); qrImageType(data); return data;
  } finally { if (response.body && !response.body.locked) await response.body.cancel(); }
}
export async function runAlipayCi(input: AlipayCiInput, privateKey: string, output = '/output',
  progress: (step: string) => void = () => {}, fetchImage?: typeof fetch) {
  const sdk = await import('minidev');
  sdk.useDefaults({ config: { globalConfigFilePath: '/tmp/forgekit-empty-config.json', projectConfigRelativePath: '.forgekit-empty-config.json', defaults: { 'compiler.skipLatestCheck': true, 'compiler.version.cube': '0.100.12' } } });
  sdk.setSilent(true); sdk.setSpinnerEnabled(false); sdk.setLogLevelVerboseEnabled(false);
  // useRuntime updates only the in-memory config, unlike config.set / login / identityKeyPath.
  await sdk.minidev.config.useRuntime({ 'alipay.authentication': { privateKey, toolId: input.toolId } });
  try {
    const options = { appId: input.appId, project: '/tmp/project', clientType: 'alipay' };
    if (input.action !== 'preview') {
      progress('正在上传支付宝版本。\n');
      const uploaded = await sdk.minidev.upload({ ...options, version: input.version, versionDescription: input.description, experience: input.target === 'experience' });
      if (input.target === 'experience' && !uploaded.experienceQrCodeUrl) throw new Error('alipay_experience_unconfirmed');
      progress(input.target === 'experience' ? '上传并设置体验版完成。\n' : '开发版本上传完成。\n');
    }
    if (input.action !== 'upload') {
      progress('正在生成支付宝预览二维码。\n');
      const result = await sdk.minidev.preview({ ...options, cacheDir: '/tmp/build-cache', parallel: false,
        sourceMap: false, minify: false, enableLess: false, enableTypescript: false });
      const data = await downloadAlipayQr(result.qrcodeUrl, fetchImage ?? fetch);
      await writeFile(join(output, 'qrcode.img'), data, { mode: 0o600 });
      progress('预览二维码已生成。\n');
    }
  } finally { await sdk.minidev.config.useRuntime({ 'alipay.authentication': { privateKey: '', toolId: '' } }); }
}

export async function prepareAlipayProject(input: AlipayCiInput, source = '/input/project', project = '/tmp/project', globalConfig = '/tmp/forgekit-empty-config.json') {
  await cp(source, project, { recursive: true, dereference: false });
  // Replace all CLI configuration with trusted JSON. Never load project plugins or JS config.
  await writeFile(globalConfig, '{}');
  await writeFile(join(project, '.forgekit-empty-config.json'), '{}');
  await writeFile(join(project, 'mini.project.json'), JSON.stringify({ appid: input.appId, format: 2, component2: true, enableAppxNg: true,
    enableNodeModuleBabelTransform: false, compileOptions: { component2: true },
    developOptions: { parallel: false, minify: false }, pluginResolution: {}, uploadExclude: [], assetsInclude: [] }));
}
if (require.main === module) {
  // Prevent SDK diagnostics (including direct stream writes) from escaping. Only fixed progress is emitted.
  const emit = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write = () => true;
  console.log = console.info = console.warn = console.error = console.debug = () => {};
  void (async () => {
    // Drain stdin before importing the SDK/compiler or reading any artifact-controlled source maps.
    let privateKey = '';
    for await (const chunk of process.stdin) {
      privateKey += chunk.toString('utf8'); if (privateKey.length > 16384) throw new Error('alipay_key_size');
    }
    if (!privateKey) throw new Error('alipay_key_missing');
    const raw = JSON.parse(await readFile('/input/job.json', 'utf8')) as AlipayCiInput;
    const input = { ...AlipayJobInputSchema.parse(rawInput(raw)), appId: raw.appId, toolId: raw.toolId };
    await prepareAlipayProject(input);
    // Seed trusted offline compiler assets from the image; never copy an account config.
    await cp('/opt/alipay-home/.minidev', '/tmp/.minidev', { recursive: true });
    await mkdir('/output', { recursive: true });
    await runAlipayCi(input, privateKey, '/output', step => { emit(step); });
    privateKey = '';
  })().then(() => process.exit(0)).catch(() => {
    emit('支付宝执行失败，请检查 AppID、toolId、工具密钥、权限及网络；上传可能已完成，请先核对开放平台。\n'); process.exit(1);
  });
}
function rawInput(raw: AlipayCiInput) { const { appId: _appId, toolId: _toolId, ...input } = raw; return input; }
