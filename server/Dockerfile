# Build stage: compiles better-sqlite3 if no prebuilt binary matches.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# Runtime stage: no compilers, runs as the non-root node user.
FROM node:22-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/tlaskar-git/LabCTL" org.opencontainers.image.title="labctl"
ENV NODE_ENV=production DATA_DIR=/app/data PORT=7700
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY server/package.json server/server.js ./
COPY server/src/ ./src/
COPY server/public/ ./public/
COPY agent/ ./agent/
COPY VERSION ./VERSION
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME /app/data
EXPOSE 7700
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:7700/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
