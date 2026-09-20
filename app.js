/* おぼえる — a quiz page for one learning set.
 *
 * The page reads bank.json (questions built by engine/build_bank.py) and writes
 * one file of answer events per device. Nothing else on the server changes, so
 * two devices never fight over the same file; the engine merges the per-device
 * logs when it rebuilds state.
 *
 * The review rule lives in schedule.js, which engine/ingest.py mirrors and
 * tools/check_schedule.py compares. Nothing here decides when a card is due.
 */
'use strict';

const LS = {
  cfg: 'obo.cfg',
  bank: 'obo.bank.',
  events: 'obo.events.',
  sha: 'obo.sha.',
  device: 'obo.device',
};

const READY_BOX = Schedule.READY_BOX;
const SESSION_LEN = 12;

const S = {
  cfg: null,
  bank: null,
  events: [],       // this device's events, the ones we own and sync
  remote: [],       // events read from other devices, read only
  qstate: new Map(),
  session: null,
  mode: 'remote',   // 'remote' (GitHub) or 'local' (bank.json next to the page)
  syncing: false,
  pushAgain: false,
  dirty: false,
  lastSyncError: '',
};

/* ---------- small helpers ---------- */

const $ = (id) => document.getElementById(id);
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const parseTs = (s) => (s ? Date.parse(s) : 0);

