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
RUN apk add --no-cache curl ca-certificates chromium

# 容器内以非 root 运行
RUN addgroup -S zcgw && adduser -S zcgw -G zcgw
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# 先拷程序（利用层缓存；数据卷挂 /app/data）
COPY --chown=zcgw:zcgw package.json zcgw-server.mjs zcgw-fingerprint.mjs zcgw-quota.mjs zcgw-claim.mjs zcgw-upstream.mjs zcgw-version.mjs zcgw-auto-claim.mjs zcgw-captcha-browser.mjs THIRD_PARTY_NOTICES.md zcode-profile.json dashboard.html ./
COPY --from=webbuild --chown=zcgw:zcgw /build/web/dist ./web/dist

# 数据目录由 compose 挂载到宿主机 ./data（宿主机需 chown 100:101 给容器内 zcgw 用户）
RUN mkdir -p /app/data && chown zcgw:zcgw /app/data
ENV ZCGW_DATA_DIR=/app/data
USER zcgw
# Validate Chromium under the same non-root user as the deployed scheduler.
RUN node --input-type=module -e "import { chromium } from 'playwright-core'; const b = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] }); const p = await b.newPage(); await p.setContent('<title>zcgw</title>'); if (await p.title() !== 'zcgw') throw new Error('Chromium smoke check failed'); await b.close();"

EXPOSE 8787
CMD ["node", "zcgw-server.mjs"]
