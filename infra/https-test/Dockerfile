# Offline internal CA; no ACME/public DNS/cloud credentials in this fixture.
FROM caddy:2.10.2 AS caddy
FROM forgekit-sshd-test:b12
RUN apt-get update && apt-get install -y --no-install-recommends python3 openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY infra/caddy-host/prepare.py /opt/forgekit-prepare.py
EXPOSE 80 443
CMD ["sh", "-c", "ssh-keygen -A && runuser -u deploy -- python3 /opt/forgekit-prepare.py /srv/forgekit && (runuser -u deploy -- caddy run --config /srv/forgekit/.forgekit-caddy/caddy.json &) && exec /usr/sbin/sshd -D -e"]
