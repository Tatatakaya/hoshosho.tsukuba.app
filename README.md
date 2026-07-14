# hoshosho.tsukuba.app

ほしょしょ - 保証書管理Webアプリ。保証書をスマホで撮影するだけで、製品名・購入日・保証期限を記録・検索できる。**画像はサーバーに保存しない**(仕様は [design.md](design.md) を参照)。

## 構成

| 要素 | 技術 |
| --- | --- |
| フロントエンド | SPA + PWA(ビルド不要のvanilla JS。`public/` を Workers Assets で配信) |
| API | Cloudflare Workers + Hono(`src/`) |
| データベース | Cloudflare D1(`migrations/`) |
| OCR | Workers AI `@cf/meta/llama-3.2-11b-vision-instruct` |
| 認証 | Google OAuth 2.0(認可コード + PKCE、自前実装。セッションはD1 + HttpOnly Cookie) |

## セットアップ

### 1. 依存インストール

```sh
npm install
```

### 2. D1データベース作成

```sh
npx wrangler d1 create hoshosho-db
```

出力された `database_id` を `wrangler.jsonc` の `d1_databases[0].database_id` に設定する。

### 3. Google OAuth クライアント

[Google Cloud Console](https://console.cloud.google.com/apis/credentials) で OAuth 2.0 クライアントID(Webアプリケーション)を作成する。

- 承認済みリダイレクトURI:
  - `https://hoshosho.tsukuba.app/api/auth/callback`(本番)
  - `http://localhost:8787/api/auth/callback`(ローカル開発)
- クライアントIDを `wrangler.jsonc` の `vars.GOOGLE_CLIENT_ID` に設定
- クライアントシークレット:
  - ローカル: `.dev.vars.example` をコピーして `.dev.vars` に記入
  - 本番: `npx wrangler secret put GOOGLE_CLIENT_SECRET`

### 4. マイグレーション

```sh
npm run db:migrate:local    # ローカル
npm run db:migrate:remote   # 本番(デプロイ前に一度)
```

### 5. 起動 / デプロイ

```sh
npm run dev      # http://localhost:8787
npm run deploy   # 手動デプロイ
```

#### GitHub Actions による自動デプロイ

`main` へのプッシュで [.github/workflows/deploy.yml](.github/workflows/deploy.yml) が実行され、型チェック → D1マイグレーション → `wrangler deploy` が走る(手動実行も可: Actions → Deploy → Run workflow)。

必要なリポジトリシークレット:

| シークレット | 内容 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Workers・D1 の編集権限を持つAPIトークン |

アカウントIDは機密情報ではないため `wrangler.jsonc` の `account_id` に記載している。

本番ドメイン `hoshosho.tsukuba.app` に紐付ける場合は `wrangler.jsonc` 末尾の `routes` のコメントを外す(Cloudflareに `tsukuba.app` ゾーンがある前提)。

## 利用制限まわり(design.md §4)

`wrangler.jsonc` の `vars` で調整する。

| 変数 | 既定値 | 意味 |
| --- | --- | --- |
| `OCR_WEEKLY_LIMIT` | `10` | 1ユーザーあたりの週次OCR回数(月曜0:00 JST起点) |
| `OCR_DAILY_GLOBAL_LIMIT` | `400` | 全ユーザー合計の日次OCR回数(0:00 UTC起点、無料枠ガード) |
| `OCR_UNLIMITED_EMAILS` | `takaya10o01@gmail.com` | **利用制限を適用しないテストアカウント**(カンマ区切りで複数可) |

制限対象外アカウントもOCR実行は日次カウンタに加算される(実際にニューロンを消費するため)が、ブロックはされない。

Worker内の簡易レート制限(60req/分/IP)はアイソレート単位のベストエフォート。本番ではCloudflare WAFのレートリミットルール併用を推奨。

## 開発メモ

- 型生成: `npm run types`(`wrangler.jsonc` 変更後に実行。`worker-configuration.d.ts` は生成物のためgitignore済み)
- 型チェック: `npm run typecheck`
- `compatibility_date` はローカルの workerd が対応する日付まで(現状 2026-05-03 が上限)。wrangler更新時に合わせて上げる
- 画像・OCR結果全文はログに出力しない(design.md §2.1)。エラーログは構造化JSONでメッセージのみ

## APIエンドポイント

すべて認証必須(セッションCookie)。詳細は [design.md §6](design.md)。

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/api/me` | ユーザー情報 + OCR利用状況 |
| POST | `/api/ocr` | 画像(base64)を読み取り、抽出JSONを返す |
| GET | `/api/warranties` | 一覧・検索(`q`, `filter=active\|this_year\|30days\|expired`) |
| POST | `/api/warranties` | 登録 |
| GET/PATCH/DELETE | `/api/warranties/:id` | 取得・編集・削除 |
| GET | `/api/export?format=csv\|json` | エクスポート |
| DELETE | `/api/account` | アカウントと全データの削除 |
| GET | `/api/auth/login` → `/api/auth/callback` | Google OAuth |
| POST | `/api/auth/logout` | ログアウト |
