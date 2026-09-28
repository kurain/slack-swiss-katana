# slack-swiss-katana — Slack Poll

Slack 上で完結するアンケートツール (Polly 風)。Cloudflare Workers + D1 でホスティングします。

- `/poll <質問>` でアンケート作成モーダルが開く
- 選択肢・投稿先チャンネル・匿名/結果非公開の設定をモーダルで入力
- 投票はチャンネルに投稿されたメッセージのボタンから (択一)
- 同じユーザーは 1 票のみ。同じ選択肢をもう一度押すと取り消し、別の選択肢を押すと変更
- 匿名投票では投票者 ID をハッシュ化して保存 (誰が投票したか復元不可、二重投票は防止)
- 結果は「リアルタイム表示」か「投票終了まで非公開」を選択可能。終了は作成者のみ
- 結果は D1 に永続化

## 構成

```
src/
  index.ts              Hono エントリポイント (署名検証ミドルウェア + ルーティング)
  types.ts              型定義
  db.ts                 D1 リポジトリ (作成 / 投票 / 集計 / 終了)
  slack/verify.ts       Slack リクエスト署名検証
  slack/api.ts          Slack Web API クライアント
  slack/blocks.ts       モーダルとメッセージの Block Kit 生成
  handlers/command.ts   /poll スラッシュコマンド
  handlers/interactions.ts  モーダル送信・ボタン押下
migrations/0001_init.sql  D1 スキーマ
slack-app-manifest.json   Slack アプリのマニフェスト
test/                     vitest
```

## セットアップ

### 1. 依存関係

```sh
npm install
```

### 2. D1 データベース

```sh
npm run db:create   # 出力された database_id を wrangler.jsonc に書き込む
npm run db:migrate  # 本番 DB にスキーマ適用
```

### 3. Slack アプリ

1. https://api.slack.com/apps → **Create New App** → **From a manifest** で `slack-app-manifest.json` の内容を貼り付ける
2. マニフェスト内の `YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev` はデプロイ後の URL に置き換える
3. ワークスペースにインストールし、以下を控える
   - **Basic Information → Signing Secret**
   - **OAuth & Permissions → Bot User OAuth Token** (`xoxb-...`)

必要な Bot スコープ: `commands`, `chat:write`, `chat:write.public`, `im:write`

### 4. シークレット

```sh
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put VOTER_HASH_SECRET   # 長いランダム文字列 (匿名投票のハッシュ用)
```

### 5. デプロイ

```sh
npm run deploy
```

デプロイ後、Slack アプリ設定の以下 2 箇所を Worker の URL に合わせます (マニフェストで設定済みなら URL の置換だけ)。

| 設定箇所 | URL |
| --- | --- |
| Slash Commands → `/poll` の Request URL | `https://<worker>/slack/commands` |
| Interactivity & Shortcuts → Request URL | `https://<worker>/slack/interactions` |

## ローカル開発

```sh
cp .dev.vars.example .dev.vars   # 値を埋める
npm run db:migrate:local
npm run dev                       # http://localhost:8787
```

Slack から到達させるには `cloudflared tunnel --url http://localhost:8787` などで公開し、その URL を Slack アプリ設定に入れてください。

```sh
npm test          # 単体テスト
npm run typecheck
```

## 使い方

1. チャンネルで `/poll 次の懇親会はいつにしますか？`
2. モーダルで選択肢を 1 行 1 つで入力 (2〜10 個)、必要ならオプションにチェック
   - **匿名投票にする**: 誰が何に投票したか表示しない
   - **結果を投票終了まで非公開にする**: 終了まで集計を隠す (投票数のみ表示)
3. **投稿する** でチャンネルにアンケートが投稿される
4. 各選択肢の **投票** ボタンで投票。匿名または結果非公開のときは本人にだけ確認メッセージが届く
5. 作成者が **投票を終了** を押すと以降の投票は締め切られ、結果が全員に表示される

プライベートチャンネルに投稿する場合は、事前に `/invite @poll` でアプリを招待してください (公開チャンネルは `chat:write.public` で招待不要)。

## データモデル

- `polls`: 質問、投稿先、作成者、匿名フラグ、結果の公開設定、状態
- `options`: 選択肢 (表示順付き)
- `votes`: `(poll_id, voter_key)` を主キーとし、1 ユーザー 1 票を DB レベルで保証。匿名投票では `voter_key = HMAC(VOTER_HASH_SECRET, poll_id:user_id)`

## 既知の制約

- 投票が同時に集中した場合、Slack メッセージの更新順序が前後して一瞬古い集計が表示されることがあります (DB は正しく、次の投票で自動修復されます)。厳密に直列化したい場合は Durable Objects の導入を検討してください。
- 選択肢は択一のみ (複数選択は未対応)。
