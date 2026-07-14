// 保証書レコードのCRUD・検索・エクスポート

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from './auth';
import { addDaysISO, addMonthsISO, isValidDateISO, jstTodayISO } from './dates';

export type Warranty = {
  id: string;
  product_name: string;
  purchase_date: string | null;
  warranty_months: number | null;
  warranty_end_date: string | null;
  note: string | null;
  source: string;
  created_at: string;
  updated_at: string;
};

const SOURCES = new Set(['ocr', 'manual', 'mixed']);

type ParsedInput = {
  product_name?: string;
  purchase_date?: string | null;
  warranty_months?: number | null;
  warranty_end_date?: string | null;
  note?: string | null;
  source?: string;
};

// 入力を検証して正規化する。partial=true(PATCH)では省略された項目を無視する
function parseInput(
  body: Record<string, unknown>,
  partial: boolean
): { ok: true; value: ParsedInput } | { ok: false; message: string } {
  const out: ParsedInput = {};

  if ('product_name' in body || !partial) {
    const name = typeof body.product_name === 'string' ? body.product_name.trim() : '';
    if (!name) return { ok: false, message: '製品名は必須です。' };
    if (name.length > 200) return { ok: false, message: '製品名は200文字以内で入力してください。' };
    out.product_name = name;
  }

  for (const key of ['purchase_date', 'warranty_end_date'] as const) {
    if (!(key in body)) continue;
    const v = body[key];
    if (v === null || v === '') {
      out[key] = null;
    } else if (isValidDateISO(v)) {
      out[key] = v;
    } else {
      return { ok: false, message: '日付は YYYY-MM-DD 形式で入力してください。' };
    }
  }

  if ('warranty_months' in body) {
    const v = body.warranty_months;
    if (v === null || v === '') {
      out.warranty_months = null;
    } else {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 600) {
        return { ok: false, message: '保証期間(月数)は1〜600の整数で入力してください。' };
      }
      out.warranty_months = n;
    }
  }

  if ('note' in body) {
    const v = body.note;
    if (v === null || v === '') {
      out.note = null;
    } else if (typeof v === 'string' && v.length <= 1000) {
      out.note = v;
    } else {
      return { ok: false, message: 'メモは1000文字以内で入力してください。' };
    }
  }

  if ('source' in body) {
    const v = body.source;
    if (typeof v === 'string' && SOURCES.has(v)) out.source = v;
  }

  return { ok: true, value: out };
}

export const warrantyRoutes = new Hono<AppEnv>();

warrantyRoutes.get('/', async (c) => {
  const user = c.get('user');
  const q = c.req.query('q')?.trim() ?? '';
  const filter = c.req.query('filter') ?? '';
  const today = jstTodayISO();

  let sql =
    `SELECT id, product_name, purchase_date, warranty_months, warranty_end_date, note, source, created_at, updated_at
       FROM warranties WHERE user_id = ?`;
  const binds: (string | number)[] = [user.id];

  if (q) {
    const escaped = q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    sql += ` AND product_name LIKE ? ESCAPE '\\'`;
    binds.push(`%${escaped}%`);
  }

  switch (filter) {
    case 'active':
      sql += ' AND warranty_end_date >= ?';
      binds.push(today);
      break;
    case 'this_year':
      sql += ' AND warranty_end_date >= ? AND warranty_end_date <= ?';
      binds.push(today, `${today.slice(0, 4)}-12-31`);
      break;
    case '30days':
      sql += ' AND warranty_end_date >= ? AND warranty_end_date <= ?';
      binds.push(today, addDaysISO(today, 30));
      break;
    case 'expired':
      sql += ' AND warranty_end_date < ?';
      binds.push(today);
      break;
  }

  // 期限が近い順。終了日未設定は末尾
  sql += ' ORDER BY warranty_end_date IS NULL, warranty_end_date ASC, created_at DESC';

  const { results } = await c.env.DB.prepare(sql).bind(...binds).all<Warranty>();
  return c.json({ warranties: results, today });
});

warrantyRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  const row = await c.env.DB.prepare(
    `SELECT id, product_name, purchase_date, warranty_months, warranty_end_date, note, source, created_at, updated_at
       FROM warranties WHERE id = ? AND user_id = ?`
  )
    .bind(c.req.param('id'), user.id)
    .first<Warranty>();
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json({ warranty: row });
});

warrantyRoutes.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: 'bad_request', message: 'リクエストが不正です。' }, 400);

  const parsed = parseInput(body, false);
  if (!parsed.ok) return c.json({ error: 'validation', message: parsed.message }, 400);
  const v = parsed.value;

  // 終了日の決定: 手動/OCR値 > 購入日+保証期間の自動計算 > 未設定(design.md §3.3)
  let endDate = v.warranty_end_date ?? null;
  if (!endDate && v.purchase_date && v.warranty_months) {
    endDate = addMonthsISO(v.purchase_date, v.warranty_months);
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO warranties (id, user_id, product_name, purchase_date, warranty_months, warranty_end_date, note, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      user.id,
      v.product_name ?? '',
      v.purchase_date ?? null,
      v.warranty_months ?? null,
      endDate,
      v.note ?? null,
      v.source ?? 'manual'
    )
    .run();

  const row = await c.env.DB.prepare('SELECT * FROM warranties WHERE id = ?').bind(id).first<Warranty>();
  return c.json({ warranty: row }, 201);
});

warrantyRoutes.patch('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: 'bad_request', message: 'リクエストが不正です。' }, 400);

  const existing = await c.env.DB.prepare('SELECT id FROM warranties WHERE id = ? AND user_id = ?')
    .bind(id, user.id)
    .first<{ id: string }>();
  if (!existing) return c.json({ error: 'not_found' }, 404);

  const parsed = parseInput(body, true);
  if (!parsed.ok) return c.json({ error: 'validation', message: parsed.message }, 400);
  const v = parsed.value;

  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  for (const [key, value] of Object.entries(v)) {
    sets.push(`${key} = ?`);
    binds.push(value as string | number | null);
  }
  if (sets.length === 0) return c.json({ error: 'validation', message: '更新項目がありません。' }, 400);

  sets.push(`updated_at = datetime('now')`);
  binds.push(id, user.id);
  await c.env.DB.prepare(`UPDATE warranties SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
    .bind(...binds)
    .run();

  const row = await c.env.DB.prepare('SELECT * FROM warranties WHERE id = ?').bind(id).first<Warranty>();
  return c.json({ warranty: row });
});

warrantyRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const result = await c.env.DB.prepare('DELETE FROM warranties WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), user.id)
    .run();
  if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

// ---- エクスポート ----

function csvEscape(value: string | number | null): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function handleExport(c: Context<AppEnv>): Promise<Response> {
  const user = c.get('user');
  const format = c.req.query('format') === 'csv' ? 'csv' : 'json';
  const { results } = await c.env.DB.prepare(
    `SELECT product_name, purchase_date, warranty_months, warranty_end_date, note, source, created_at, updated_at
       FROM warranties WHERE user_id = ?
      ORDER BY warranty_end_date IS NULL, warranty_end_date ASC, created_at DESC`
  )
    .bind(user.id)
    .all<Omit<Warranty, 'id'>>();

  if (format === 'json') {
    return new Response(JSON.stringify({ exported_at: new Date().toISOString(), warranties: results }, null, 2), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': 'attachment; filename="hoshosho_export.json"',
      },
    });
  }

  const header = ['product_name', 'purchase_date', 'warranty_months', 'warranty_end_date', 'note', 'source', 'created_at', 'updated_at'];
  const lines = [header.join(',')];
  for (const r of results) {
    lines.push(header.map((h) => csvEscape(r[h as keyof typeof r])).join(','));
  }
  // BOM付きUTF-8(Excelでの文字化け対策)
  return new Response('\uFEFF' + lines.join('\r\n') + '\r\n', {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="hoshosho_export.csv"',
    },
  });
}
