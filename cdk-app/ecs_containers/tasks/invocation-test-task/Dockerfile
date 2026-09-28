# syntax=docker/dockerfile:1-labs@sha256:63e440b412b6acba117974e793b7e7f702e58ee65e044bdff1b8d388ee0d853b
# Pinned by digest, not by tag. The runner asks BuildKit to build this image on
# every task submission, and a floating tag makes each of those a registry
# round-trip: one TLS hiccup at auth.docker.io then fails a task run for a
# reason that has nothing to do with the task. A digest resolves from the local
# content store once it has been fetched, so the edit loop keeps working while
# the network does not. Update it deliberately, with docker pull.
#
# The build context is the repository root, for the same reason a service's is:
# the container installs from the root lockfile so npm workspaces can resolve
# `@repo/*`. Pointing the context at this directory breaks every --workspace line.
FROM node:24-bookworm-slim
WORKDIR /workspace

# Manifests before sources, following Dockerfile.dev: editing this task must not
# reinstall the workspace, and npm's cache is a build cache mount so a rebuild
# does not re-download either. The glob reaches every depth, so adding a
# workspace needs no edit here. `--parents` is what needs the syntax directive
# above.
COPY --parents package.json package-lock.json ./**/package.json ./
# This task uses no database code, so it needs no generated Prisma client.
# Skip only the root generation hook; dependency install scripts still run.
RUN --mount=type=cache,target=/root/.npm \
    cp package.json /tmp/workspace-package.json \
    && npm pkg delete scripts.postinstall \
    && npm ci --prefer-offline --no-audit --no-fund \
    && mv /tmp/workspace-package.json package.json

# Framework callback helpers and the task's source. Frontend and documentation
# edits do not invalidate this image.
COPY packages/framework/src ./packages/framework/src
COPY cdk-app/ecs_containers/tasks/invocation-test-task \
     ./cdk-app/ecs_containers/tasks/invocation-test-task

# One stage, because the second one was a copy of the first. It ran
# `COPY --from=build /workspace ./`, which pruned nothing and dropped nothing —
# it re-exported the whole installed workspace, and measured at ~96 seconds on
# every source-only rebuild against ~3 seconds without it. A stage that removed
# dev dependencies or built a dist would earn its keep; this one did not.
ENV NODE_ENV=production

# No EXPOSE and no health check: this container runs to completion. Its exit
# status is the result, and its stdout is diagnostic rather than a business
# output channel.
#
# The TypeScript entrypoint is launched directly rather than through
# `npm run start`. The wrapper printed an npm banner and an update notice ahead
# of every run - npm talking about itself in the middle of a workload's log -
# and cost about 2.7 seconds of startup for it. `tsx` resolves from
# /workspace/node_modules, where npm workspaces hoists it.
CMD ["node", "--import", "tsx", "cdk-app/ecs_containers/tasks/invocation-test-task/src/index.ts"]
