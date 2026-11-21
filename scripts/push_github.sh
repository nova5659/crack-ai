#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

REPO_URL="${1:-}"
if [ -z "$REPO_URL" ]; then
  echo "사용법: ./scripts/push_github.sh https://github.com/<아이디>/<저장소명>.git"
  exit 1
fi

echo "1️⃣ 정적 웹 카탈로그 빌드 중 (50개 월드)..."
node ./scripts/build_web.mjs

echo "2️⃣ Git 커밋 및 main 브랜치 푸시..."
git add .
git diff --cached --quiet || git commit -m "Deploy CRACK AI to GitHub Pages (50 worlds + Age of Nations)"
git branch -M main

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REPO_URL"
else
  git remote add origin "$REPO_URL"
fi

git push -u origin main

echo ""
echo "✅ 푸시 완료!"
echo "👉 GitHub 저장소 → Settings → Pages → Source를 'GitHub Actions'로 선택하면"
echo "   약 30초 뒤 https://<아이디>.github.io/<저장소명>/ 주소로 24시간 무료 오픈됩니다!"
