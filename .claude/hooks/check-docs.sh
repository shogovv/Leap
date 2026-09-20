#!/bin/bash
# Stop hook: if source files changed but Docs/README/CLAUDE.md didn't, ask once for a docs pass.
# stop_hook_active guards against looping — the second stop attempt is always allowed.
input=$(cat)
if echo "$input" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then exit 0; fi

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
changed=$(git status --porcelain 2>/dev/null | sed 's/^...//')
[ -z "$changed" ] && exit 0

echo "$changed" | grep -Eq '^(newtab\.(js|html)|i18n\.js|manifest\.json|redirect-focus\.js)$' || exit 0
echo "$changed" | grep -Eq '^(Docs/|README\.md|CLAUDE\.md)' && exit 0

cat >&2 <<'MSG'
ソースを変更しましたが、Docs / README.md / CLAUDE.md が更新されていません。
Docs/workflow.md の「ドキュメントの更新」に従って確認してください:
- 設計判断・却下した案 → Docs/philosophy.md
- ハマりどころ・制約 → Docs/engineering-notes.md
- ショートカット・権限・機能の変更 → README.md と i18n.js の使い方一覧
- リポジトリ構成が変わった → CLAUDE.md
記録すべきことが無い場合は、その旨を一言添えて終了して構いません。
MSG
exit 2
