# 保守手順

この文書は、画像処理の範囲を小さく保ち、追加課金なしで、変更、確認、公開、切り戻しを同じ順序で行うための手順です。Web版の実行にサーバー、API、外部ストレージ、実行時パッケージは必要ありません。

## 変更前

1. mainのActionsとGitHub Pagesの公開状態を確認する
2. 目的を1つに絞り、関係のない変更を同じPull Requestへ混ぜない
3. `git status --short`で既存の差分を確認する
4. mainを直接変更せず、目的が分かる作業ブランチを作る
5. README.md、SECURITY.md、CONTRIBUTING.md、MAINTENANCE.mdを確認する

APIキー、パスワード、秘密鍵、個人情報、利用者の画像をHTML、Markdown、Issue、Pull Request、コミットへ貼り付けません。分からない差分を削除したり、上書きしたりしません。

## 変更の境界

通常の修正は、該当するHTML、CSS、JavaScript、テスト、README、SECURITY.mdだけに限定します。

既定では、次を追加しません。

- 外部API、画像処理サーバー、CDN、広告、解析、Cookie
- 実行時の外部ライブラリ、外部フォント、外部ストレージ
- 利用者の画像を保存する仕組み、アカウント、フォーム
- 対応形式だけをaccept属性へ追加する変更
- `innerHTML`、`eval`、動的Function生成、外部通信

対応形式やメタデータ領域を増やす場合は、形式判定、構造検査、再エンコード、処理後検証、容量と画素数の上限、低性能端末の上限、README、SECURITY.md、テストを同じ変更で更新します。

## 自動検査

Node.js 20以降で、通常の修正は次だけを実行します。追加パッケージは不要です。

```sh
npm run verify
```

ブラウザ監査を変更確認で使う場合だけ、Playwrightを一時的に導入します。これは開発時の確認用で、公開サイトへ配信せず、追加課金も発生しません。

```sh
npm install --no-save --no-package-lock @playwright/test@1.55.0
npx playwright install chromium
node tests/browser-audit.mjs
AUDIT_RELEASE_TARGET=http://127.0.0.1:8000/ node tests/release-audit.mjs
```

監査用の`node_modules`、一時的なブラウザー、package-lock.jsonをコミットしません。ローカル表示が必要な場合は、リポジトリ直下で`python3 -m http.server 8000`を使い、file形式のURLだけで動作確認しません。

## 手動確認

画面変更や画像処理の変更では、幅280px、320px、360px、768px、1024px、1440px、スマートフォン横向きで表示を確認します。

次の順で確認します。

1. 画像を選び、JPEG、PNG、WebPを1件ずつ処理する
2. 形式不一致、壊れた入力、容量超過、画素数超過が拒否される
3. Exif、GPS、撮影日時、作者情報、コメント本文が出力へ引き継がれない
4. JSONとCSVに生のGPS座標、コメント本文、作者名が出ない
5. 元の名前を維持する設定でも、パス区切りと制御文字が安全な文字になる
6. 低性能端末向けの小さい上限で処理が中止または縮小される
7. キーボード、タッチ、縦向き、横向き、文字サイズ拡大、ダークモード、動きを減らす設定を確認する
8. 開発者ツールのNetworkで、画像処理中の外部通信がない
9. 保存後のファイルを別の信頼できる手段でも確認する

自動検査が成功しても、実機表示、処理後のファイル、ブラウザの保存動作を確認します。

## 文書と公開

対応形式、上限、外部通信、保存レポート、robots.txt、ai.txt、sitemap.xmlを変更した場合は、サイト、README.md、SECURITY.md、CONTRIBUTING.md、MAINTENANCE.mdの説明を揃えます。

Pull Requestには、変更理由、利用者への影響、低性能端末への影響、セキュリティへの影響、実行した検査、切り戻し方法を記載します。自動検査と差分確認が終わるまでmainへ反映しません。

公開後は、正規URL、robots.txt、主要操作、外部通信なし、スマートフォン表示を確認します。GitHub Pagesのプロジェクトサイトにあるrobots.txtは、ドメイン直下のrobots.txtと同じ範囲を保証しません。

## 切り戻し

問題が見つかったら、対象のPull Requestまたはマージコミットを特定してからGitHubのRevertを使います。ローカルでは次を使います。

```sh
git log --oneline -n 10
git revert <戻したいマージコミット>
git push
```

対象が分からないまま`git reset --hard`、履歴の強制push、リポジトリ削除を実行しません。切り戻し後も`npm run verify`と必要なブラウザ監査を実行します。

## AIへ保守を依頼する場合

最初に次の条件を伝えます。

```text
このリポジトリは追加課金なしのGitHub Pages静的サイトです。
画像は端末内だけで処理し、外部API、CDN、広告、解析、Cookie、永続ストレージを追加しません。
対応形式、上限、セキュリティ、README、SECURITY.md、CONTRIBUTING.md、MAINTENANCE.mdを同じ差分で確認します。
変更は小さく1目的に絞り、npm run verifyを実行してからPull Requestにします。
```

AIが提案した差分は、対象ファイル、表示幅、処理上限、外部通信、秘密情報、切り戻し方法を人が確認してから反映します。
