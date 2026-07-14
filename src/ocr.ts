// OCR(情報抽出)。画像はリクエストスコープ内でのみ扱い、保存・ログ出力しない(design.md §2.1)

import { Hono } from 'hono';
import type { AppEnv } from './auth';
import { jstWeekStartISO, normalizeDate, normalizeMonths, utcTodayISO } from './dates';

// base64で約1.2MB(リサイズ後300KB目安に対して十分な余裕)
const MAX_IMAGE_BASE64_CHARS = 1_600_000;

const OCR_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

const OCR_PROMPT = `この画像は日本の製品保証書です。以下の4項目を読み取り、JSONオブジェクトのみを出力してください。説明文・前置き・コードブロックは一切不要です。

{"product_name": string | null, "purchase_date": "YYYY-MM-DD" | null, "warranty_months": number | null, "warranty_end_date": "YYYY-MM-DD" | null}

ルール:
- product_name: 製品名・品名・型番。読み取れなければ null
- purchase_date: 購入日・お買い上げ日。和暦(令和6年→2024年)や「2024/6/1」表記は "YYYY-MM-DD" に変換する
- warranty_months: 保証期間を月数で。「1年」なら 12
- warranty_end_date: 保証終了日・保証期限が明記されている場合のみ
- 画像から読み取れない項目は必ず null にする。推測で値を埋めない`;

export type OcrStatus = {
  unlimited: boolean;
  weekly_limit: number;
  weekly_used: number;
  weekly_remaining: number | null; // 無制限アカウントは null
  daily_paused: boolean;
};

export function isUnlimitedEmail(env: Env, email: string): boolean {
  return env.OCR_UNLIMITED_EMAILS.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
}

export async function getOcrStatus(env: Env, userId: string, email: string): Promise<OcrStatus> {
  const weeklyLimit = parseInt(env.OCR_WEEKLY_LIMIT, 10) || 10;
  const dailyLimit = parseInt(env.OCR_DAILY_GLOBAL_LIMIT, 10) || 400;
  const unlimited = isUnlimitedEmail(env, email);

  const weekRow = await env.DB.prepare(
    'SELECT count FROM ocr_usage WHERE user_id = ? AND week_start = ?'
  )
    .bind(userId, jstWeekStartISO())
    .first<{ count: number }>();
  const dayRow = await env.DB.prepare('SELECT count FROM daily_ocr_total WHERE date = ?')
    .bind(utcTodayISO())
    .first<{ count: number }>();

  const weeklyUsed = weekRow?.count ?? 0;
  return {
    unlimited,
    weekly_limit: weeklyLimit,
    weekly_used: weeklyUsed,
    weekly_remaining: unlimited ? null : Math.max(0, weeklyLimit - weeklyUsed),
    daily_paused: !unlimited && (dayRow?.count ?? 0) >= dailyLimit,
  };
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  for (const pattern of [/\{[\s\S]*?\}/, /\{[\s\S]*\}/]) {
    const m = text.match(pattern);
    if (!m) continue;
    try {
      const parsed: unknown = JSON.parse(m[0]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 次のパターンを試す
    }
  }
  return null;
}

export const ocrRoutes = new Hono<AppEnv>();

ocrRoutes.post('/', async (c) => {
  const user = c.get('user');
  const status = await getOcrStatus(c.env, user.id, user.email);

  if (!status.unlimited) {
    if (status.daily_paused) {
      return c.json(
        { error: 'daily_limit', message: '本日は混み合っています。時間をおいてお試しください。手動入力は引き続き利用できます。' },
        429
      );
    }
    if (status.weekly_remaining !== null && status.weekly_remaining <= 0) {
      return c.json(
        { error: 'weekly_limit', message: '今週の読み取り回数を使い切りました。手動入力は引き続き利用できます。' },
        429
      );
    }
  }

  const body = await c.req.json<{ image?: unknown }>().catch(() => null);
  let image = typeof body?.image === 'string' ? body.image : '';
  // data URL形式で送られてきた場合はbase64部分のみ取り出す
  const comma = image.indexOf(',');
  if (image.startsWith('data:') && comma > 0) image = image.slice(comma + 1);
  if (!image || image.length > MAX_IMAGE_BASE64_CHARS || !/^[A-Za-z0-9+/=]+$/.test(image)) {
    return c.json({ error: 'bad_image', message: '画像データが不正です。撮り直してお試しください。' }, 400);
  }

  let responseText: string;
  try {
    const aiResult = await c.env.AI.run(OCR_MODEL, {
      prompt: OCR_PROMPT,
      image,
      max_tokens: 200,
      temperature: 0.1,
    });
    responseText = typeof aiResult === 'object' && aiResult !== null && 'response' in aiResult
      ? String((aiResult as { response?: unknown }).response ?? '')
      : '';
  } catch (err) {
    // 画像・OCR全文はログに出さない(design.md §2.1)
    console.log(JSON.stringify({ event: 'ocr_ai_error', message: err instanceof Error ? err.message : 'unknown' }));
    return c.json(
      { error: 'ocr_failed', message: '読み取りに失敗しました。手動入力で登録できます。' },
      502
    );
  }

  // 推論が実行されたので、成否に関わらずカウントする
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO ocr_usage (user_id, week_start, count) VALUES (?, ?, 1)
       ON CONFLICT(user_id, week_start) DO UPDATE SET count = count + 1`
    ).bind(user.id, jstWeekStartISO()),
    c.env.DB.prepare(
      `INSERT INTO daily_ocr_total (date, count) VALUES (?, 1)
       ON CONFLICT(date) DO UPDATE SET count = count + 1`
    ).bind(utcTodayISO()),
  ]);

  const raw = extractJsonObject(responseText) ?? {};
  const productName =
    typeof raw.product_name === 'string' && raw.product_name.trim() && raw.product_name.trim().toLowerCase() !== 'null'
      ? raw.product_name.trim().slice(0, 200)
      : null;
  const result = {
    product_name: productName,
    purchase_date: normalizeDate(raw.purchase_date),
    warranty_months: normalizeMonths(raw.warranty_months),
    warranty_end_date: normalizeDate(raw.warranty_end_date),
  };

  return c.json({
    result,
    usage: await getOcrStatus(c.env, user.id, user.email),
  });
});
