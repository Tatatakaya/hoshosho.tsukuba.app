// hoshosho API Worker。静的アセット(SPA/PWA)は wrangler.jsonc の assets 設定で配信し、
// /api/* のみここで処理する(run_worker_first)

import { Hono } from 'hono';
import { authRoutes, deleteSessionCookie, requireAuth, type AppEnv } from './auth';
import { getOcrStatus, ocrRoutes } from './ocr';
import { handleExport, warrantyRoutes } from './warranties';

const app = new Hono<AppEnv>();

// ---- 簡易レート制限(アイソレート単位のベストエフォート。恒久対策はWAFレートルールを併用) ----
// リクエスト固有の状態ではなく集計カウンタのため、モジュールスコープで保持してよい
const rateBuckets = new Map<string, number[]>();
const RATE_LIMIT = 60; // 60リクエスト/分
const RATE_WINDOW_MS = 60_000;

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const hits = (rateBuckets.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  rateBuckets.set(key, hits);
  if (rateBuckets.size > 10_000) rateBuckets.clear(); // メモリ肥大の安全弁
  return hits.length > RATE_LIMIT;
}

app.use('/api/*', async (c, next) => {
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  if (isRateLimited(ip)) {
    return c.json({ error: 'rate_limited', message: 'アクセスが集中しています。しばらくお待ちください。' }, 429);
  }
  await next();
});

// ---- CSRF対策: クロスオリジンからの状態変更リクエストを拒否(Cookie は SameSite=Lax と併用) ----
app.use('/api/*', async (c, next) => {
  const method = c.req.method;
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const origin = c.req.header('origin');
    if (origin && origin !== new URL(c.req.url).origin) {
      return c.json({ error: 'forbidden' }, 403);
    }
  }
  await next();
});

// ---- ルーティング ----
app.route('/api/auth', authRoutes);

app.get('/api/me', requireAuth, async (c) => {
  const user = c.get('user');
  return c.json({
    user: { email: user.email, display_name: user.display_name },
    ocr: await getOcrStatus(c.env, user.id, user.email),
  });
});

app.use('/api/ocr', requireAuth);
app.route('/api/ocr', ocrRoutes);

app.use('/api/warranties', requireAuth);
app.use('/api/warranties/*', requireAuth);
app.route('/api/warranties', warrantyRoutes);

app.get('/api/export', requireAuth, (c) => handleExport(c));

// アカウントと全データの削除(design.md §3.5)
app.delete('/api/account', requireAuth, async (c) => {
  const user = c.get('user');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    c.env.DB.prepare('DELETE FROM ocr_usage WHERE user_id = ?').bind(user.id),
    c.env.DB.prepare('DELETE FROM warranties WHERE user_id = ?').bind(user.id),
    c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
  ]);
  await deleteSessionCookie(c);
  return c.json({ ok: true });
});

app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'not_found' }, 404);
  // run_worker_first の対象外だが、念のため静的アセットへフォールバック
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((err, c) => {
  // 画像データ・OCR結果・個人情報はログに出力しない(design.md §2.1, §7)
  console.log(
    JSON.stringify({
      event: 'unhandled_error',
      path: c.req.path,
      method: c.req.method,
      message: err instanceof Error ? err.message : 'unknown',
    })
  );
  return c.json({ error: 'internal', message: 'サーバーエラーが発生しました。' }, 500);
});

export default app;
