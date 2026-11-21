#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

echo "1️⃣ 정적 웹 카탈로그 생성 중 (49개 오리지널 + 메이저 애니 월드)..."
node ./scripts/build_web.mjs

echo "2️⃣ Netlify 24시간 상시 클라우드 배포 시작..."
echo "   (처음 실행 시 브라우저가 열리며 무료 Netlify 계정 로그인 후 영구 HTTPS 주소가 발급됩니다)"
npx --yes netlify-cli deploy --prod --dir=web --functions=netlify/functions
