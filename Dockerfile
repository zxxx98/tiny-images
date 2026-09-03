# ---- 构建：前端 + 后端 ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY web/ web/
RUN npm run build -w web
COPY server/ server/
RUN npm run build -w server

# ---- 运行：仅生产依赖 + 构建产物 ----
FROM node:22-alpine AS runtime
WORKDIR /app
# 下载水印的中文署名依赖 CJK 字体，缺省 alpine 会渲染为方框
RUN apk add --no-cache fontconfig font-noto-cjk
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000
COPY package.json package-lock.json ./
COPY server/package.json server/
RUN npm ci --workspace server --omit=dev && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "server/dist/index.js"]
