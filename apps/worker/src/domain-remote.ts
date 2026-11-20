/** Fixed remote program, transported as a single quoted SSH operand. Only JSON data varies. */
export const domainRemoteProgram = String.raw`
import base64, datetime, hashlib, http.client, json, os, pathlib, re, socket, ssl, subprocess, sys, time
p = json.loads(base64.b64decode(sys.argv[1]))
root = pathlib.Path(p['basePath']) / '.forgekit-caddy'
state = root / 'state.json'
working = root / 'caddy.json'
candidate = root / 'candidate.json'
previous = root / 'previous.json'
leaf = root / 'leaf.pem'
os.umask(0o077)

def write(path, value):
    tmp = path.with_suffix(path.suffix + '.tmp')
    with open(tmp, 'w') as f:
        json.dump(value, f, sort_keys=True)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)

def load(path):
    with open(path) as f: return json.load(f)

def admin(config):
    class UnixConnection(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.settimeout(15)
            self.sock.connect(str(root / 'admin.sock'))
    c = UnixConnection('localhost', timeout=15)
    try:
        c.request('POST', '/load', json.dumps(config), {'Content-Type': 'application/json'})
        r = c.getresponse()
        if r.status != 200: raise RuntimeError('domain_reload_failed')
        r.read(8192)
    finally: c.close()

def config(entries, http_port, https_port):
    routes, redirects, policies = [], [], []
    for entry in sorted(entries.values(), key=lambda e: e['hostname']):
        name = entry['hostname']
        mode = entry['tlsMode']
        issuer = {'module': 'internal'} if mode == 'internal' else {'module': 'acme', 'ca':
          'https://acme-staging-v02.api.letsencrypt.org/directory' if mode == 'staging' else 'https://acme-v02.api.letsencrypt.org/directory'}
        policies.append({'subjects': [name], 'issuers': [issuer]})
        if entry.get('serving'):
            routes.append({'match': [{'host': [name]}], 'handle': [{'handler': 'file_server', 'root': entry['siteRoot'], 'hide': ['.forgekit-complete']}], 'terminal': True})
            redirects.append({'match': [{'host': [name]}], 'handle': [{'handler': 'static_response', 'status_code': 308, 'headers': {'Location': ['https://' + name + '{http.request.uri}']}}], 'terminal': True})
    return {'admin': {'listen': 'unix/' + str(root / 'admin.sock')},
      'storage': {'module': 'file_system', 'root': str(root / 'data')},
      'apps': {'pki': {'certificate_authorities': {'local': {'install_trust': False}}},
        'tls': {'certificates': {'automate': [e['hostname'] for e in entries.values()]}, 'automation': {'policies': policies}},
        'http': {'http_port': http_port, 'https_port': https_port, 'servers': {
          'https': {'listen': [':' + str(https_port)], 'tls_connection_policies': [{}], 'strict_sni_host': True,
            'automatic_https': {'disable_redirects': True}, 'routes': routes + [{'handle': [{'handler': 'static_response', 'status_code': 404}]}]},
          'http': {'listen': [':' + str(http_port)], 'routes': redirects + [{'handle': [{'handler': 'static_response', 'status_code': 404}]}]}}}}}

def apply(value):
    write(candidate, value)
    r = subprocess.run(['caddy', 'validate', '--config', str(candidate)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
    if r.returncode: raise RuntimeError('domain_config_invalid')
    admin(value)

def certificate(port, health=False):
    context = ssl.create_default_context() if p['tlsMode'] == 'production' else ssl._create_unverified_context()
    with socket.create_connection(('127.0.0.1', port), timeout=3) as raw:
        with context.wrap_socket(raw, server_hostname=p['hostname']) as conn:
            der = conn.getpeercert(binary_form=True)
            if health:
                conn.sendall(('GET /index.html HTTP/1.1\r\nHost: ' + p['hostname'] + '\r\nConnection: close\r\n\r\n').encode('ascii'))
                response = http.client.HTTPResponse(conn)
                response.begin()
                if response.status != 200: raise RuntimeError('domain_health_failed')
    pem = ssl.DER_cert_to_PEM_cert(der)
    r = subprocess.run(['openssl', 'x509', '-noout', '-checkhost', p['hostname'], '-startdate', '-enddate'], input=pem, text=True, capture_output=True, timeout=5)
    if r.returncode or 'does match certificate' not in r.stdout: raise RuntimeError('domain_certificate_invalid')
    start = next(line[10:] for line in r.stdout.splitlines() if line.startswith('notBefore='))
    end = next(line[9:] for line in r.stdout.splitlines() if line.startswith('notAfter='))
    begins = datetime.datetime.strptime(start, '%b %d %H:%M:%S %Y %Z').replace(tzinfo=datetime.timezone.utc)
    expires = datetime.datetime.strptime(end, '%b %d %H:%M:%S %Y %Z').replace(tzinfo=datetime.timezone.utc)
    now = datetime.datetime.now(datetime.timezone.utc)
    if begins > now: raise RuntimeError('domain_certificate_invalid')
    if expires <= now: raise RuntimeError('domain_certificate_expired')
    return {'expiresAt': expires.isoformat().replace('+00:00', 'Z'), 'fingerprint': hashlib.sha256(der).hexdigest()}

try:
    if not root.is_dir() or root.is_symlink() or not working.is_file() or not state.is_file(): raise RuntimeError('domain_host_not_prepared')
    settings = load(root / 'settings.json')
    hp, sp = settings['httpPort'], settings['httpsPort']
    if not all(isinstance(port, int) and 1 <= port <= 65535 for port in [hp, sp]) or hp == sp: raise RuntimeError('domain_host_not_prepared')
    entries = load(state)
    if len(entries) > 1000: raise RuntimeError('domain_host_limit')
    old = load(working)
    # A previous interrupted apply is always restored before the next operation. No speculative route survives restart.
    if previous.exists():
        backup = load(previous)
        admin(backup['config'])
        write(working, backup['config'])
        write(state, backup['state'])
        previous.unlink()
        old = load(working)
        entries = load(state)
    if p['action'] == 'refresh':
        if p['id'] not in entries or not entries[p['id']].get('serving'): raise RuntimeError('domain_not_configured')
        result = certificate(sp, True)
    else:
        # Never overwrite another record's route, even if the database was restored from an old backup.
        if p['action'] == 'verify' and any(e['hostname'] == p['hostname'] and key != p['id'] for key, e in entries.items()): raise RuntimeError('domain_host_claim_conflict')
        write(previous, {'config': old, 'state': entries})
        try:
            if p['action'] == 'remove':
                entries.pop(p['id'], None)
                apply(config(entries, hp, sp))
                result = {}
            else:
                site = pathlib.Path(p['siteRoot'])
                if not (site / 'index.html').is_file() or not (site / '.forgekit-complete').is_file(): raise RuntimeError('domain_release_missing')
                # Retrying an already-serving record leaves the previous route serving during certificate checks.
                serving = entries.get(p['id'], {}).get('serving', False)
                entries[p['id']] = {'hostname': p['hostname'], 'siteRoot': str(site), 'tlsMode': p['tlsMode'], 'serving': serving}
                apply(config(entries, hp, sp))
                deadline = time.monotonic() + 120
                while True:
                    try:
                        result = certificate(sp)
                        break
                    except Exception:
                        if time.monotonic() >= deadline: raise RuntimeError('domain_certificate_timeout')
                        time.sleep(1)
                entries[p['id']]['serving'] = True
                apply(config(entries, hp, sp))
                result = certificate(sp, True)
            # Persist config first. The recovery marker remains until state and working config are both durable.
            write(working, config(entries, hp, sp))
            write(state, entries)
            previous.unlink()
        except BaseException:
            try:
                admin(old)
                write(working, old)
                write(state, load(previous)['state'])
                previous.unlink(missing_ok=True)
            except BaseException:
                raise RuntimeError('domain_rollback_failed')
            raise
    print('B13_RESULT:' + json.dumps(result, sort_keys=True))
except BaseException as e:
    code = str(e)
    allowed = ['domain_host_not_prepared', 'domain_host_limit', 'domain_reload_failed', 'domain_config_invalid', 'domain_certificate_timeout',
      'domain_certificate_expired', 'domain_certificate_invalid', 'domain_health_failed', 'domain_release_missing', 'domain_rollback_failed',
      'domain_not_configured', 'domain_host_claim_conflict']
    print('B13_ERROR:' + (code if code in allowed else 'domain_remote_failed'))
finally:
    candidate.unlink(missing_ok=True)
    leaf.unlink(missing_ok=True)
`;
