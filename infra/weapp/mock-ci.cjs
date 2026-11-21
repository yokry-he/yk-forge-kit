// Offline integration fixture. Production image never copies this file into node_modules.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
exports.Project = class {
  constructor(options) {
    assert.notEqual(process.getuid(), 0);
    for (const name of ['DATABASE_URL', 'REDIS_URL', 'FORGEKIT_DEPLOY_ENCRYPTION_KEY']) assert.equal(process.env[name], undefined);
    assert.equal(fs.existsSync('/var/run/docker.sock'), false);
    assert.throws(() => fs.writeFileSync('/rootfs-probe', 'denied'));
    assert.throws(() => fs.writeFileSync('/input/private.key', 'denied'));
    assert.equal(fs.existsSync('/input/private.key'), false);
    assert.equal(process.stdin.readableEnded, true);
    if (fs.existsSync('/proc/self/fd/0')) assert.equal(fs.readFileSync('/proc/self/fd/0').length, 0);
    assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /CapEff:\s+0+\n/);
    assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /NoNewPrivs:\s+1\n/);
    assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /Seccomp:\s+2\n/);
    const config = JSON.parse(fs.readFileSync(options.projectPath + '/project.config.json', 'utf8'));
    assert.equal(config.appid, 'wx0000000000000000');
    assert.equal(config.plugins, undefined);
    assert.equal(options.privateKeyPath, undefined);
    assert.equal(options.privateKey, 'synthetic-b17-container-key');
    // miniprogram-ci@2.1.31 SummerCompilerFactory.ensureCacheDir uses a relative path.
    // Exercise that write so a read-only image WORKDIR cannot pass the offline fixture.
    assert.equal(process.cwd(), '/tmp');
    fs.mkdirSync(createHash('md5').update(options.projectPath + '|summer').digest('hex'), { recursive: true });
  }
};
exports.upload = async options => {
  options.onProgressUpdate({ message: 'synthetic-b17-container-key' });
  console.log('synthetic-b17-container-key');
  assert.equal(options.robot, 1);
  if (options.desc === 'fixture-fail') throw new Error('synthetic-b17-container-key');
};
exports.preview = async options => fs.writeFileSync(options.qrcodeOutputDest, Buffer.from([255, 216, 1, 255, 217]));
