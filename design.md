# 保証書管理Webアプリ 仕様書

- 版数: v1.0(ドラフト)
- 作成日: 2026-07-14
- 対象: v1(初回リリース)

---

## 1. サービス概要

### 1.0 サービス名・ドメイン

| 項目       | 内容                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------ |
| サービス名 | hoshosho(ほしょしょ)                                                                             |
| URL        | `https://hoshosho.tsukuba.app`                                                                   |
| 名前の由来 | 「保証書」から。音の繰り返しによる親しみやすさと、ドメインだけでサービス内容が伝わる実直さを両立 |

表記ルール:

- 英字表記: `hoshosho`(小文字で統一。ロゴ・URL・技術文書)
- 日本語表記: 「ほしょしょ」(アプリ内UI・紹介文)
- PWAマニフェスト: `name` = 「ほしょしょ - 保証書管理」、`short_name` = 「ほしょしょ」

ドメイン運用:

- `tsukuba.app` のサブドメインとして運用し、DNS・TLS証明書はCloudflareで管理する
- `.app` TLDはHSTSプリロード対象のため**HTTPS必須**(Cloudflare Pages標準対応で問題なし)
- APIは同一オリジン(`hoshosho.tsukuba.app/api/*`)で提供し、CORS設定を不要にする
- Google OAuthのリダイレクトURI・Cookieのドメイン設定は `hoshosho.tsukuba.app` に限定する(親ドメイン `tsukuba.app` を指定しない)

### 1.1 目的

家電・製品の保証書をスマートフォンで撮影するだけで、製品名・購入日・保証期間を記録し、保証期限を一覧・検索できるWebアプリを提供する。

### 1.2 コンセプト

- 本サービスは「保証期限のデータベース」であり、画像アーカイブではない
- **保証書画像はサーバーに保存しない**(プライバシーリスクの構造的排除)
- 本サービスは保証書の代わりにはならない。**原本の保管を利用者に必ず促す**
- OCRは「入力フォームを自動で埋める補助機能」と位置づけ、全項目手動入力でも登録が完結する

### 1.3 対象環境

- スマートフォンのモバイルブラウザを主対象(PC対応は必須としない)
- PWA対応(ホーム画面追加、カメラ直起動)

---

## 2. システム構成

| 要素           | 技術                                                           | 備考                               |
| -------------- | -------------------------------------------------------------- | ---------------------------------- |
| フロントエンド | Cloudflare Pages(SPA + PWA)                                    | 画像リサイズはブラウザ内で実施     |
| API            | Cloudflare Workers                                             |                                    |
| データベース   | Cloudflare D1                                                  | 製品・保証データ、利用カウンタ     |
| OCR            | Cloudflare Workers AI `@cf/meta/llama-3.2-11b-vision-instruct` | サーバー側で推論。画像は保存しない |
| 認証           | Google OAuth(better-auth 等 + D1)                              | v1はGoogleのみ。Xログインはv2候補  |
| 画像ストレージ | **使用しない**(R2不使用)                                       |                                    |

### 2.1 画像の取り扱い(重要)

1. 画像はブラウザ内でリサイズ後、OCR APIへ送信する
2. WorkerはOCR推論にのみ使用し、**ディスク・R2・ログへ一切書き込まない**
3. OCR応答後、サーバー側の画像データは破棄される(リクエストスコープ外に保持しない)
4. クライアント側では確認・修正画面の間のみ一時保持(SPA state / IndexedDB)し、登録完了または破棄操作で削除する
5. Workerのログ・エラーダンプに画像データおよびOCR全文を出力しない

---

## 3. 機能仕様

### 3.1 認証

- Google アカウントによるログイン(OAuth 2.0 / OIDC)
- 保存する情報: Googleのsub(ユーザーID)、メールアドレス、表示名
- 未ログイン状態では登録・閲覧機能は使用不可
- Xログインは需要を見てv2で検討(API仕様変更リスクのためv1では見送り)

### 3.2 保証書の登録フロー

```
[撮影 / 画像選択]
   ↓ ブラウザ内で処理
[リサイズ・正規化]  長辺1,500px、JPEG品質0.8、EXIF除去、向き補正
   ↓
[プレビュー確認]    「文字が読めるか」をユーザーが目視確認(再撮影可)
   ↓
[OCR実行]          Workers AI(週次制限のチェック後)
   ↓
[確認・修正画面]    画像プレビューと抽出結果を並べて表示。全項目編集可
   ↓
[保存]             D1へ登録。画像はクライアント側でも破棄
   ↓
[完了画面]         注意喚起を表示(§3.6)
```

#### 画像入力

