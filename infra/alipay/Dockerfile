# Build from repository root. No account credentials are used during image creation.
FROM node:22-bookworm AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @forgekit/worker... build
RUN pnpm --filter @forgekit/worker --prod deploy --legacy /opt/alipay

FROM node:22-bookworm-slim AS runtime
COPY --from=build /opt/alipay /opt/alipay
WORKDIR /tmp

# Compiler/resources must already exist before a key reaches the container.
FROM runtime AS production
RUN mkdir /opt/alipay-home && HOME=/opt/alipay-home MINIDEV_RUNTIME_CONFIG='{"compiler.skipLatestCheck":true,"compiler.version.cube":"0.100.12"}' node /opt/alipay/node_modules/minidev/bin/minidev.js download-assets --with-compiler
RUN chmod -R a+rX /opt/alipay-home
USER node
CMD ["node", "/opt/alipay/dist/alipay-ci.js"]

# Offline fixture: no compiler download, real account or Alipay network.
FROM runtime AS test
RUN rm -rf /opt/alipay/node_modules/minidev && mkdir -p /opt/alipay/node_modules/minidev /opt/alipay-home/.minidev
COPY infra/alipay/mock-ci.cjs /opt/alipay/node_modules/minidev/index.js
USER node
CMD ["node", "/opt/alipay/dist/alipay-ci.js"]

FROM production AS final
