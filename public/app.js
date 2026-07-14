/* ほしょしょ SPA(ハッシュルーティング) */
(() => {
  'use strict';

  const $app = document.getElementById('app');
  const $toast = document.getElementById('toast');

  /** ログイン中ユーザー情報 { user, ocr }。未ログインなら null */
  let me = null;
  /** 一覧の表示条件(戻ってきたとき維持する) */
  const listState = { q: '', filter: '' };
  /** 登録フローの一時状態。登録完了または破棄で必ずクリアする(画像は端末内のみ) */
  let draft = null;

  const NOTICE_ORIGINAL =
    '本アプリは保証書の代わりにはなりません。<strong>保証書の原本は必ず保管してください。</strong>';
  const NOTICE_PRIVACY =
    '📷 画像はサーバーに保存されません。読み取り処理後すぐに破棄されます。';

  // ---------- ユーティリティ ----------

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  function toast(msg, ms = 3200) {
    $toast.textContent = msg;
    $toast.hidden = false;
    clearTimeout($toast._t);
    $toast._t = setTimeout(() => { $toast.hidden = true; }, ms);
  }

  async function api(path, options = {}) {
    const opts = { headers: {}, ...options };
    if (opts.body && typeof opts.body !== 'string') {
      opts.body = JSON.stringify(opts.body);
      opts.headers['content-type'] = 'application/json';
    }
    const res = await fetch(path, opts);
    let data = null;
    try { data = await res.json(); } catch { /* 空レスポンス */ }
    if (res.status === 401) {
      me = null;
      render();
      throw Object.assign(new Error('unauthorized'), { handled: true });
    }
    if (!res.ok) {
      const err = new Error((data && data.message) || '通信に失敗しました。');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${y}年${+m}月${+d}日`;
  }

  function daysUntil(iso, todayIso) {
    const target = new Date(`${iso}T00:00:00Z`).getTime();
    const today = new Date(`${todayIso}T00:00:00Z`).getTime();
    return Math.round((target - today) / 86400000);
  }

  function addMonthsIso(dateIso, months) {
    const d = new Date(`${dateIso}T00:00:00Z`);
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + months);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return d.toISOString().slice(0, 10);
  }

  // ---------- 画像処理(端末内で完結) ----------

  const LONG_EDGE = 1500;
  const JPEG_QUALITY = 0.8;

  async function loadBitmap(file) {
    try {
      // EXIFの向きを反映してデコード(JPEG再エンコードでEXIF/GPSは除去される)
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      try {
        return await createImageBitmap(file);
      } catch {
        return null; // HEIC等が読めない環境
      }
    }
  }

  async function resizeImage(file) {
    const bitmap = await loadBitmap(file);
    if (!bitmap) return null;
    const scale = Math.min(1, LONG_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    return dataUrl;
  }

  // ---------- ルーティング ----------

  function nav(hash) { location.hash = hash; }

  window.addEventListener('hashchange', () => { render(); });

  async function render() {
    if (me === null) {
      renderLogin();
      return;
    }
    const hash = location.hash || '#/';
    if (hash === '#/' || hash === '') {
      await renderHome();
    } else if (hash === '#/add') {
      renderAdd();
    } else if (hash.startsWith('#/edit/')) {
      await renderEdit(hash.slice('#/edit/'.length));
    } else if (hash === '#/done') {
      renderDone();
    } else if (hash === '#/settings') {
      renderSettings();
    } else {
      nav('#/');
    }
  }

  function header() {
    return `
      <header class="header">
        <a class="brand" href="#/">
          <img src="/icons/icon-192.png" alt="">
          <span><span class="name">ほしょしょ</span><span class="sub">保証書管理</span></span>
        </a>
        <a class="icon-btn" href="#/settings" aria-label="設定">⚙️</a>
      </header>`;
  }

  // ---------- ログイン ----------

  function renderLogin() {
    $app.innerHTML = `
      <div class="login-hero">
        <img src="/icons/icon-192.png" alt="ほしょしょ">
        <h1>ほしょしょ</h1>
        <p>保証書、撮って安心。</p>
      </div>
      <div class="card">
        <ul class="feature-list">
          <li>📷 保証書を撮影するだけで期限を記録</li>
          <li>🔎 「30日以内に期限切れ」などで一発検索</li>
          <li>🔒 画像はサーバーに保存されません</li>
        </ul>
      </div>
      <button class="btn btn-google" id="login-btn">
        <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
        Googleでログイン
      </button>
      <div class="notice" style="margin-top:16px">${NOTICE_ORIGINAL}</div>
      <p style="font-size:12px;color:var(--ink-3)">ログインすると<a href="#" id="login-legal">利用規約・プライバシーポリシー</a>に同意したものとみなされます。</p>
      ${legalSections()}
    `;
    document.getElementById('login-btn').addEventListener('click', () => {
      location.href = '/api/auth/login';
    });
    document.getElementById('login-legal').addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelectorAll('details.legal').forEach((d) => { d.open = true; });
      document.querySelector('details.legal').scrollIntoView({ behavior: 'smooth' });
    });
  }

  function legalSections() {
    return `
      <details class="legal">
        <summary>利用規約</summary>
        <div class="body">
          <p>本アプリ「ほしょしょ」は、保証書の内容(製品名・購入日・保証期間・保証終了日)を記録・管理するためのサービスです。</p>
          <p><strong>本アプリの記録は保証を証明するものではありません。</strong>保証を受ける際は保証書の原本が必要です。原本は必ず保管してください。</p>
          <p>記録内容の正確性はユーザー自身でご確認ください。本アプリの利用により生じた損害について、運営者は責任を負いません。</p>
          <p>OCR(自動読み取り)には利用回数の制限があります。制限に達した場合も手動入力は利用できます。</p>
        </div>
      </details>
      <details class="legal">
        <summary>プライバシーポリシー</summary>
        <div class="body">
          <p><strong>保証書の画像はサーバーに保存しません。</strong>撮影した画像は読み取り処理(Cloudflare Workers AI)のためにのみ送信され、処理後すぐに破棄されます。画像はCloudflareのデータ取り扱い方針に準拠して処理されます。</p>
          <p>保存する情報は、Googleアカウントの識別子・メールアドレス・表示名と、入力された保証書の記録(テキスト)のみです。</p>
          <p>画像のEXIF情報(位置情報等)は送信前に端末内で除去されます。</p>
          <p>設定画面からアカウントと全データをいつでも完全に削除できます。</p>
        </div>
      </details>`;
  }

  // ---------- ホーム(一覧・検索) ----------

  const FILTERS = [
    { key: '', label: 'すべて' },
    { key: 'active', label: '保証期間内' },
    { key: 'this_year', label: '年内に期限切れ' },
    { key: '30days', label: '30日以内' },
    { key: 'expired', label: '期限切れ済み' },
  ];

  async function renderHome() {
    $app.innerHTML = `
      ${header()}
      <input type="search" class="search-box" id="search" placeholder="製品名で検索" value="${esc(listState.q)}" enterkeyhint="search">
      <div class="chips" id="chips">
        ${FILTERS.map((f) => `<button class="chip${listState.filter === f.key ? ' active' : ''}" data-filter="${f.key}">${f.label}</button>`).join('')}
      </div>
      <div id="list"><div class="loading"><span class="spinner"></span></div></div>
      <a class="fab" href="#/add" aria-label="保証書を登録">＋</a>
    `;

    const $search = document.getElementById('search');
    let searchTimer;
    $search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        listState.q = $search.value.trim();
        loadList();
      }, 300);
    });
    document.getElementById('chips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      listState.filter = chip.dataset.filter;
      document.querySelectorAll('.chip').forEach((el) => el.classList.toggle('active', el === chip));
      loadList();
    });

    await loadList();
  }

  async function loadList() {
    const $list = document.getElementById('list');
    if (!$list) return;
    try {
      const params = new URLSearchParams();
      if (listState.q) params.set('q', listState.q);
      if (listState.filter) params.set('filter', listState.filter);
      const data = await api(`/api/warranties?${params.toString()}`);
      renderList(data.warranties, data.today);
    } catch (err) {
      if (!err.handled) $list.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
  }

  function badgeFor(w, today) {
    if (!w.warranty_end_date) return '<span class="badge badge-none">期限未設定</span>';
    const days = daysUntil(w.warranty_end_date, today);
    if (days < 0) return '<span class="badge badge-expired">期限切れ</span>';
    if (days <= 30) return `<span class="badge badge-soon">あと${days}日</span>`;
    return '<span class="badge badge-ok">保証中</span>';
  }

  function renderList(warranties, today) {
    const $list = document.getElementById('list');
    if (!$list) return;
    if (warranties.length === 0) {
      $list.innerHTML = `<div class="empty">${listState.q || listState.filter
        ? '該当する保証書がありません。'
        : 'まだ登録がありません。<br>右下の「＋」から保証書を登録しましょう。'}</div>`;
      return;
    }
    $list.innerHTML = warranties.map((w) => `
      <a class="w-item" href="#/edit/${esc(w.id)}">
        <div>
          <div class="p-name">${esc(w.product_name)}</div>
          <div class="p-date">${w.warranty_end_date
            ? `保証期限: ${fmtDate(w.warranty_end_date)}`
            : '保証終了日が未設定です(検索対象外)'}</div>
        </div>
        ${badgeFor(w, today)}
      </a>`).join('');
  }

  // ---------- 登録(撮影 → OCR → フォーム) ----------

  function renderAdd() {
    draft = { imageDataUrl: null, ocrResult: null, ocrUsed: false, endEdited: false };
    $app.innerHTML = `
      ${header()}
      <h2 class="page-title">保証書を登録</h2>
      <div class="notice-privacy">${NOTICE_PRIVACY}</div>
      <div class="notice">${NOTICE_ORIGINAL}</div>

      <input type="file" accept="image/*" capture="environment" id="file-input" hidden>
      <div id="capture-zone">
        <div class="capture-area" id="capture-area">
          <div class="cam">📷</div>
          <p>タップして保証書を撮影<br>(または画像を選択)</p>
        </div>
      </div>
      <div id="ocr-zone"></div>

      <form id="w-form" autocomplete="off">
        ${formFields({})}
        <button type="submit" class="btn btn-primary">保存する</button>
        <a class="back-link" href="#/">← 一覧に戻る</a>
      </form>
    `;
    bindCapture();
    bindForm(null);
  }

  function formFields(w) {
    return `
      <div class="field">
        <label for="f-name">製品名<span class="req">*</span></label>
        <input id="f-name" type="text" maxlength="200" required value="${esc(w.product_name ?? '')}" placeholder="例: 冷蔵庫 MR-XX50J">
        <div class="hint" id="h-name"></div>
      </div>
      <div class="field">
        <label for="f-purchase">購入日</label>
        <input id="f-purchase" type="date" value="${esc(w.purchase_date ?? '')}">
        <div class="hint" id="h-purchase"></div>
      </div>
      <div class="field">
        <label for="f-months">保証期間(月数)</label>
        <input id="f-months" type="number" min="1" max="600" inputmode="numeric" value="${esc(w.warranty_months ?? '')}" placeholder="例: 12">
        <div class="hint" id="h-months"></div>
      </div>
      <div class="field">
        <label for="f-end">保証終了日</label>
        <input id="f-end" type="date" value="${esc(w.warranty_end_date ?? '')}">
        <div class="hint" id="h-end">購入日と保証期間から自動計算されます。手動でも設定できます。</div>
      </div>
      <div class="field">
        <label for="f-note">メモ</label>
        <textarea id="f-note" rows="2" maxlength="1000" placeholder="購入店・シリアル番号など">${esc(w.note ?? '')}</textarea>
      </div>`;
  }

  function bindCapture() {
    const $file = document.getElementById('file-input');
    document.getElementById('capture-area').addEventListener('click', () => $file.click());
    $file.addEventListener('change', async () => {
      const file = $file.files && $file.files[0];
      if (!file) return;
      const $zone = document.getElementById('capture-zone');
      $zone.innerHTML = '<div class="loading"><span class="spinner"></span> 画像を処理中…</div>';
      const dataUrl = await resizeImage(file);
      if (!dataUrl) {
        toast('この画像形式は読み込めませんでした。別の画像を選択してください。');
        renderCaptureArea();
        return;
      }
      draft.imageDataUrl = dataUrl;
      renderPreview();
    });
  }

  function renderCaptureArea() {
    document.getElementById('capture-zone').innerHTML = `
      <div class="capture-area" id="capture-area">
        <div class="cam">📷</div>
        <p>タップして保証書を撮影<br>(または画像を選択)</p>
      </div>`;
    document.getElementById('ocr-zone').innerHTML = '';
    document.getElementById('capture-area').addEventListener('click', () =>
      document.getElementById('file-input').click());
  }

  function renderPreview() {
    document.getElementById('capture-zone').innerHTML = `
      <div class="preview-wrap">
        <img src="${draft.imageDataUrl}" alt="保証書のプレビュー">
        <p style="font-size:13px;color:var(--ink-2);margin:8px 0 0">文字がはっきり読めるか確認してください。</p>
        <div class="preview-actions">
          <button type="button" class="btn btn-secondary" id="retake-btn">撮り直す</button>
        </div>
      </div>`;
    document.getElementById('retake-btn').addEventListener('click', () => {
      draft.imageDataUrl = null;
      renderCaptureArea();
    });
    renderOcrButton();
  }

  function renderOcrButton() {
    const $zone = document.getElementById('ocr-zone');
    const ocr = me.ocr;
    if (ocr.daily_paused) {
      $zone.innerHTML = '<div class="notice">本日は混み合っています。読み取りは明日以降にお試しください。手動入力は利用できます。</div>';
      return;
    }
    if (ocr.weekly_remaining !== null && ocr.weekly_remaining <= 0) {
      $zone.innerHTML = '<div class="notice">今週の読み取り回数を使い切りました。手動入力は引き続き利用できます。</div>';
      return;
    }
    const label = ocr.weekly_remaining === null
      ? '読み取って自動入力'
      : `読み取って自動入力(今週あと${ocr.weekly_remaining}回)`;
    $zone.innerHTML = `<button type="button" class="btn btn-primary" id="ocr-btn">🔍 ${label}</button>
      <p style="font-size:12px;color:var(--ink-3);margin:6px 0 12px">読み取り後も全項目を修正できます。読み取らずに手動入力もできます。</p>`;
    document.getElementById('ocr-btn').addEventListener('click', runOcr);
  }

  async function runOcr() {
    const $zone = document.getElementById('ocr-zone');
    $zone.innerHTML = '<div class="loading"><span class="spinner"></span> 読み取り中…(十数秒かかることがあります)</div>';
    try {
      const data = await api('/api/ocr', { method: 'POST', body: { image: draft.imageDataUrl } });
      me.ocr = data.usage;
      draft.ocrUsed = true;
      draft.ocrResult = data.result;
      applyOcrResult(data.result);
      $zone.innerHTML = '<div class="notice-privacy">✅ 読み取りました。内容を確認・修正してください。読み取れなかった項目は空欄です。</div>';
    } catch (err) {
      if (err.handled) return;
      if (err.data && (err.data.error === 'weekly_limit' || err.data.error === 'daily_limit')) {
        try { const m = await api('/api/me'); me = m; } catch { /* 表示だけの問題なので無視 */ }
        $zone.innerHTML = `<div class="notice">${esc(err.message)}</div>`;
      } else {
        $zone.innerHTML = '';
        renderOcrButton();
        toast(err.message);
      }
    }
  }

  function applyOcrResult(r) {
    const misses = [];
    const set = (id, hintId, value, missLabel) => {
      const $el = document.getElementById(id);
      const $hint = document.getElementById(hintId);
      if (value !== null && value !== undefined) {
        $el.value = value;
        if ($hint) { $hint.textContent = '読み取り結果(修正できます)'; $hint.className = 'hint auto'; }
      } else {
        misses.push(missLabel);
        if ($hint) { $hint.textContent = '読み取れませんでした。手動で入力してください。'; $hint.className = 'hint miss'; }
      }
    };
    set('f-name', 'h-name', r.product_name, '製品名');
    set('f-purchase', 'h-purchase', r.purchase_date, '購入日');
    set('f-months', 'h-months', r.warranty_months, '保証期間');
    if (r.warranty_end_date) {
      document.getElementById('f-end').value = r.warranty_end_date;
      draft.endEdited = true; // OCRで終了日そのものが取れた場合は自動計算で上書きしない
      const $h = document.getElementById('h-end');
      $h.textContent = '読み取り結果(修正できます)';
      $h.className = 'hint auto';
    } else {
      recalcEndDate();
    }
  }

  function recalcEndDate() {
    if (draft && draft.endEdited) return;
    const purchase = document.getElementById('f-purchase').value;
    const months = parseInt(document.getElementById('f-months').value, 10);
    const $end = document.getElementById('f-end');
    const $hint = document.getElementById('h-end');
    if (purchase && months >= 1) {
      $end.value = addMonthsIso(purchase, months);
      $hint.textContent = `購入日 + ${months}ヶ月で自動計算しました(修正できます)`;
      $hint.className = 'hint auto';
    }
  }

  function bindForm(editId) {
    const $form = document.getElementById('w-form');
    document.getElementById('f-purchase').addEventListener('change', recalcEndDate);
    document.getElementById('f-months').addEventListener('input', recalcEndDate);
    document.getElementById('f-end').addEventListener('input', () => {
      if (draft) draft.endEdited = true;
      const $hint = document.getElementById('h-end');
      $hint.textContent = '手動で設定した終了日が優先されます。';
      $hint.className = 'hint';
    });

    $form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('f-name').value.trim();
      if (!name) { toast('製品名を入力してください。'); return;
      }
      const months = document.getElementById('f-months').value;
      const payload = {
        product_name: name,
        purchase_date: document.getElementById('f-purchase').value || null,
        warranty_months: months ? parseInt(months, 10) : null,
        warranty_end_date: document.getElementById('f-end').value || null,
        note: document.getElementById('f-note').value.trim() || null,
      };
      if (!payload.warranty_end_date) {
        const ok = confirm('保証終了日が未設定です。このまま保存すると期限検索の対象外になります。保存しますか?');
        if (!ok) return;
      }
      const $btn = $form.querySelector('button[type=submit]');
      $btn.disabled = true;
      try {
        if (editId) {
          await api(`/api/warranties/${encodeURIComponent(editId)}`, { method: 'PATCH', body: payload });
          toast('保存しました。');
          nav('#/');
        } else {
          payload.source = draft && draft.ocrUsed ? computeSource(payload) : 'manual';
          await api('/api/warranties', { method: 'POST', body: payload });
          draft = null; // 画像を含む一時データを破棄
          nav('#/done');
        }
      } catch (err) {
        if (!err.handled) toast(err.message);
        $btn.disabled = false;
      }
    });
  }

  function computeSource(payload) {
    const r = draft.ocrResult || {};
    const same =
      payload.product_name === (r.product_name ?? '') &&
      (payload.purchase_date ?? null) === (r.purchase_date ?? null) &&
      (payload.warranty_months ?? null) === (r.warranty_months ?? null);
    return same ? 'ocr' : 'mixed';
  }

  // ---------- 登録完了 ----------

  function renderDone() {
    $app.innerHTML = `
      ${header()}
      <div class="done-hero">
        <div class="mark">✅</div>
        <h2>登録しました</h2>
      </div>
      <div class="notice">${NOTICE_ORIGINAL}</div>
      <div class="notice-privacy">撮影した画像は保存されず、破棄されました。</div>
      <a class="btn btn-primary" href="#/add">続けて登録する</a>
      <a class="btn btn-secondary" href="#/">一覧を見る</a>
    `;
  }

  // ---------- 詳細・編集 ----------

  async function renderEdit(id) {
    draft = null;
    $app.innerHTML = `${header()}<div class="loading"><span class="spinner"></span></div>`;
    let w;
    try {
      const data = await api(`/api/warranties/${encodeURIComponent(id)}`);
      w = data.warranty;
    } catch (err) {
      if (!err.handled) { toast(err.message); nav('#/'); }
      return;
    }
    $app.innerHTML = `
      ${header()}
      <h2 class="page-title">詳細・編集</h2>
      <form id="w-form" autocomplete="off">
        ${formFields(w)}
        <button type="submit" class="btn btn-primary">保存する</button>
        <button type="button" class="btn btn-danger" id="delete-btn">この記録を削除</button>
        <a class="back-link" href="#/">← 一覧に戻る</a>
      </form>
    `;
    bindForm(id);
    document.getElementById('delete-btn').addEventListener('click', async () => {
      if (!confirm(`「${w.product_name}」を削除しますか?この操作は取り消せません。`)) return;
      try {
        await api(`/api/warranties/${encodeURIComponent(id)}`, { method: 'DELETE' });
        toast('削除しました。');
        nav('#/');
      } catch (err) {
        if (!err.handled) toast(err.message);
      }
    });
  }

  // ---------- 設定 ----------

  function renderSettings() {
    const ocr = me.ocr;
    const usage = ocr.weekly_remaining === null
      ? '読み取り回数: 無制限(テストアカウント)'
      : `今週の読み取り: ${ocr.weekly_used} / ${ocr.weekly_limit}回`;
    $app.innerHTML = `
      ${header()}
      <h2 class="page-title">設定</h2>
      <div class="card">
        <div style="font-size:14px">${esc(me.user.display_name ?? '')}</div>
        <div style="font-size:13px;color:var(--ink-2)">${esc(me.user.email)}</div>
        <div style="font-size:13px;color:var(--ink-2);margin-top:6px">${usage}</div>
      </div>

      <div class="settings-section">
        <h3>データのエクスポート</h3>
        <div class="settings-row">
          <a class="btn btn-secondary" href="/api/export?format=csv">CSV</a>
          <a class="btn btn-secondary" href="/api/export?format=json" style="margin-top:0">JSON</a>
        </div>
      </div>

      <div class="settings-section">
        <h3>規約・ポリシー</h3>
        ${legalSections()}
      </div>

      <div class="settings-section">
        <h3>アカウント</h3>
        <button class="btn btn-secondary" id="logout-btn">ログアウト</button>
        <button class="btn btn-danger" id="delete-account-btn">アカウントと全データを削除</button>
      </div>
      <a class="back-link" href="#/">← 一覧に戻る</a>
    `;
    document.getElementById('logout-btn').addEventListener('click', async () => {
      try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* 401でも続行 */ }
      me = null;
      nav('#/');
      render();
    });
    document.getElementById('delete-account-btn').addEventListener('click', async () => {
      if (!confirm('アカウントと登録した全ての記録を完全に削除します。この操作は取り消せません。よろしいですか?')) return;
      if (!confirm('本当に削除しますか?(必要ならエクスポートを先に行ってください)')) return;
      try {
        await api('/api/account', { method: 'DELETE' });
        me = null;
        toast('アカウントを削除しました。ご利用ありがとうございました。');
        nav('#/');
        render();
      } catch (err) {
        if (!err.handled) toast(err.message);
      }
    });
  }

  // ---------- 起動 ----------

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* PWA未対応環境では無視 */ });
  }

  (async () => {
    $app.innerHTML = '<div class="loading"><span class="spinner"></span></div>';
    try {
      me = await api('/api/me');
    } catch {
      me = null;
    }
    render();
  })();
})();
