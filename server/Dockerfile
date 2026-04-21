# Multi-stage build for the Next.js backend (server/ in the monorepo).
# Uses Next.js's standalone output to keep the runtime image small.

ARG NODE_VERSION=20-bookworm-slim

# ---------- deps ----------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
# Workspace context is the repo root; we install only the server's deps.
COPY server/package.json server/package-lock.json* ./
# `npm ci` was crashing with "Exit handler never called!" inside the
# resource-constrained build container on the prod box (npm 10.8.2, node
# 20.20.2). `npm install` with the same lock file works reliably and is
# functionally equivalent for a clean checkout. --no-audit/--no-fund
# avoid network round-trips that occasionally hang the install. Also do
# NOT pass --ignore-scripts: it suppresses .bin/ creation on this npm,
# leaving `next` unfindable.
RUN npm install --no-audit --no-fund

# ---------- build ----------
FROM node:${NODE_VERSION} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY server/ ./
# Repo-root files referenced at runtime (for /AGENTS.md, /privacy, etc.).
COPY AGENTS.md /AGENTS.md
COPY docs/ /docs/
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------- runtime ----------
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Debian/bookworm-slim version of the addgroup/adduser commands.
RUN groupadd -r appendpage && useradd -r -g appendpage -s /usr/sbin/nologin appendpage

# Copy the standalone build output. server/ becomes the runtime cwd so
# `process.cwd()/../AGENTS.md` resolves to the repo-root copy we placed at /AGENTS.md.
COPY --from=build --chown=appendpage:appendpage /app/.next/standalone /app/
COPY --from=build --chown=appendpage:appendpage /app/.next/static /app/.next/static
# Repo-root files used by the markdown routes — colocated next to /app/server
# so the route handlers resolve them via process.cwd()/../AGENTS.md.
COPY --from=build --chown=appendpage:appendpage /AGENTS.md /AGENTS.md
COPY --from=build --chown=appendpage:appendpage /docs /docs
# Migrations + migrate runner script (runs once on container start).
COPY --chown=appendpage:appendpage migrations /migrations
COPY --chown=appendpage:appendpage server/scripts /app/scripts

# Next.js standalone output places the entry at /app/server.js (verified at
# build time by inspecting the image; Next 15.5 with `output: "standalone"`
# from a server/ subdirectory still flattens to top-level server.js).
USER appendpage
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
