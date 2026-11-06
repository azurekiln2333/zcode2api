#!/usr/bin/env bash
# 零依赖后端的共享 CI 校验脚本：GitHub Actions 与 CNB 流水线共用。
# 步骤：语法检查 → 空数据目录冷启动 → /health 探活 → 空池聊天请求应得到明确 503。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> node $(node --version)"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
echo "==> 语法检查"
node --check zcgw-server.mjs
node --check zcgw-fingerprint.mjs
node --check zcgw-quota.mjs
node --check zcgw-claim.mjs
node --check zcgw-upstream.mjs
node --check zcgw-version.mjs
node --check zcgw-auto-claim.mjs
node --check zcgw-captcha-browser.mjs
node scripts/check-version.mjs
node --test tests/*.test.mjs

echo "==> 冷启动冒烟（空数据目录）"
DATA_DIR="$(mktemp -d)"
PORT="${CI_PORT:-12283}"
ZCGW_DATA_DIR="$DATA_DIR" ZCODE_HOME="$DATA_DIR/no-zcode" HOST=127.0.0.1 PORT="$PORT" \
  node zcgw-server.mjs > "$DATA_DIR/server.log" 2>&1 &
SRV_PID=$!
cleanup() { kill "$SRV_PID" 2>/dev/null || true; rm -rf "$DATA_DIR"; }
trap cleanup EXIT

for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health" > "$DATA_DIR/health.json" 2>/dev/null; then break; fi
  if ! kill -0 "$SRV_PID" 2>/dev/null; then
    echo "server exited during boot:" >&2; cat "$DATA_DIR/server.log" >&2; exit 1
  fi
  sleep 0.5
  if [ "$i" = 30 ]; then echo "health check timed out" >&2; cat "$DATA_DIR/server.log" >&2; exit 1; fi
done
cat "$DATA_DIR/health.json"
echo

echo "==> 空池聊天请求应返回 503 提示"
code="$(curl -s -o "$DATA_DIR/chat.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/messages" \
  -H 'content-type: application/json' \
  -d '{"model":"GLM-5.3-Flash","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}')"
cat "$DATA_DIR/chat.json"; echo
if [ "$code" != "503" ]; then echo "expected 503 for empty pool, got $code" >&2; exit 1; fi

echo "==> dashboard.html 可访问"
# 完整读取后用字符串匹配：pipefail 下 grep -q 提前退出会杀掉管道对端（exit 23/141）
page="$(curl -fsS "http://127.0.0.1:$PORT/dashboard")"
if [[ "$page" != *'账号池控制台'* ]]; then
  echo "dashboard missing title marker" >&2
  exit 1
fi

# 控制台构建校验（web/ 存在时：npm ci + vue-tsc 类型检查 + vite 打包）
if [ -f web/package.json ]; then
  echo "==> 构建控制台（vue-tsc + vite）"
  (cd web && npm ci --no-audit --no-fund --loglevel=error && npm run build)
fi

echo "==> CI backend OK"
