// 日付ユーティリティ。「今日」の判定はJST、Workers AI無料枠の日次カウンタのみUTC(design.md §5.2)

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function jstTodayISO(now = new Date()): string {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

// 週次OCRカウンタの起点。月曜0:00 JST(design.md §4.1)
export function jstWeekStartISO(now = new Date()): string {
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  const dow = jst.getUTCDay(); // 0=日曜
  jst.setUTCDate(jst.getUTCDate() - ((dow + 6) % 7));
  return jst.toISOString().slice(0, 10);
}

export function utcTodayISO(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function addDaysISO(dateISO: string, days: number): string {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// 月末日を超える場合はその月の末日に丸める(例: 1/31 + 1ヶ月 = 2/28)
export function addMonthsISO(dateISO: string, months: number): string {
  const d = new Date(`${dateISO}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}

export function isValidDateISO(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// OCR結果の表記ゆれ(和暦・スラッシュ区切り等)を YYYY-MM-DD に正規化する。できなければ null
export function normalizeDate(input: unknown): string | null {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s || s.toLowerCase() === 'null') return null;

  s = s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/／/g, '/')
    .replace(/－/g, '-')
    .replace(/．/g, '.');

  const wareki = s.match(/(令和|平成|昭和)\s*(\d{1,2}|元)\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if (wareki) {
    const base = { 令和: 2018, 平成: 1988, 昭和: 1925 }[wareki[1] as '令和' | '平成' | '昭和'];
    const year = base + (wareki[2] === '元' ? 1 : parseInt(wareki[2], 10));
    return buildDateISO(year, parseInt(wareki[3], 10), parseInt(wareki[4], 10));
  }

  const jp = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if (jp) return buildDateISO(+jp[1], +jp[2], +jp[3]);

  const sep = s.match(/(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/);
  if (sep) return buildDateISO(+sep[1], +sep[2], +sep[3]);

  return null;
}

function buildDateISO(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isValidDateISO(iso) ? iso : null;
}

// 保証期間の表記ゆれ(「1年」「12ヶ月」等)を月数に正規化する。できなければ null
export function normalizeMonths(input: unknown): number | null {
  if (input == null) return null;
  if (typeof input === 'number' && Number.isFinite(input)) return clampMonths(Math.round(input));
  const s = String(input).trim();
  if (!s || s.toLowerCase() === 'null') return null;
  const years = s.match(/(\d+)\s*年/);
  const months = s.match(/(\d+)\s*(?:ヶ月|か月|カ月|ケ月|箇月|月)/);
  if (years || months) {
    return clampMonths((years ? +years[1] * 12 : 0) + (months ? +months[1] : 0));
  }
  const n = s.match(/\d+/);
  return n ? clampMonths(+n[0]) : null;
}

function clampMonths(n: number): number | null {
  return Number.isInteger(n) && n >= 1 && n <= 600 ? n : null;
}
