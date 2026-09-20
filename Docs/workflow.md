# Leap 開発の進め方(コラボレーション・検証・コミット)

## 進め方

- **大きめの変更は、実装前に一度確認する**。何をやるかを整理して見せ、合意してから着手する。
- **プランや説明は日本語で**。簡潔に。壁打ちの場面では、推奨案と主なトレードオフを短く出し、ユーザーが方向転換できる形にする。
- **見た目・操作の変更は、実装前に動くモックアップ(HTML)で見せる**。Artifact ではなく、ローカルサーバー経由でブラウザパインに開く。フローチャートが必要なときは簡単なテキスト図で足りる。
- 案を出すときは、響きや見た目だけでなく、機能・ワークフローとの繋がりを説明する。
- 「賢そうな」暗黙挙動より、予測できる単純な挙動を選ぶ。案を出して却下されたものは `philosophy.md` に理由ごと残す。

## 検証(UI の変更は必ず実際に動かす)

型チェックやテストではなく、機能として動くかをブラウザで確かめる。

1. `node --check newtab.js i18n.js` と `python3 -m json.tool manifest.json` で構文確認。
2. テストハーネスを作る:`newtab.html` をコピーして `_test-newtab.html` にし、`i18n.js` の前に `chrome.*` のスタブ `<script>` を差し込む。
   - スタブは **Promise を返す形**にする(実コードは `await` している)。
   - `chrome.runtime.getURL` は絶対 URL を返す(`location.origin + path`)。`new URL()` に渡されるため。
   - `chrome.search.query` はスタブで呼び出し内容を記録して検証する。
   - `redirect-focus.js` はハーネスでは外す。
3. **`file://` では開かない**。プレビューペインは `file://` を不活性な `data:` URL にするため、外部 `<script src>` が読めない。`python3 -m http.server <port>` で配信して `http://localhost:<port>/...` を開く。
4. ブラウザツールでスクリーンショット・`javascript_exec` によるイベント発火(`KeyboardEvent` / `ClipboardEvent`)で挙動を確認する。`defaultPrevented`、選択状態、スタブの呼び出しを見る。
5. ブラウザパインのタブは溜まる。操作対象は `tabId` を明示する(前面タブと違うことがある)。
6. 終わったら**必ず後始末**:サーバーを `pkill`、`_test-*.html` や `_mockup-*.html` を削除、不要タブを閉じる。`git status` でテスト用ファイルが残っていないことを確認。

## Git

- コミットは頼まれたときだけ。push も、ユーザーの了承を取ってから。
- コミットメッセージの末尾に `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`(システムリマインダーの指示に従う)。PR 説明の末尾も同様。
- 既存コミットの amend / force push は、明示的に頼まれない限りしない。まだ push していない直前のコミットへの追記が必要な場合のみ、状況を説明したうえで検討する。
- 一時ファイルや `.DS_Store` をコミットに含めない(`git status` を確認してから add)。

## ドキュメントの更新

- ユーザーに見える挙動(ショートカット、権限、機能)を変えたら、同じ変更の中で以下も更新する:
  - `i18n.js` の使い方一覧(`helpXxx` キーと `newtab.js` の `HELP_ROWS`)
  - `README.md` の機能・ショートカット表・権限表
  - 設定パネルの「AIに使い方を教えてもらう」プロンプト(`aiPrompt`)に影響するなら、そこも
- 設計の判断(特に却下した案とその理由)は `Docs/philosophy.md`、ハマりどころは `Docs/engineering-notes.md` に追記する。
- **作業を終える前に必ず確認する**:今回の変更で、上記のどこかに書くべきことが生まれていないか。無ければ「Docs 更新なし(理由)」と一言添える。
- この確認は仕組みでも補強している:`.claude/settings.json` の Stop フック(`.claude/hooks/check-docs.sh`)が、`newtab.js` / `newtab.html` / `i18n.js` / `manifest.json` / `redirect-focus.js` だけが変更され、`Docs/` `README.md` `CLAUDE.md` が未変更のときに一度だけ警告する(2回目の終了は通す)。他のエージェントでは効かないので、上記のルール自体が本体。
