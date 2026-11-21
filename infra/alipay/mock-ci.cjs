// Offline fixture. Never copied into the production stage.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let auth;
exports.useDefaults = () => {};
exports.setSilent = exports.setSpinnerEnabled = exports.setLogLevelVerboseEnabled = () => {};
function noSecretFiles(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) noSecretFiles(file);
    else if (entry.isFile()) assert.equal(fs.readFileSync(file).includes(Buffer.from('synthetic-b20-container-key')), false, file);
  }
}
exports.minidev = {
  config: { useRuntime: async input => {
    auth = input['alipay.authentication'];
    if (!auth.privateKey) return;
    assert.equal(auth.privateKey, 'synthetic-b20-container-key');
    assert.equal(auth.toolId, 'synthetic-tool');
    assert.notEqual(process.getuid(), 0);
    for (const name of ['DATABASE_URL', 'REDIS_URL', 'FORGEKIT_DEPLOY_ENCRYPTION_KEY']) assert.equal(process.env[name], undefined);
    assert.equal(fs.existsSync('/var/run/docker.sock'), false);
    assert.throws(() => fs.writeFileSync('/rootfs-probe', 'denied'));
    assert.throws(() => fs.writeFileSync('/input/private.key', 'denied'));
    assert.equal(fs.existsSync('/input/private.key'), false);
    assert.equal(process.stdin.readableEnded, true);
    if (fs.existsSync('/proc/self/fd/0')) assert.equal(fs.readFileSync('/proc/self/fd/0').length, 0);
    const status = fs.readFileSync('/proc/self/status', 'utf8');
    assert.match(status, /CapEff:\s+0+\n/); assert.match(status, /NoNewPrivs:\s+1\n/); assert.match(status, /Seccomp:\s+2\n/);
    const config = JSON.parse(fs.readFileSync('/tmp/project/mini.project.json', 'utf8'));
    assert.equal(config.appid, '0000000000000000'); assert.equal(config.plugins, undefined);
    assert.equal(process.cwd(), '/tmp');
    noSecretFiles('/tmp'); noSecretFiles('/input'); noSecretFiles('/output');
  } },
  upload: async options => {
    assert.equal(options.identityKeyPath, undefined); assert.equal(options.project, '/tmp/project');
    process.stdout.write(auth.privateKey); console.error(auth.privateKey);
    if (options.versionDescription === 'fixture-fail') throw new Error(auth.privateKey);
    noSecretFiles('/tmp');
    return { version: options.version, ...(options.experience ? { experienceQrCodeUrl: 'https://mdn.alipayobjects.com/experience.jpg' } : {}) };
  },
  preview: async () => ({ qrcodeUrl: 'https://mdn.alipayobjects.com/offline.jpg', version: 'preview' }),
};
globalThis.fetch = async url => {
  assert.equal(String(url), 'https://mdn.alipayobjects.com/offline.jpg');
  noSecretFiles('/tmp'); noSecretFiles('/output');
  return new Response(Buffer.from([255, 216, 1, 255, 217]), { headers: { 'Content-Type': 'image/jpeg' } });
};
