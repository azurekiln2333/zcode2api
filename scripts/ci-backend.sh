#!/usr/bin/env bash
# 零依赖后端的共享 CI 校验脚本：GitHub Actions 与 CNB 流水线共用。
# 步骤：语法检查 → 单元测试 → 空数据目录冷启动 → /health 探活 →
#       无密钥必须 401（默认拒绝）→ 配好主密钥后空池仍返回明确 503。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> node $(node --version)"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
echo "==> 语法检查"
node --check zcgw-server.mjs
node --check zcgw-fingerprint.mjs
node --check zcgw-quota.mjs
node --check zcgw-coding.mjs
node --check zcgw-claim.mjs
node --check zcgw-upstream.mjs
node --check zcgw-version.mjs
node --check zcgw-auto-claim.mjs
node --check zcgw-captcha-browser.mjs
node --check zcgw-captcha-panel.mjs
node --check zcgw-oidc.mjs
node --check zcgw-sso.mjs
node scripts/check-version.mjs
node --test tests/*.test.mjs

echo "==> 冷启动冒烟（空数据目录）"
DATA_DIR="$(mktemp -d)"
PORT="${CI_PORT:-12283}"
# 冒烟用主密钥：只用来证明「带密钥能穿过鉴权」，与实际部署的密钥无关
CI_GATEWAY_KEY="ci-smoke-gateway-key"
SRV_PID=""

cleanup() {
  if [ -n "$SRV_PID" ]; then kill "$SRV_PID" 2>/dev/null || true; wait "$SRV_PID" 2>/dev/null || true; fi
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

# start_server <日志名> [额外的 VAR=value ...]
start_server() {
  local name="$1"; shift
  env ZCGW_DATA_DIR="$DATA_DIR" ZCODE_HOME="$DATA_DIR/no-zcode" HOST=127.0.0.1 PORT="$PORT" "$@" \
    node zcgw-server.mjs > "$DATA_DIR/$name.log" 2>&1 &
  SRV_PID=$!
  for i in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/health" > "$DATA_DIR/health.json" 2>/dev/null; then return 0; fi
    if ! kill -0 "$SRV_PID" 2>/dev/null; then
      echo "server exited during boot:" >&2; cat "$DATA_DIR/$name.log" >&2; exit 1
    fi
    sleep 0.5
  done
  echo "health check timed out" >&2; cat "$DATA_DIR/$name.log" >&2; exit 1
}

stop_server() {
  kill "$SRV_PID" 2>/dev/null || true
  wait "$SRV_PID" 2>/dev/null || true
  SRV_PID=""
  # 等端口真正释放，避免下一次启动撞上端口占用
  for _ in $(seq 1 20); do
    if ! curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then return 0; fi
    sleep 0.25
  done
}

# post_messages <输出文件> [额外请求头]
post_messages() {
  if [ -n "${2:-}" ]; then
    curl -s -o "$1" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/messages" \
      -H 'content-type: application/json' -H "$2" \
      -d '{"model":"GLM-5.3-Flash","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}'
  else
    curl -s -o "$1" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/messages" \
      -H 'content-type: application/json' \
      -d '{"model":"GLM-5.3-Flash","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}'
  fi
}

echo "==> 冒烟一：没有任何密钥时，推理接口必须 401（默认拒绝，不含本机回环例外）"
start_server no-key
cat "$DATA_DIR/health.json"
echo
code="$(post_messages "$DATA_DIR/chat-unconfigured.json")"
cat "$DATA_DIR/chat-unconfigured.json"; echo
if [ "$code" != "401" ]; then echo "expected 401 when no API key is configured, got $code" >&2; exit 1; fi
if ! grep -q '尚未配置 API 密钥' "$DATA_DIR/chat-unconfigured.json"; then
  echo "401 body must explain that no API key is configured" >&2; exit 1
fi
stop_server

echo "==> 冒烟二：配好 GATEWAY_KEY 后，空池建账请求仍返回明确的 503"
start_server with-key GATEWAY_KEY="$CI_GATEWAY_KEY"
cat "$DATA_DIR/health.json"
echo
code="$(post_messages "$DATA_DIR/chat-anonymous.json")"
cat "$DATA_DIR/chat-anonymous.json"; echo
if [ "$code" != "401" ]; then echo "expected 401 for a keyless request, got $code" >&2; exit 1; fi
code="$(post_messages "$DATA_DIR/chat.json" "Authorization: Bearer $CI_GATEWAY_KEY")"
cat "$DATA_DIR/chat.json"; echo
if [ "$code" != "503" ]; then echo "expected 503 for empty pool, got $code" >&2; exit 1; fi
if ! grep -q '尚未纳管任何账号' "$DATA_DIR/chat.json"; then
  echo "503 body must explain that the account pool is empty" >&2; exit 1
fi

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
