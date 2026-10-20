# Build stage: compiles better-sqlite3 if no prebuilt binary matches.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# WinRM stage: pywinrm in a venv for src/deploy/winrm_helper.py (Negotiate/NTLM sign-in with message encryption).
# Wheels only, exact pins. The runtime stage copies the venv and adds the plain python3 it links to.
FROM node:22-bookworm-slim AS winrm
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*
COPY server/src/deploy/winrm-requirements.txt /tmp/winrm-requirements.txt
RUN python3 -m venv /opt/winrm-venv \
  && /opt/winrm-venv/bin/pip install --no-cache-dir --disable-pip-version-check --only-binary=:all: -r /tmp/winrm-requirements.txt \
  && /opt/winrm-venv/bin/python -c "import winrm, spnego, requests_ntlm"

# Runtime stage: no compilers, runs as the non-root node user.
FROM node:22-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/tlaskar-git/LabCTL" org.opencontainers.image.title="labctl"
ENV NODE_ENV=production DATA_DIR=/app/data PORT=7700
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=winrm /opt/winrm-venv /opt/winrm-venv
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
