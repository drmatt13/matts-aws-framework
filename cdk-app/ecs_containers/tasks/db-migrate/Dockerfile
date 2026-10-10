# syntax=docker/dockerfile:1-labs@sha256:63e440b412b6acba117974e793b7e7f702e58ee65e044bdff1b8d388ee0d853b
# Pinned by digest, not by tag, as every framework image is. Update it
# deliberately, with docker pull.
#
# Applies the committed migrations to the deployment's database. The database
# sits in the network's isolated subnets and nothing outside the VPC reaches it,
# so this task is how a release migrates it: npm run db:migrate:cloud. Locally,
# Compose's prisma-migrate service does the same job against Postgres.
#
# The build context is the repository root, so npm workspaces resolve @repo/*.
FROM node:24-bookworm-slim
WORKDIR /workspace

# openssl: Prisma's engine. ca-certificates: TLS to the database is verified
# against the RDS bundle the framework writes, and to everything else against
# the system store.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Manifests before sources, following Dockerfile.dev: editing a migration must
# not reinstall the workspace.
COPY --parents package.json package-lock.json ./**/package.json ./
RUN --mount=type=cache,target=/root/.npm \
    cp package.json /tmp/workspace-package.json \
    && npm pkg delete scripts.postinstall \
    && npm ci --prefer-offline --no-audit --no-fund \
    && mv /tmp/workspace-package.json package.json

# The contract and the migration packages it applies, then the framework's
# database helper and this task's entry point.
COPY packages/database/prisma.config.ts ./packages/database/prisma.config.ts
COPY packages/database/prisma ./packages/database/prisma
RUN npm --workspace @repo/database run generate
COPY packages/framework/src ./packages/framework/src
COPY cdk-app/ecs_containers/tasks/db-migrate ./cdk-app/ecs_containers/tasks/db-migrate

ENV NODE_ENV=production
CMD ["node", "--import", "tsx", "cdk-app/ecs_containers/tasks/db-migrate/migrate.ts"]
