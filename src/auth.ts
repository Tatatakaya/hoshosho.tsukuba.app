// Google OAuth 2.0 (認可コード + PKCE + state) とセッション管理

import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

export type SessionUser = { id: string; email: string; display_name: string | null };
export type AppEnv = { Bindings: Env; Variables: { user: SessionUser } };

const SESSION_COOKIE = 'hoshosho_session';
const SESSION_DAYS = 30;
const OAUTH_COOKIE = 'hoshosho_oauth';

function isSecure(c: Context<AppEnv>): boolean {
  return new URL(c.req.url).protocol === 'https:';
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// 認証必須エンドポイント用ミドルウェア
export async function requireAuth(c: Context<AppEnv>, next: Next): Promise<Response | void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return c.json({ error: 'unauthorized' }, 401);
  const tokenHash = await sha256Hex(token);
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.display_name
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ?`
  )
    .bind(tokenHash, new Date().toISOString())
    .first<SessionUser>();
  if (!row) return c.json({ error: 'unauthorized' }, 401);
  c.set('user', row);
  await next();
}

export const authRoutes = new Hono<AppEnv>();

authRoutes.get('/login', async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID) {
    return c.text('GOOGLE_CLIENT_ID が未設定です。wrangler.jsonc を確認してください。', 500);
  }
  const origin = new URL(c.req.url).origin;
  const state = randomHex(16);
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challengeDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64url(new Uint8Array(challengeDigest));

  setCookie(c, OAUTH_COOKIE, `${state}.${verifier}`, {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: 'Lax',
    path: '/api/auth',
    maxAge: 600,
  });

  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin}/api/auth/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

authRoutes.get('/callback', async (c) => {
  const origin = new URL(c.req.url).origin;
  const code = c.req.query('code');
  const state = c.req.query('state');
  const stored = getCookie(c, OAUTH_COOKIE);
  deleteCookie(c, OAUTH_COOKIE, { path: '/api/auth' });

  if (!code || !state || !stored) {
    return c.text('ログインに失敗しました。もう一度お試しください。', 400);
  }
  const dot = stored.indexOf('.');
  const storedState = stored.slice(0, dot);
  const verifier = stored.slice(dot + 1);
  if (dot < 0 || state !== storedState) {
    return c.text('ログインに失敗しました(不正なリクエスト)。', 400);
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: `${origin}/api/auth/callback`,
    }),
  });
  if (!tokenRes.ok) {
    console.log(JSON.stringify({ event: 'oauth_token_error', status: tokenRes.status }));
    return c.text('Googleとの通信に失敗しました。時間をおいてお試しください。', 502);
  }
  const tokens = await tokenRes.json<{ id_token?: string }>();
  // IDトークンはGoogleのトークンエンドポイントからTLS経由で直接受領するため署名検証は不要
  const claims = tokens.id_token ? decodeJwtPayload(tokens.id_token) : null;
  const sub = typeof claims?.sub === 'string' ? claims.sub : null;
  const email = typeof claims?.email === 'string' ? claims.email : null;
  const name = typeof claims?.name === 'string' ? claims.name : null;
  if (!sub || !email) {
    return c.text('Googleアカウント情報を取得できませんでした。', 502);
  }

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE google_sub = ?')
    .bind(sub)
    .first<{ id: string }>();
  let userId: string;
  if (existing) {
    userId = existing.id;
    await c.env.DB.prepare('UPDATE users SET email = ?, display_name = ? WHERE id = ?')
      .bind(email, name, userId)
      .run();
  } else {
    userId = crypto.randomUUID();
    await c.env.DB.prepare(
      'INSERT INTO users (id, google_sub, email, display_name) VALUES (?, ?, ?, ?)'
    )
      .bind(userId, sub, email, name)
      .run();
  }

  const sessionToken = randomHex(32);
  const sessionHash = await sha256Hex(sessionToken);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400 * 1000).toISOString();
  await c.env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(sessionHash, userId, expiresAt)
    .run();
  // 期限切れセッションの掃除はレスポンス返却後に行う
  c.executionCtx.waitUntil(
    c.env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?')
      .bind(new Date().toISOString())
      .run()
      .then(() => undefined)
  );

  setCookie(c, SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DAYS * 86400,
  });
  return c.redirect('/');
});

authRoutes.post('/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const tokenHash = await sha256Hex(token);
    await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(tokenHash).run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

export async function deleteSessionCookie(c: Context<AppEnv>): Promise<void> {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}