function uid() {
  if (crypto.randomUUID) return crypto.randomUUID().slice(0, 18);
  return Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

function readLS(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeLS(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}

function deviceId() {
  let d = readLS(LS.device, null);
  if (!d) {
    const ua = navigator.userAgent;
    const kind = /iPhone|iPad|iPod/.test(ua) ? 'ios' : /Android/.test(ua) ? 'android' : /Mac/.test(ua) ? 'mac' : 'pc';
    d = kind + '-' + uid().slice(0, 8);
    writeLS(LS.device, d);
  }
  return d;
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function shuffle(arr, seed) {
  // deterministic when a seed is given, so a reloaded question keeps its order
  let s = 0;
  for (let i = 0; i < String(seed).length; i++) s = (s * 31 + String(seed).charCodeAt(i)) >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor((seed === undefined ? Math.random() : rnd()) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ---------- scheduling (mirror of engine/ingest.py) ---------- */

function intervals() {
  return (S.bank && S.bank.review_intervals_minutes) || Schedule.DEFAULT_INTERVALS;
}

function deadlineMs() {
  const dl = S.bank && S.bank.deadline ? Date.parse(S.bank.deadline) : NaN;
  return Number.isNaN(dl) ? 0 : dl;
}

function fractions() {
  return (S.bank && S.bank.deadline_fractions) || Schedule.DEFAULT_FRACTIONS;
}

function applyEvent(st, ev) {
  Schedule.apply(st, !!ev.correct, parseTs(ev.ts), intervals(), deadlineMs(), fractions());
}

function rebuildState() {
  const table = Schedule.replay(S.events.concat(S.remote), intervals(), deadlineMs(), fractions());
  S.qstate = new Map(Object.entries(table));
  return S.qstate;
}

/* ---------- queue ---------- */

function questionsById() {
  const m = new Map();
  for (const q of S.bank.questions) m.set(q.id, q);
  return m;
}

function buildQueue(opts) {
  const only = (opts && opts.only) || null;   // 'weak' limits to items answered wrong
  const now = Date.now();
  const qs = S.bank.questions;
  const wrongItems = new Set();
  for (const [qid, st] of S.qstate) {
    if (st.history.includes('x')) {
      const q = qs.find((x) => x.id === qid);
      if (q) wrongItems.add(q.item);
    }
  }

  const due = [];
  const fresh = [];
  for (const q of qs) {
    if (only === 'weak' && !wrongItems.has(q.item)) continue;
    if (!unlocked(q)) continue;
    const st = S.qstate.get(q.id);
    if (!st) fresh.push(q);
    else if (st.due !== null && st.due <= now) due.push(q);
  }
  due.sort((a, b) => S.qstate.get(a.id).due - S.qstate.get(b.id).due);

  // Interleave review and new so the session is not two blocks.
  const out = [];
  let i = 0;
  let j = 0;
  const wantDue = Math.min(due.length, Math.ceil(SESSION_LEN * 0.7));
  while (out.length < SESSION_LEN && (i < due.length || j < fresh.length)) {
    const takeDue = i < wantDue && (j >= fresh.length || out.length % 3 !== 2);
    if (takeDue && i < due.length) out.push(due[i++]);
    else if (j < fresh.length) out.push(fresh[j++]);
    else if (i < due.length) out.push(due[i++]);
    else break;
  }
  return spaceOutItems(out);
}

/** A question naming the answer and asking which place it belongs to only makes
 *  sense once the place itself is known, so it waits for its forward sibling.
 *  Little & Bjork's benefit comes from weighing the choices against each other,
 *  which a learner who has never met any of them cannot do. */
function unlocked(q) {
  if (!q.after) return true;
  return Schedule.known(S.qstate.get(q.after));
}

/** Avoid two questions about the same place back to back. */
function spaceOutItems(list) {
  const out = [];
  const rest = list.slice();
  while (rest.length) {
    let pick = 0;
    if (out.length) {
      const prev = out[out.length - 1].item;
      const alt = rest.findIndex((q) => q.item !== prev);
      if (alt > 0) pick = alt;
    }
    out.push(rest.splice(pick, 1)[0]);
  }
  return out;
}

/* ---------- GitHub ---------- */

function api(path, init) {
  const cfg = S.cfg;
  const url = `https://api.github.com/repos/${cfg.repo}/contents/${path}`;
  const headers = Object.assign(
    {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    (init && init.headers) || {}
  );
  return fetch(url, Object.assign({}, init, { headers }));
}

async function fetchBank() {
  if (S.mode === 'local') {
    const res = await fetch('bank.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('bank.json を読み込めませんでした');
    return res.json();
  }
  const res = await api(`domains/${S.cfg.domain}/bank.json`, {
    headers: { Accept: 'application/vnd.github.raw+json' },
  });
  if (!res.ok) throw new Error(await describe(res));
  return res.json();
}

async function describe(res) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body.message || '';
  } catch (e) { /* no body */ }
  if (res.status === 401) return 'トークンが無効です。設定を確認してください。';
  if (res.status === 403) return 'アクセスが拒否されました。トークンの権限を確認してください。';
  if (res.status === 404) return 'ファイルが見つかりません。リポジトリ名と学習セット名を確認してください。';
  return `通信に失敗しました (${res.status}${detail ? ' ' + detail : ''})`;
}

async function pullRemoteEvents() {
  if (S.mode === 'local') return;
  const mine = `device-${deviceId()}.json`;
  const res = await api(`domains/${S.cfg.domain}/events`);
  if (res.status === 404) return;            // no events yet
  if (!res.ok) throw new Error(await describe(res));
  const list = await res.json();
  const files = list.filter((f) => f.type === 'file' && f.name.endsWith('.json'));
  const out = [];
  for (const f of files) {
    if (f.name === mine) {
      writeLS(LS.sha + S.cfg.domain, f.sha);
      continue;
    }
    const r = await api(`domains/${S.cfg.domain}/events/${f.name}`, {
      headers: { Accept: 'application/vnd.github.raw+json' },
    });
    if (!r.ok) continue;
    try {
      const body = await r.json();
      const evs = Array.isArray(body) ? body : body.events || [body];
      for (const e of evs) if (e && e.id && e.qid) out.push(e);
    } catch (e) { /* skip a file we cannot read */ }
  }
  S.remote = out;
}

/** Send this device's answers.
 *
 *  An answer given while a send is already in flight is not in that request.
 *  The count that went out is compared with the count now, and a follow-up runs
 *  instead of marking everything saved. Without that, an answer given during a
 *  send would sit on the device while the page said it was saved, which is the
 *  one thing the page must never say.
 */
async function pushEvents() {
  if (S.mode === 'local' || !S.dirty) return;
  if (S.syncing) {
    S.pushAgain = true;
    return;
  }
  S.syncing = true;
  S.pushAgain = false;
  const domain = S.cfg.domain;
  const path = `domains/${domain}/events/device-${deviceId()}.json`;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const sent = S.events.length;
      const body = {
        device: deviceId(),
        domain: domain,
        updated: nowIso(),
        events: S.events.slice(0, sent),
      };
      const sha = readLS(LS.sha + domain, null);
      const payload = {
        message: `answers from ${deviceId()}`,
        content: b64encode(JSON.stringify(body, null, 1) + '\n'),
      };
      if (sha) payload.sha = sha;
      const res = await api(path, { method: 'PUT', body: JSON.stringify(payload) });
      if (res.ok) {
        const out = await res.json();
        writeLS(LS.sha + domain, out.content.sha);
        S.lastSyncError = '';
        S.dirty = S.events.length > sent;
        return;
      }
      if (res.status === 409 || res.status === 422) {
        // another tab wrote this file; take its answers in and try once more
        const cur = await api(path);
        if (cur.ok) {
          const meta = await cur.json();
          writeLS(LS.sha + domain, meta.sha);
          try {
            const theirs = JSON.parse(b64decode(meta.content)).events || [];
            const ids = new Set(S.events.map((e) => e.id));
            for (const e of theirs) if (e && e.id && !ids.has(e.id)) S.events.push(e);
            S.events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
            saveLocalEvents();
          } catch (e) { /* keep ours */ }
          continue;
        }
      }
      S.lastSyncError = await describe(res);
      return;
    }
  } catch (e) {
    S.lastSyncError = navigator.onLine ? '同期できませんでした。' : 'オフラインです。';
  } finally {
    S.syncing = false;
    paintSyncNote();
    if (S.dirty || S.pushAgain) {
      S.pushAgain = false;
      setTimeout(pushEvents, S.lastSyncError ? 15000 : 250);
    }
  }
}

/* ---------- persistence ---------- */

function saveLocalEvents() {
  const ok = writeLS(LS.events + S.cfg.domain, S.events);
  if (!ok) S.lastSyncError = 'この端末に保存できませんでした。';
}

function record(q, chosen, correct, dunno, ms) {
  const ev = {
    id: uid(),
    ts: nowIso(),
    device: deviceId(),
    domain: S.cfg.domain,
    qid: q.id,
    item: q.item,
    facet: q.facet,
    kind: q.kind,
    choice: chosen,
    correct: correct,
    dunno: !!dunno,
    first_seen: !S.qstate.has(q.id),
    ms: ms,
    bank_built_at: S.bank.built_at || null,
    app: 'obo-1',
  };
  S.events.push(ev);
  saveLocalEvents();
  S.dirty = true;
  let st = S.qstate.get(q.id);
  if (!st) {
    st = Schedule.blank();
    S.qstate.set(q.id, st);
  }
  applyEvent(st, ev);
  pushEvents();
  return ev;
}

/* ---------- screens ---------- */

function show(name) {
  for (const el of document.querySelectorAll('.screen')) el.classList.remove('on');
  const el = $('screen-' + name);
  if (el) el.classList.add('on');
  window.scrollTo(0, 0);
}

function paintSyncNote() {
  const note = S.mode === 'local'
    ? 'この端末だけで動いています。'
    : S.lastSyncError
      ? S.lastSyncError + ' 回答はこの端末に保存してあります。'
      : S.dirty ? '保存しています' : '';
  for (const id of ['home-msg', 'r-msg']) {
    const el = $(id);
    if (!el) continue;
    el.textContent = note;
    el.dataset.tone = S.lastSyncError ? 'bad' : '';
  }
}

function fmtDeadline() {
  if (!S.bank.deadline) return '';
  const left = Date.parse(S.bank.deadline) - Date.now();
  if (Number.isNaN(left)) return '';
  if (left < 0) return '';
  const h = Math.floor(left / 3600000);
  if (h >= 48) return `あと${Math.floor(h / 24)}日`;
  if (h >= 1) return `あと${h}時間`;
  return `あと${Math.max(1, Math.floor(left / 60000))}分`;
}

function paintHome() {
  const b = S.bank;
  $('home-title').textContent = b.short_title || b.title;
  $('home-eyebrow').textContent = fmtDeadline();
  $('home-goal').textContent = b.goal || '';

  const now = Date.now();
  let due = 0;
  let fresh = 0;
  let wrong = 0;
  let learned = 0;
  for (const q of b.questions) {
    const st = S.qstate.get(q.id);
    if (!st) fresh++;
    else if (st.due !== null && st.due <= now) due++;
    if (st && st.history.includes('x')) wrong++;
    if (Schedule.known(st)) learned++;
  }

  // Questions, not a claim about what the learner can now say. The same three
  // numbers mean the same thing whether the set is places, songs or terms.
  const rows = [
    ['おぼえた問題', `${learned}<span class="unit"> / ${b.questions.length}</span>`],
    ['復習の問題', `${due}<span class="unit"> 問</span>`],
    ['はじめての問題', `${fresh}<span class="unit"> 問</span>`],
  ];
  $('home-stats').innerHTML = rows
    .map(([k, v]) => `<div class="stat"><span class="stat-label">${k}</span><span class="stat-value">${v}</span></div>`)
    .join('');

  const total = due + fresh;
  const start = $('btn-start');
  if (total === 0) {
    start.textContent = '今は出す問題がありません';
    start.disabled = true;
  } else {
    start.disabled = false;
    start.textContent = S.qstate.size === 0 ? 'はじめる' : '続きから';
  }
  $('btn-weak').hidden = wrong === 0;
  paintSyncNote();
}

function startSession(opts) {
  const queue = buildQueue(opts);
  if (!queue.length) {
    $('home-msg').textContent = '今は出す問題がありません。';
    return;
  }
  S.session = { queue, idx: 0, answers: [], startedAt: Date.now() };
  show('quiz');
  paintQuestion();
}

function paintQuestion() {
  const s = S.session;
  const q = s.queue[s.idx];
  $('q-counter').textContent = `${s.idx + 1} / ${s.queue.length}`;
  $('q-progress').style.width = `${(s.idx / s.queue.length) * 100}%`;

  const item = S.bank.items.find((x) => x.id === q.item);
  const place = item && item.town ? (S.bank.items.find((x) => x.id === item.town) || {}).name : '';
  const typeLabel = (S.bank.type_labels && S.bank.type_labels[q.type]) || '';
  const st = S.qstate.get(q.id);
  const again = st && st.history.includes('x') ? '前に間違えた問題' : '';
  $('q-eyebrow').textContent = again || [place, typeLabel].filter(Boolean).join(' / ');

  $('q-prompt').textContent = q.prompt;

  const box = $('q-choices');
  box.innerHTML = '';
  const opts = shuffle(q.options, q.id);
  for (const opt of opts) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'choice';
    btn.innerHTML = `<span class="label"></span>`;
    btn.querySelector('.label').textContent = opt.text;
    btn.addEventListener('click', () => answer(opt, btn));
    box.appendChild(btn);
  }
  $('btn-dunno').hidden = false;
  const v = $('q-verdict');
  v.hidden = true;
  v.removeAttribute('data-tone');
  s.shownAt = Date.now();
}

const MARK_OK = '<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5l5.5 5.5L20 6.5" fill="none"/></svg>';
const MARK_NG = '<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none"/></svg>';

function answer(opt, btn) {
  const s = S.session;
  const q = s.queue[s.idx];
  if (s.answered) return;
  s.answered = true;
  const correct = !!(opt && opt.correct);
  const ms = Date.now() - s.shownAt;
  record(q, opt ? opt.text : null, correct, !opt, ms);
  s.answers.push({ q, correct, dunno: !opt });

  for (const el of $('q-choices').children) {
    const text = el.querySelector('.label').textContent;
    const isRight = q.options.some((o) => o.correct && o.text === text);
    if (isRight) {
      el.dataset.state = 'correct';
      el.insertAdjacentHTML('afterbegin', MARK_OK);
    } else if (el === btn) {
      el.dataset.state = 'wrong';
      el.insertAdjacentHTML('afterbegin', MARK_NG);
    } else {
      el.dataset.state = 'dim';
    }
    el.setAttribute('aria-disabled', 'true');
    el.tabIndex = -1;
  }
  $('btn-dunno').hidden = true;

  const v = $('q-verdict');
  v.dataset.tone = correct ? 'ok' : 'ng';
  $('v-head').textContent = correct ? '正解' : (opt ? '不正解' : 'こたえ');
  const ans = $('v-answer');
  if (correct) {
    ans.hidden = true;
  } else {
    ans.hidden = false;
    ans.textContent = `正解：${q.answer}`;
  }
  $('v-text').textContent = q.explain || '';

  // Say whose answer the chosen one really was. A plausible wrong choice is one
  // the learner reasoned their way to, and those are the ones that stick
  // (Marsh et al. 2007), so the wrong pairing is named and undone on the spot.
  const note = $('v-note');
  let extra = '';
  if (!correct && opt && opt.item && opt.item !== q.item && opt.item_name) {
    extra = `選んだ「${opt.text}」は${opt.item_name}のこと。`;
  } else if (q.hitokoto && q.facet === 'difference') {
    extra = q.hitokoto;
  }
  note.hidden = !extra;
  note.textContent = extra;
  v.hidden = false;
  $('btn-next').textContent = s.idx + 1 >= s.queue.length ? '結果を見る' : '次へ';
  $('btn-next').focus({ preventScroll: true });
}

function next() {
  const s = S.session;
  s.answered = false;
  s.idx += 1;
  if (s.idx >= s.queue.length) return finish();
  paintQuestion();
}

function finish() {
  const s = S.session;
  const right = s.answers.filter((a) => a.correct).length;
  $('r-score').textContent = `${s.answers.length}問中${right}問正解`;
  const mins = Math.max(1, Math.round((Date.now() - s.startedAt) / 60000));
  const missed = s.answers.filter((a) => !a.correct);
  $('r-note').textContent = missed.length
    ? `所要 ${mins}分。間違えた${missed.length}問はあとでもう一度出ます。`
    : `所要 ${mins}分。`;
  $('r-recap').innerHTML = missed
    .map((a) => {
      const li = document.createElement('li');
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = a.q.item_name;
      const what = document.createElement('span');
      what.className = 'what';
      what.textContent = ` ${a.q.answer}`;
      li.appendChild(who);
      li.appendChild(what);
      return li.outerHTML;
    })
    .join('');
  const more = buildQueue().length;
  $('btn-again').textContent = more ? '続ける' : 'ホームに戻る';
  show('result');
  paintSyncNote();
  pushEvents();
}

function paintBrowse() {
  const b = S.bank;
  const label = b.item_label || '項目';
  $('browse-title').textContent = `${label}の一覧`;
  $('btn-browse').textContent = `${label}の一覧`;
  const order = { pref: 0, town: 1, spot: 2 };
  const items = b.items.slice().sort((x, y) => (order[x.type] ?? 9) - (order[y.type] ?? 9));
  const frag = document.createDocumentFragment();
  for (const it of items) {
    const fwd = b.questions.filter((q) => q.item === it.id && q.kind === 'fwd');
    const done = fwd.filter((q) => Schedule.known(S.qstate.get(q.id))).length;
    const div = document.createElement('div');
    div.className = 'place';
    const h = document.createElement('h3');
    h.textContent = it.short_name || it.name;
    const bar = document.createElement('span');
    bar.className = 'bar';
    bar.textContent = fwd.length ? `${done} / ${fwd.length}` : '';
    h.appendChild(bar);
    div.appendChild(h);
    if (it.kind || it.town) {
      const w = document.createElement('p');
      w.className = 'where';
      const townName = it.town ? (b.items.find((x) => x.id === it.town) || {}).name : '';
      w.textContent = [townName, it.kind].filter(Boolean).join(' / ');
      div.appendChild(w);
    }
    const dl = document.createElement('dl');
    for (const [key, fx] of Object.entries(it.facets || {})) {
      if (!fx || !fx.answer) continue;
      const dt = document.createElement('dt');
      dt.textContent = fx.label || key;
      const dd = document.createElement('dd');
      dd.textContent = fx.text || fx.answer;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    div.appendChild(dl);
    if (it.hitokoto) {
      const p = document.createElement('p');
      p.className = 'one';
      p.textContent = it.hitokoto;
      div.appendChild(p);
    }
    if (it.links && it.links.length) {
      const nav = document.createElement('p');
      nav.className = 'links';
      for (const l of it.links) {
        const a = document.createElement('a');
        a.href = l.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = l.title;
        nav.appendChild(a);
      }
      div.appendChild(nav);
    }
    frag.appendChild(div);
  }
  const host = $('browse-list');
  host.innerHTML = '';
  host.appendChild(frag);
}

/* ---------- boot ---------- */

/** A link can carry the repository and the set so only the token has to be
 *  typed on a phone. The token itself never goes in a URL. */
function prefillFromHash() {
  const h = location.hash.replace(/^#/, '');
  if (!h) return null;
  const p = new URLSearchParams(h);
  const repo = p.get('repo');
  const domain = p.get('domain');
  if (!repo && !domain) return null;
  return { repo: repo || '', domain: domain || '', token: '' };
}

function paintSetup() {
  const cfg = S.cfg || prefillFromHash() || {};
  $('in-repo').value = cfg.repo || '';
  $('in-token').value = cfg.token || '';
  $('in-domain').value = cfg.domain || '';
}

async function loadAndShow() {
  const cached = readLS(LS.bank + S.cfg.domain, null);
  if (cached) {
    S.bank = cached;
    S.events = readLS(LS.events + S.cfg.domain, []) || [];
    rebuildState();
    paintHome();
    show('home');
  }
  try {
    const bank = await fetchBank();
    S.bank = bank;
    writeLS(LS.bank + S.cfg.domain, bank);
    S.events = readLS(LS.events + S.cfg.domain, []) || [];
    await pullRemoteEvents();
    rebuildState();
    paintHome();
    show('home');
    if (S.dirty) pushEvents();
  } catch (err) {
    if (!S.bank) {
      $('setup-msg').textContent = err.message || String(err);
      $('setup-msg').dataset.tone = 'bad';
      show('setup');
      return;
    }
    S.lastSyncError = err.message || String(err);
    paintSyncNote();
  }
}

async function boot() {
  document.getElementById('app').hidden = false;
  S.cfg = readLS(LS.cfg, null);

  // A bank.json sitting next to the page means local use: no token, no sync.
  if (!S.cfg || !S.cfg.token) {
    try {
      const probe = await fetch('bank.json', { method: 'GET', cache: 'no-cache' });
      if (probe.ok) {
        const bank = await probe.json();
        S.mode = 'local';
        S.cfg = { repo: '', token: '', domain: bank.domain || 'local' };
        S.bank = bank;
        writeLS(LS.bank + S.cfg.domain, bank);
        S.events = readLS(LS.events + S.cfg.domain, []) || [];
        rebuildState();
        paintHome();
        show('home');
        return;
      }
    } catch (e) { /* no local bank; ask for a token */ }
  }

  if (!S.cfg || !S.cfg.repo || !S.cfg.token || !S.cfg.domain) {
    paintSetup();
    show('setup');
    $('in-token').focus({ preventScroll: true });
    return;
  }
  await loadAndShow();
}

function wire() {
  $('btn-save-setup').addEventListener('click', async () => {
    const cfg = {
      repo: $('in-repo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, ''),
      token: $('in-token').value.trim(),
      domain: $('in-domain').value.trim(),
    };
    if (!cfg.repo.includes('/') || !cfg.token || !cfg.domain) {
      $('setup-msg').textContent = '3つとも入力してください。';
      $('setup-msg').dataset.tone = 'bad';
      return;
    }
    S.cfg = cfg;
    S.mode = 'remote';
    writeLS(LS.cfg, cfg);
    $('setup-msg').textContent = '読み込んでいます';
    $('setup-msg').dataset.tone = '';
    await loadAndShow();
  });

  $('btn-start').addEventListener('click', () => startSession());
  $('btn-weak').addEventListener('click', () => startSession({ only: 'weak' }));
  $('btn-next').addEventListener('click', next);
  $('btn-dunno').addEventListener('click', () => answer(null, null));
  $('btn-quit').addEventListener('click', () => {
    paintHome();
    show('home');
  });
  $('btn-again').addEventListener('click', () => {
    if (buildQueue().length) startSession();
    else {
      paintHome();
      show('home');
    }
  });
  $('btn-home').addEventListener('click', () => {
    paintHome();
    show('home');
  });
  $('btn-browse').addEventListener('click', () => {
    paintBrowse();
    show('browse');
  });
  $('btn-browse-back').addEventListener('click', () => {
    paintHome();
    show('home');
  });
  $('btn-settings').addEventListener('click', () => {
    paintSetup();
    show('setup');
  });

  window.addEventListener('online', () => pushEvents());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') pushEvents();
  });
}

wire();
boot();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline cache is optional */ });
  });
}
