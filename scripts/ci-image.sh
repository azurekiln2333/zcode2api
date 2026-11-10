#!/usr/bin/env bash
set -euo pipefail
: "${IMAGE:?IMAGE is required}"
docker pull "$IMAGE"
size="$(docker image inspect "$IMAGE" --format '{{.Size}}')"
echo "Published image size (uncompressed): $size bytes"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf 'Published runtime size (uncompressed): **%s bytes**\n' "$size" >> "$GITHUB_STEP_SUMMARY"
fi
if [ "$size" -gt 367001600 ]; then echo 'Runtime exceeds 350 MiB' >&2; exit 1; fi
docker run --rm --entrypoint sh "$IMAGE" -ec '
  if command -v chromium || command -v chromium-browser || test -d /usr/lib/chromium; then
    echo "Chromium must not be bundled in the gateway image" >&2
    exit 1
  fi
  node --input-type=module -e "await import(\"playwright-core\"); await import(\"./zcgw-captcha-panel.mjs\")"
'
container="$(docker run -d "$IMAGE")"
cleanup() { docker logs "$container"; docker rm -f "$container" >/dev/null; }
trap cleanup EXIT
for i in $(seq 1 30); do
  if docker exec "$container" node -e "fetch('http://127.0.0.1:'+(process.env.PORT||12283)+'/health').then(async r=>{if(!r.ok)process.exit(1);console.log(await r.text())}).catch(()=>process.exit(1))"; then
    exit 0
  fi
  sleep 1
done
echo 'Published runtime did not become healthy' >&2
exit 1
