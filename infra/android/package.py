"""Trusted image entry. No project executable code is loaded here; signer diagnostics stay private."""
import base64
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET

TOOLS = '/opt/android-sdk/build-tools/36.0.0/'


def quiet(args):
    # Do not forward tool errors: keytool/jarsigner can echo aliases and password arguments.
    subprocess.run(args, check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def native(job):
    settings, kind = job['settings'], job['input']['kind']
    root = Path('/tmp/native')
    shutil.copytree('/opt/android/project', root)
    shutil.copytree('/opt/android/cache', '/tmp/gradle')
    (root / 'job.json').write_text(json.dumps(job))
    main = root / 'app/src/main'
    shutil.copytree('/input/app', main / 'assets/apps' / settings['appId'] / 'www')
    control = main / 'assets/data/dcloud_control.xml'
    tree = ET.parse(control)
    apps = tree.getroot().find('apps')
    if apps is None:
        raise ValueError('control')
    apps.clear()
    ET.SubElement(apps, 'app', {'appid': settings['appId'], 'appver': settings['versionName']})
    tree.write(control, encoding='utf-8', xml_declaration=True)
    task = ':app:assembleRelease' if kind == 'apk' else ':app:bundleRelease'
    print('开始离线 Gradle 构建。', flush=True)
    subprocess.run(['/opt/gradle/bin/gradle', '--offline', '--no-daemon', '--console=plain', '-g', '/tmp/gradle', task], cwd=root, check=True, stdin=subprocess.DEVNULL)
    source = root / ('app/build/outputs/apk/release/app-release-unsigned.apk' if kind == 'apk' else 'app/build/outputs/bundle/release/app-release.aab')
    shutil.copyfile(source, '/output/app.' + kind)


def sign(job):
    key = Path('/tmp/signing.jks')
    try:
        # Drain stdin before opening the archive. Secrets live only in the container's /tmp tmpfs.
        raw = sys.stdin.buffer.read(100000)
        if len(raw) >= 100000:
            raise ValueError('input')
        secret = json.loads(raw) if job['input']['buildType'] == 'release' else None
        if job['input']['buildType'] == 'release':
            if not isinstance(secret, dict):
                raise ValueError('signing_required')
            data = base64.b64decode(secret['keystore'], validate=True)
            if not 1 <= len(data) <= 65536:
                raise ValueError('keystore')
            key.write_bytes(data)
            alias, storepass, keypass = secret['alias'], secret['storePassword'], secret['keyPassword']
        else:
            alias, storepass, keypass = 'androiddebugkey', 'android', 'android'
            shutil.copyfile('/opt/android/debug.keystore', key)
        Path('/tmp/storepass').write_text(storepass)
        Path('/tmp/keypass').write_text(keypass)
        kind = job['input']['kind']
        source, target = '/input/app.' + kind, '/output/app.' + kind
        if not 1 <= Path(source).stat().st_size <= 268435456:
            raise ValueError('size')
        if kind == 'apk':
            quiet([TOOLS + 'zipalign', '-P', '16', '-f', '4', source, '/tmp/aligned.apk'])
            quiet([TOOLS + 'apksigner', 'sign', '--ks', str(key), '--ks-key-alias', alias, '--ks-pass', 'file:/tmp/storepass', '--key-pass', 'file:/tmp/keypass', '--out', target, '/tmp/aligned.apk'])
            quiet([TOOLS + 'apksigner', 'verify', '--verbose', target])
            quiet([TOOLS + 'zipalign', '-c', '-P', '16', '4', target])
            info = subprocess.check_output([TOOLS + 'aapt', 'dump', 'badging', target], stderr=subprocess.DEVNULL).decode()
            s = job['settings']
            if not re.search(r"package: name='" + re.escape(s['packageName']) + r"' versionCode='" + str(s['versionCode']) + r"' versionName='" + re.escape(s['versionName']) + "'", info):
                raise ValueError('metadata')
        else:
            shutil.copyfile(source, target)
            # Let the JDK choose a signature algorithm compatible with the private key (RSA, EC, etc.).
            quiet(['jarsigner', '-keystore', str(key), '-storepass:file', '/tmp/storepass', '-keypass:file', '/tmp/keypass', '-digestalg', 'SHA-256', target, alias])
            # jarsigner exits 0 for unsigned archives, so also require its verified marker.
            result = subprocess.check_output(['jarsigner', '-J-Duser.language=en', '-verify', target], stderr=subprocess.DEVNULL)
            if b'jar verified.' not in result:
                raise ValueError('signature')
        print('签名及安装包校验完成。', flush=True)
    finally:
        for path in [key, Path('/tmp/storepass'), Path('/tmp/keypass')]:
            path.unlink(missing_ok=True)


def main():
    os.umask(0o077)
    job = json.loads(Path('/input/job.json').read_text())
    if job['input']['kind'] not in ('apk', 'aab') or job['input']['buildType'] not in ('debug', 'release'):
        raise ValueError('job')
    {'native': native, 'sign': sign}[sys.argv[1]](job)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Android 工具执行失败，请核对离线 SDK、应用配置或签名材料。', file=sys.stderr)
        sys.exit(1)