- `<input type="file" accept="image/*" capture="environment">` によりカメラ直起動と画像選択の両方に対応
- リサイズ: Canvas または browser-image-compression 等を使用
  - 長辺 1,500px(精度と実測結果により1,200〜2,000pxの範囲で調整)
  - `createImageBitmap(file, { imageOrientation: "from-image" })` でEXIF回転を補正
  - JPEGで再エンコード(EXIF/GPS情報は自動的に除去される)
  - HEIC等が読み込めない場合はエラーメッセージを表示し再選択を促す

#### OCR(情報抽出)

- モデル: `@cf/meta/llama-3.2-11b-vision-instruct`
- プロンプトで以下のJSONのみを出力するよう厳格に指定し、`max_tokens` は150程度に制限する

```json
{
  "product_name": "string | null",
  "purchase_date": "YYYY-MM-DD | null",
  "warranty_months": "number | null",
  "warranty_end_date": "YYYY-MM-DD | null"
}
```

- 和暦(令和◯年)・「2024/6/1」等の表記ゆれはプロンプトおよびサーバー側後処理で `YYYY-MM-DD` に正規化する
- 読み取れなかった項目は `null` とし、UI上は空欄+「読み取れませんでした」と表示する。**推測値を確定表示しない**
- OCR失敗(全項目null・API エラー・枠超過)時も、手動入力で登録を完結できる

### 3.3 データ項目と保証終了日の決定ロジック

| 項目           | 必須 | 入力元                                               |
| -------------- | ---- | ---------------------------------------------------- |
| 製品名         | ○    | OCR / 手動                                           |
| 購入日         | −    | OCR / 手動(保証書に記載がないことが多く、手動が既定) |
| 保証期間(月数) | −    | OCR / 手動                                           |
| 保証終了日     | ○    | 自動計算 / 手動上書き                                |
| メモ           | −    | 手動(任意。購入店等)                                 |

保証終了日の決定優先順位:

1. ユーザーが手動入力した終了日
2. OCRで終了日そのものが読み取れた場合はその値
3. `購入日 + 保証期間` による自動計算
4. いずれも無い場合は登録不可とせず、終了日未設定のまま保存可(検索対象外となる旨を表示)

### 3.4 一覧・検索

- 一覧: 保証終了日の昇順(期限が近い順)を既定とする
- 製品名によるキーワード検索(部分一致)
- 検索テンプレート(ワンタップ):
  - **保証期間内**: `warranty_end_date >= 今日`
  - **年内に期限切れ**: `今日 <= warranty_end_date <= 当年12月31日`
  - **30日以内に期限切れ**: `今日 <= warranty_end_date <= 今日+30日`
  - 期限切れ済み: `warranty_end_date < 今日`
- 日付判定は**JST基準**で統一する(§5.2)

### 3.5 編集・削除

- 登録済みレコードの全項目を編集可能
- レコード単位の削除
- アカウント削除: ユーザーに紐づく全レコードと認証情報をD1から完全削除する
- エクスポート: 全レコードをCSV / JSONでダウンロード可能

### 3.6 注意喚起(必須要件)

- 文言例: 「本アプリは保証書の代わりにはなりません。**保証書の原本は必ず保管してください。**」
- 表示箇所:
  - **登録完了画面に毎回表示**(初回のみのモーダルにはしない)
  - 画像アップロード画面にも常設表示
  - 「画像はサーバーに保存されません」の明示もあわせて行う
- 利用規約に「本アプリの記録は保証を証明するものではない」旨を明記する

---

## 4. 利用制限・コスト設計

### 4.1 OCR利用制限

- **1ユーザーあたり 週10回**(OCR実行回数。登録件数ではない)
- D1のカウンタで管理し、週の起点は月曜0:00 JSTとする
- 上限到達時: OCRボタンを無効化し「今週の読み取り回数を使い切りました。手動入力は引き続き利用できます」と表示

### 4.2 全体ガード

- Workers AIの無料枠は**アカウント全体で1日10,000ニューロン(0:00 UTCリセット)**
- 1スキャンの想定消費: 約15〜20ニューロン(長辺1,500px・出力150トークン制限時)
- D1に日次のスキャン総数を記録し、閾値(例: 400回/日)到達で全ユーザーのOCRを一時停止し「本日は混み合っています」と表示
- 収容目安: 週10回制限で約250〜300ユーザーまで無料枠内(利用が分散する前提)
- 超過時の判断: Workers Paid($5/月、超過 $0.011/1,000ニューロン ≒ 1スキャン約0.04円)へ移行すれば数百ユーザー規模でも月数百円程度

### 4.3 レート制限

- Worker側でユーザー/IP単位の一般的なレート制限を実施(連打・スクリプト対策)
- Cloudflare Rate Limiting(WAFルールまたはWorkersバインディング)を利用

