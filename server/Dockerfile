FROM node:20-slim
WORKDIR /app
COPY server/package.json ./
RUN npm install --omit=dev
COPY server/server.js ./
COPY server/public/ ./public/
COPY agent/ ./agent/
RUN mkdir -p /app/data
EXPOSE 7700
CMD ["node", "server.js"]
