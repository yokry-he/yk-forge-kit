# Disposable fake Linux host. No cloud account or embedded private key.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server coreutils util-linux tar \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/sh deploy && passwd -d deploy \
    && install -d -m 0755 /run/sshd \
    && install -d -o deploy -g deploy -m 0700 /home/deploy/.ssh \
    && install -d -o deploy -g deploy -m 0755 /srv/forgekit \
    && printf '\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nAllowUsers deploy\nAllowAgentForwarding no\nAllowTcpForwarding no\nX11Forwarding no\n' >> /etc/ssh/sshd_config
EXPOSE 22
CMD ["sh", "-c", "ssh-keygen -A && exec /usr/sbin/sshd -D -e"]
