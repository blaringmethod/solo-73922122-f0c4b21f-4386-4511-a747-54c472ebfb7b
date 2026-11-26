# 零外部依赖：仅使用 Node.js 内置模块，无需 npm install
FROM node:22-alpine

WORKDIR /app

# 先拷贝清单（保留缓存层；即使将来加入依赖也可在此 npm ci）
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public

# 持久化目录，并交给非 root 的 node 用户
RUN mkdir -p /app/data && chown -R node:node /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_FILE=/app/data/state.json

USER node

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=4s --start-period=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]
