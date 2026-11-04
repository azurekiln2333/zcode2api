# 阶段一：构建 Vue 控制台（web/dist）
FROM node:24-alpine AS webbuild
WORKDIR /build
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./
RUN npm run build

# 阶段二：零依赖运行时（只需要 node 本体 + 构建好的静态控制台）
FROM node:24-alpine

# 容器内以非 root 运行
RUN addgroup -S zcgw && adduser -S zcgw -G zcgw
WORKDIR /app

# 先拷程序（利用层缓存；数据卷挂 /app/data）
COPY --chown=zcgw:zcgw zcgw-server.mjs zcgw-fingerprint.mjs zcode-profile.json dashboard.html ./
COPY --from=webbuild --chown=zcgw:zcgw /build/dist ./web/dist

# 数据目录由 compose 挂载到宿主机 ./data（宿主机需 chown 100:101 给容器内 zcgw 用户）
RUN mkdir -p /app/data && chown zcgw:zcgw /app/data
ENV ZCGW_DATA_DIR=/app/data
USER zcgw

EXPOSE 8787
CMD ["node", "zcgw-server.mjs"]
