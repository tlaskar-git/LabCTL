# labctl-updater: no npm dependencies. The docker CLI is only used by the optional mounted-checkout git mode.
# The default git mode needs no git binary: the host Docker daemon fetches the source.
# Runs as root because the Docker socket is root-owned. Never publish a port and never attach a routable network.
FROM node:22-alpine
RUN apk add --no-cache docker-cli docker-cli-compose
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY updater/package.json updater/updater.js ./
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "updater.js"]
