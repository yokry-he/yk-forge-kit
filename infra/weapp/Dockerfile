# Build from repository root. Deployments must scan and pin the resulting image digest.
FROM node:22-bookworm AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @forgekit/worker... build
RUN pnpm --filter @forgekit/worker --prod deploy --legacy /opt/weapp
FROM node:22-bookworm-slim AS production
COPY --from=build /opt/weapp /opt/weapp
WORKDIR /tmp
USER node
CMD ["node", "/opt/weapp/dist/weapp-ci.js"]

# Offline CI target: no WeChat calls or real credentials.
FROM node:22-bookworm-slim AS test
COPY --from=build /opt/weapp /opt/weapp
RUN rm -rf /opt/weapp/node_modules/miniprogram-ci && mkdir /opt/weapp/node_modules/miniprogram-ci
COPY infra/weapp/mock-ci.cjs /opt/weapp/node_modules/miniprogram-ci/index.js
WORKDIR /tmp
USER node
CMD ["node", "/opt/weapp/dist/weapp-ci.js"]

FROM production AS final
