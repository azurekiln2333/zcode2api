# 阶段一：构建 Vue 控制台（web/dist）
FROM node:24-alpine AS webbuild
WORKDIR /build
COPY package.json ./
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./
RUN npm run build

# 阶段二：Node 运行时 + 与 zcode-switch 一致的 curl 查询通道
FROM node:24-alpine
RUN apk add --no-cache curl ca-certificates

# 容器内以非 root 运行
RUN addgroup -S zcgw && adduser -S zcgw -G zcgw
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# 先拷程序（利用层缓存；数据卷挂 /app/data）
COPY --chown=zcgw:zcgw package.json zcgw-server.mjs zcgw-store.mjs zcgw-fingerprint.mjs zcgw-quota.mjs zcgw-coding.mjs zcgw-claim.mjs zcgw-upstream.mjs zcgw-version.mjs zcgw-auto-claim.mjs zcgw-captcha-browser.mjs zcgw-captcha-panel.mjs zcgw-oidc.mjs zcgw-sso.mjs THIRD_PARTY_NOTICES.md zcode-profile.json dashboard.html ./
COPY --from=webbuild --chown=zcgw:zcgw /build/web/dist ./web/dist

# 数据目录由 compose 挂载到宿主机 ./data（宿主机需 chown 100:101 给容器内 zcgw 用户）
RUN mkdir -p /app/data && chown zcgw:zcgw /app/data
ENV ZCGW_DATA_DIR=/app/data
# 统一部署的 compose 不再传 HOST/PORT，容器监听端口完全取这里的默认值：
# 宿主机映射 12283:12283，平台面板按 http://zcode:12283 访问。
# 自带 compose 显式传 PORT 时仍然以 env 为准。
ENV HOST=0.0.0.0
ENV PORT=12283
USER zcgw
# Only the browser protocol client is installed; captcha runs in an existing browser.

EXPOSE 12283
# 自带健康检查，compose 不必再写一份；按 PORT 探测，改了端口也能用。
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||12283)+'/health').then((r)=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "zcgw-server.mjs"]
