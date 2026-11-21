"""Fast signer tests; real RSA/EC signing runs when JDK tools are installed. No Android SDK."""
import base64
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import shutil
import zipfile

spec = importlib.util.spec_from_file_location('android_entry', Path(__file__).with_name('package.py'))
entry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(entry)


class SignerTests(unittest.TestCase):
    def run_signer(self, kind='apk', debug=False, failure=False, unsigned=False):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for directory in ['tmp', 'input', 'output', 'opt/android']:
                (root / directory).mkdir(parents=True, exist_ok=True)
            (root / 'input' / ('app.' + kind)).write_bytes(b'PK\x03\x04synthetic-unsigned')
            (root / 'opt/android/debug.keystore').write_bytes(b'synthetic-debug-key')
            calls = []
            original_copy = shutil.copyfile

            def mapped(value):
                path = Path(value)
                return path if path.is_relative_to(root) else root / str(value).lstrip('/')

            def quiet(args):
                calls.append(args)
                # The only credential file contents are within the isolated tmpfs path.
                self.assertEqual((root / 'tmp/storepass').read_text(), 'android' if debug else 'synthetic-store-password')
                self.assertNotIn('synthetic-store-password', args)
                self.assertNotIn('synthetic-key-password', args)
                if failure:
                    raise subprocess.CalledProcessError(1, args, stderr='synthetic-store-password')
                if 'sign' in args:
                    (root / 'output/app.apk').write_bytes(b'PK\x03\x04synthetic-signed')

            job = {'settings': {'packageName': 'com.example.test', 'versionCode': 1, 'versionName': '1.0.0'}, 'input': {'kind': kind, 'buildType': 'debug' if debug else 'release'}}
            raw = b'' if debug else b'{"keystore":"dGVzdA==","alias":"release","storePassword":"synthetic-store-password","keyPassword":"synthetic-key-password"}'
            stdout = io.StringIO()
            with patch.object(entry, 'Path', side_effect=mapped), patch.object(entry, 'quiet', side_effect=quiet), patch.object(entry.sys, 'stdin', io.TextIOWrapper(io.BytesIO(raw))), patch.object(entry.shutil, 'copyfile', side_effect=lambda src, dst: original_copy(mapped(src), mapped(dst))), patch.object(entry.subprocess, 'check_output', return_value=(b'jar is unsigned.' if unsigned else b'jar verified.' if kind == 'aab' else b"package: name='com.example.test' versionCode='1' versionName='1.0.0'")), contextlib.redirect_stdout(stdout):
                if failure or unsigned:
                    with self.assertRaises(subprocess.CalledProcessError if failure else ValueError):
                        entry.sign(job)
                else:
                    entry.sign(job)
                    self.assertEqual((root / 'output' / ('app.' + kind)).read_bytes()[:4], b'PK\x03\x04')
            for name in ['signing.jks', 'storepass', 'keypass']:
                self.assertFalse((root / 'tmp' / name).exists())
            self.assertNotIn('password', stdout.getvalue())
            return calls

    def test_apk_sign_verify_and_metadata(self):
        calls = self.run_signer()
        self.assertTrue(any('apksigner' in args[0] and 'verify' in args for args in calls))
        sign = next(args for args in calls if 'sign' in args)
        self.assertIn('file:/tmp/storepass', sign)
        self.assertIn('file:/tmp/keypass', sign)
        self.assertIn('16', calls[0])

    def test_aab_uses_jarsigner_file_passwords(self):
        calls = self.run_signer('aab')
        self.assertIn('-storepass:file', calls[0])
        self.assertIn('-keypass:file', calls[0])
        self.assertNotIn('-sigalg', calls[0])

    def test_debug_uses_image_key(self):
        calls = self.run_signer(debug=True)
        self.assertIn('androiddebugkey', next(args for args in calls if 'sign' in args))

    def test_tool_failure_cleans_secret_files(self):
        self.run_signer(failure=True)

    def test_aab_rejects_unverified_archive(self):
        self.run_signer('aab', unsigned=True)

    def test_release_never_falls_back_to_debug(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'tmp').mkdir()
            with patch.object(entry, 'Path', side_effect=lambda value: root / str(value).lstrip('/')), patch.object(entry.sys, 'stdin', io.TextIOWrapper(io.BytesIO(b'null'))), patch.object(entry, 'quiet') as quiet:
                with self.assertRaisesRegex(ValueError, 'signing_required'):
                    entry.sign({'input': {'buildType': 'release', 'kind': 'apk'}})
                quiet.assert_not_called()

    def test_entry_failure_never_emits_traceback_or_input(self):
        result = subprocess.run(['python3', str(Path(__file__).with_name('package.py')), 'sign'], input=b'synthetic-store-password', capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(b'Traceback', result.stderr)
        self.assertNotIn(b'synthetic-store-password', result.stderr)
        self.assertIn('Android 工具执行失败'.encode(), result.stderr)

@unittest.skipUnless(shutil.which('keytool') and shutil.which('jarsigner'), 'JDK keytool/jarsigner not installed')
class RealJdkSignerTests(unittest.TestCase):
    def test_release_aab_rsa_and_ec_in_jks_and_pkcs12(self):
        for keyalg in ['RSA', 'EC']:
            for storetype in ['JKS', 'PKCS12']:
                with self.subTest(keyalg=keyalg, storetype=storetype), tempfile.TemporaryDirectory() as tmp:
                    root = Path(tmp)
                    for directory in ['tmp', 'input', 'output']:
                        (root / directory).mkdir()
                    password = 'synthetic-test-password'
                    keystore = root / 'release.keystore'
                    subprocess.run([
                        'keytool', '-genkeypair', '-noprompt', '-alias', 'release',
                        '-keyalg', keyalg, *(['-keysize', '2048'] if keyalg == 'RSA' else ['-groupname', 'secp256r1']),
                        '-storetype', storetype, '-keystore', str(keystore),
                        '-storepass', password, '-keypass', password,
                        '-dname', 'CN=B18 Test', '-validity', '2',
                    ], check=True, capture_output=True, timeout=20)
                    payload = b'synthetic bundle payload'
                    with zipfile.ZipFile(root / 'input/app.aab', 'w') as archive:
                        archive.writestr('base/assets/payload', payload)
                    raw = json.dumps({
                        'keystore': base64.b64encode(keystore.read_bytes()).decode(), 'alias': 'release',
                        'storePassword': password, 'keyPassword': password,
                    }).encode()

                    def mapped(value):
                        path = Path(value)
                        return path if path.is_relative_to(root) else root / str(value).lstrip('/')

                    def mapped_args(args):
                        return [str(mapped(arg)) if arg.startswith('/') else arg for arg in args]

                    # Only redirect container paths. Both sign and verify execute the real JDK tools.
                    tools = SimpleNamespace(
                        DEVNULL=subprocess.DEVNULL,
                        run=lambda args, **kwargs: subprocess.run(mapped_args(args), timeout=20, **kwargs),
                        check_output=lambda args, **kwargs: subprocess.check_output(mapped_args(args), timeout=20, **kwargs),
                    )
                    original_copy = shutil.copyfile
                    with patch.object(entry, 'Path', side_effect=mapped), patch.object(entry, 'subprocess', tools), patch.object(entry.shutil, 'copyfile', side_effect=lambda src, dst: original_copy(mapped(src), mapped(dst))), patch.object(entry.sys, 'stdin', io.TextIOWrapper(io.BytesIO(raw))), contextlib.redirect_stdout(io.StringIO()):
                        entry.sign({'input': {'kind': 'aab', 'buildType': 'release'}})
                    signed = root / 'output/app.aab'
                    # Trust the generated test certificate so strict verification can succeed.
                    verified = subprocess.check_output([
                        'jarsigner', '-J-Duser.language=en', '-verify', '-strict',
                        '-keystore', str(keystore), '-storepass', password, str(signed), 'release',
                    ], stderr=subprocess.STDOUT, timeout=20)
                    self.assertIn(b'jar verified.', verified)
                    with zipfile.ZipFile(signed) as archive:
                        self.assertEqual(archive.read('base/assets/payload'), payload)
                        self.assertIn('META-INF/RELEASE.' + ('RSA' if keyalg == 'RSA' else 'EC'), archive.namelist())
                    for name in ['signing.jks', 'storepass', 'keypass']:
                        self.assertFalse((root / 'tmp' / name).exists())


class NativeAssemblyTests(unittest.TestCase):
    def test_app_resources_and_control_use_snapshot_and_gradle_stays_offline(self):
        for kind in ['apk', 'aab']:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)

                def mapped(value):
                    path = Path(value)
                    return path if path.is_relative_to(root) else root / str(value).lstrip('/')

                data = root / 'opt/android/project/app/src/main/assets/data'
                data.mkdir(parents=True)
                (data / 'dcloud_control.xml').write_text('<hbuilder><apps><app appid="OLD" /></apps></hbuilder>')
                (root / 'opt/android/cache').mkdir(parents=True)
                (root / 'input/app').mkdir(parents=True)
                (root / 'input/app/app-service.js').write_text('compiled resource')
                (root / 'output').mkdir()
                original_tree, original_copy = shutil.copytree, shutil.copyfile
                job = {'settings': {'appId': '__UNI__TEST123', 'versionName': '2.0.0'}, 'input': {'kind': kind, 'buildType': 'release'}}

                def build(args, **kwargs):
                    self.assertIn('--offline', args)
                    self.assertIn(':app:assembleRelease' if kind == 'apk' else ':app:bundleRelease', args)
                    self.assertEqual(kwargs['stdin'], subprocess.DEVNULL)
                    target = mapped('/tmp/native') / ('app/build/outputs/apk/release/app-release-unsigned.apk' if kind == 'apk' else 'app/build/outputs/bundle/release/app-release.aab')
                    target.parent.mkdir(parents=True)
                    target.write_bytes(b'PK\x03\x04synthetic-native')

                with patch.object(entry, 'Path', side_effect=mapped), patch.object(entry.shutil, 'copytree', side_effect=lambda src, dst, *args, **kwargs: original_tree(mapped(src), mapped(dst), *args, **kwargs)), patch.object(entry.shutil, 'copyfile', side_effect=lambda src, dst, **kwargs: original_copy(mapped(src), mapped(dst), **kwargs)), patch.object(entry.subprocess, 'run', side_effect=build), contextlib.redirect_stdout(io.StringIO()):
                    entry.native(job)
                control = (mapped('/tmp/native') / 'app/src/main/assets/data/dcloud_control.xml').read_text()
                self.assertIn('__UNI__TEST123', control)
                self.assertNotIn('OLD', control)
                self.assertTrue((mapped('/tmp/native') / 'app/src/main/assets/apps/__UNI__TEST123/www/app-service.js').exists())
                self.assertTrue((root / 'output' / ('app.' + kind)).exists())


if __name__ == '__main__':
    unittest.main()
