# Leap — エージェント向けガイド

Chrome の新しいタブを置き換える Manifest V3 拡張機能。ブックマーク・開いているタブ・最近閉じたタブを、キーボードだけでインクリメンタル検索して開ける。素の HTML/CSS/JS(ビルド工程なし)。GitHub: https://github.com/shogovv/Leap(現在 private、将来 public 予定)

## 開発を始める前に必ず読むこと

コードを変更する前に、以下を読んで設計思想と過去の判断に沿うこと。特に `philosophy.md` には「却下済みの案とその理由」があるので、同じ提案を繰り返さない。

- [Docs/philosophy.md](Docs/philosophy.md) — プロダクト・操作設計の哲学(キーボード、Enter の意味、レイアウト、言葉づかい、i18n、透明性)
- [Docs/engineering-notes.md](Docs/engineering-notes.md) — 技術的制約とハマりどころ(MV3 CSP、フォーカス問題、IME、CSS zoom、multicol 再描画バグ、性能)
- [Docs/workflow.md](Docs/workflow.md) — 進め方、検証手順(テストハーネス)、Git ルール、ドキュメント更新ルール

## リポジトリ構成

```
Leap/
├── manifest.json        MV3 マニフェスト。権限: bookmarks, tabs, sessions, storage, favicon, search
├── newtab.html          新しいタブページ本体(スタイルも <style> にインライン。JS は置けない = CSP)
├── newtab.js            全ロジック(データ読み込み、検索、選択移動、キー操作、設定モーダル、ツールチップ、Web検索)
├── i18n.js              MESSAGES(ja/en の UI 文言)、MOODS(挨拶文 5ムード × ja/en 各100)、PLACEHOLDERS・EMPTY_STATES(各10)
├── redirect-focus.js    オムニバーのフォーカス奪取の回避(自己リダイレクト)。<head> 先頭で読み込む
├── icons/               icon16.png / icon48.png / icon128.png
├── README.md            公開向け説明(英語)。機能・インストール・ショートカット表・権限の理由
├── CLAUDE.md            このファイル(AGENTS.md はこれへのシンボリックリンク)
├── .claude/             settings.json(Stop フック)と hooks/check-docs.sh(Docs 更新漏れの警告)
└── Docs/
    ├── philosophy.md
    ├── engineering-notes.md
    └── workflow.md
```

読み込み順は `redirect-focus.js`(head)→ `i18n.js` → `newtab.js`(body 末尾)。`newtab.js` は `i18n.js` のグローバル(`MESSAGES` / `MOODS` / `PLACEHOLDERS`)に依存する。

## newtab.js の主要な入口

- `init()` — 設定読み込み → ブックマーク/タブ/閉じたタブを並列ロード → `setMood` → `rollPlaceholder` → `render`
- `render()` / `applyHints()` — 描画と、選択・ヒント・件数表示・Web検索ボタンの選択状態の更新
- `queryInput` の `keydown` — Enter / Ctrl+Enter / 矢印 / Tab / Ctrl+P・N / Ctrl+文字。`paste` — URL 即遷移
- `doWebSearch()` — `chrome.search.query`
- `HELP_ROWS` + `renderSettingsPanel()` — 設定モーダルの使い方一覧(文言は `i18n.js` の `helpXxx`)
- `switchLanguage()` — 言語切替(挨拶・プレースホルダー・ラベル・描画を再構築)

## 守るルール(要点。詳細は Docs/)

- フォーカスは常に `#queryInput`。ボタンへの Tab フォーカス移動は使わない。
- 文言は必ず `i18n.js` に ja/en 両方。ユーザーのフォルダ名は翻訳しない。
- **作業を終える前に、Docs への反映を必ず確認する**。設計判断・却下案 → `Docs/philosophy.md`、ハマりどころ → `Docs/engineering-notes.md`、構成の変更 → このファイル。書くことが無ければ「Docs 更新なし(理由)」と一言添える。(Stop フックが漏れを一度だけ警告する)
- ユーザーに見える挙動(ショートカット・権限・機能)を変えたら、`HELP_ROWS`/`i18n.js`、`README.md` も同時に更新する。
- UI の変更は実際にブラウザで動かして確認する(手順は Docs/workflow.md)。テスト用ファイルは必ず後始末。
- 大きめの変更は実装前に一度確認し、プラン・説明は日本語で簡潔に。
- コミット・push はユーザーの了承を得てから。コミット末尾に `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`。