---

## 5. データ設計

### 5.1 D1スキーマ(案)

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,          -- 内部ID
  google_sub    TEXT UNIQUE NOT NULL,
  email         TEXT NOT NULL,
  display_name  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE warranties (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_name       TEXT NOT NULL,
  purchase_date      TEXT,                 -- YYYY-MM-DD、null可
  warranty_months    INTEGER,              -- null可
  warranty_end_date  TEXT,                 -- YYYY-MM-DD、null可(検索の主キー)
  note               TEXT,
  source             TEXT NOT NULL DEFAULT 'manual',  -- 'ocr' | 'manual' | 'mixed'
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_warranties_user_end
  ON warranties(user_id, warranty_end_date);
CREATE INDEX idx_warranties_user_name
  ON warranties(user_id, product_name);

CREATE TABLE ocr_usage (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start  TEXT NOT NULL,               -- 週の起点(YYYY-MM-DD、月曜JST)
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, week_start)
);

CREATE TABLE daily_ocr_total (
  date   TEXT PRIMARY KEY,                 -- YYYY-MM-DD(UTC、無料枠リセットに合わせる)
  count  INTEGER NOT NULL DEFAULT 0
);
```

- 全クエリで `WHERE user_id = ?` を徹底する(マルチテナント分離)
- OCR成否のフラグ(`source`)のみ記録し、画像・OCR全文は記録しない

### 5.2 タイムゾーン方針

- D1 / Workers はUTCで動作するため、**「今日」の判定はJSTで行う**と全体で統一する
- 期限検索・週次カウンタの起点はJST、Workers AI無料枠の日次カウンタのみUTC(リセット仕様に合わせる)

---

## 6. API設計(概要)

| メソッド | パス                | 内容                                                                            |
| -------- | ------------------- | ------------------------------------------------------------------------------- |
| POST     | /api/ocr            | 画像を受け取りOCR実行。結果JSONを返す(画像は非保存)。週次・日次制限チェック込み |
| GET      | /api/warranties     | 一覧・検索(`q`, `filter=active\|this_year\|30days\|expired`)                    |
| POST     | /api/warranties     | 登録                                                                            |
| PATCH    | /api/warranties/:id | 編集                                                                            |
| DELETE   | /api/warranties/:id | 削除                                                                            |
| GET      | /api/export         | CSV / JSONエクスポート                                                          |
| DELETE   | /api/account        | アカウントと全データの削除                                                      |

- 全エンドポイントは認証必須。セッションはCookie(HttpOnly, Secure, SameSite=Lax)

---

## 7. 非機能要件

- **プライバシー**: 画像非保存、EXIF除去、ログへの個人情報出力禁止。プライバシーポリシーにWorkers AIへの画像送信と非保存方針、Cloudflareのデータ取り扱いへの準拠を明記
- **セキュリティ**: OAuthのstate/PKCE、CSRF対策、ユーザーデータの水平アクセス制御
- **可用性**: OCR停止時(枠超過等)も手動入力で全機能が成立すること
- **性能**: アップロード画像はリサイズ後300KB程度を目安。OCR応答は数秒〜十数秒を許容し、ローディング表示を行う

---

## 8. 画面一覧

1. ログイン画面(Googleログインボタン、サービス説明、注意喚起)
2. ホーム / 一覧画面(検索ボックス、テンプレートフィルタのチップ、期限順リスト、期限切れ間近の強調表示)
3. 登録画面(カメラ/画像選択 → プレビュー → OCR → 確認・修正フォーム)
4. 詳細・編集画面
5. 設定画面(エクスポート、アカウント削除、利用規約・プライバシーポリシー)

---

## 9. v1スコープ外(将来候補)

| 機能                     | 備考                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| 期限切れ事前通知(メール) | Workers Cronトリガーで毎日抽出→送信。`warranty_end_date` のインデックスとメールアドレス保存は本仕様で準備済み |
| Xログイン                | API仕様の安定性を見て判断                                                                                     |
| 画像の保存・閲覧(R2)     | 要望が強ければ追加。非保存→保存の順なら移行が容易                                                             |
| レシート対応             | v1は保証書のみ                                                                                                |
| 家族共有                 | マルチユーザー共有は複雑化するためv1では見送り                                                                |

---

## 10. 未決事項

- [ ] リサイズパラメータの実測チューニング(長辺px・JPEG品質と読み取り精度のバランス)
- [ ] OCRプロンプトの日本語保証書での精度検証(和暦、販売店印、手書き日付)
- [x] サービス名・ドメイン → `hoshosho.tsukuba.app` に決定(§1.0)
- [ ] 利用規約・プライバシーポリシーの文面
