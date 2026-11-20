#!/usr/bin/env python3
"""Operator-only initialization. Run once as the dedicated B12 SSH/Caddy user."""
import json
import os
import pathlib
import re
import sys

base = sys.argv[1] if len(sys.argv) > 1 else '/srv/forgekit'
if not re.fullmatch(r'/(srv|home|var/www)/[a-zA-Z0-9_-]+(/[a-zA-Z0-9_-]+)*', base):
    raise SystemExit('invalid_base_path')
http_port = int(sys.argv[2]) if len(sys.argv) > 2 else 80
https_port = int(sys.argv[3]) if len(sys.argv) > 3 else 443
if not all(1 <= port <= 65535 for port in [http_port, https_port]) or http_port == https_port:
    raise SystemExit('invalid_ports')
os.umask(0o077)
root = pathlib.Path(base) / '.forgekit-caddy'
root.mkdir(mode=0o700)  # Refuse to overwrite an existing installation.
config = {'admin': {'listen': 'unix/' + str(root / 'admin.sock')},
          'storage': {'module': 'file_system', 'root': str(root / 'data')}}
for name, value in [('caddy.json', config), ('state.json', {}), ('settings.json', {'httpPort': http_port, 'httpsPort': https_port})]:
    with open(root / name, 'x') as output:
        json.dump(value, output)
print(str(root / 'caddy.json'))
