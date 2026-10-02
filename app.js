/* おぼえる — a quiz page for one learning set.
 *
 * The page reads bank.json (questions built by engine/build_bank.py) and writes
 * one file of answer events per device. Nothing else on the server changes, so
 * two devices never fight over the same file; the engine merges the per-device
 * logs when it rebuilds state.
 *
 * The review rule lives in schedule.js, which engine/ingest.py mirrors and
 * tools/check_schedule.py compares. Nothing here decides when a card is due.
 *
 * The look is a marked answer sheet. Questions are set in ink; an answer is
 * marked in vermilion the way a teacher marks a paper, a circle on the right
 * choice and a stroke through a wrong one. After the mark, every choice turns
 * over to say what it really is, because the wrong choices are real answers to
 * other questions (or fail a rule for a stated reason), and seeing that is the
 * point of having them.
 */
'use strict';

const LS = {
  cfg: 'obo.cfg',
  bank: 'obo.bank.',
  events: 'obo.events.',
  sha: 'obo.sha.',
  device: 'obo.device',
  dirty: 'obo.dirty.',
  sets: 'obo.sets',
  notes: 'obo.notes',
};

const SESSION_LEN = 12;
// New questions per day. Reviews are never capped; new ones are, so a day has
// an end and tomorrow's reviews stay a size that fits in ten minutes.
const NEW_PER_DAY = 12;
// A card missed twice in a sitting is due at once by the review rule, which
// would leave a one-question sitting waiting the moment the last one ends.
// The page offers a card no sooner than ten minutes after its last answer;
// the rule itself, and engine/ingest.py, are unchanged.
const REST_MIN = 10;
function readyAt(st) {
  if (!st || st.due === null) return null;
  // Left wrong when the sitting ended (missed again on the second ask, or
  // missed when the second asks were used up): back tomorrow, so a finished
  // day stays finished. With a deadline close, ten minutes is enough.
  if (st.lastCorrect === false && !(deadlineMs() > Date.now())) {
    return Math.max(st.due, Schedule.dayStart(st.lastTs || 0, 1));
  }
  return Math.max(st.due, (st.lastTs || 0) + REST_MIN * 60000);
}
// A question missed in a sitting comes back before the sitting ends, a few
// questions later so that the answer has to be recalled rather than repeated.
const REASK_GAP = 3;
const REASK_MAX = 4;

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
  screen: '',
};

/* ---------- small helpers ---------- */

const $ = (id) => document.getElementById(id);
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const parseTs = (s) => (s ? Date.parse(s) : 0);
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Build an element. h('p', {class: 'x'}, 'text', child) */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }
  return el;
}

function svgUse(id, cls) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  // The stroke is drawn from a copy of the path rather than <use>, so that its
  // length can be measured and the line drawn in, as a pen would.
  const src = document.querySelector(`#${id} path`);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', src.getAttribute('d'));
  path.setAttribute('pathLength', '1');
  svg.appendChild(path);
  return svg;
}

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

/** Join two pieces, with a space where a Latin word meets Japanese, as a
 *  typesetter would: "F のディグリー", "キー C の C". */
function join(a, b) {
  const latinEnd = /[A-Za-z0-9#♯♭)]$/.test(a);
  const latinStart = /^[A-Za-z0-9(]/.test(b);
  return a + (latinEnd !== latinStart ? ' ' : '') + b;
}

/** "10分後" "3日後": how far off a moment is, in the units a person would use. */
function fromNow(ms) {
  const min = Math.round((ms - Date.now()) / 60000);
  if (min < 1) return '次の回';
  // a learning day begins at 4am; a later day is named by its count, not hours
  const days = Math.round((Schedule.dayStart(ms, 0) - Schedule.dayStart(Date.now(), 0)) / Schedule.DAY_MS);
  if (days === 1) return 'あす';
  if (days >= 2) return days < 14 ? `${days}日後` : `${Math.round(days / 7)}週間後`;
  if (min < 60) return `${min}分後`;
  return `${Math.round(min / 60)}時間後`;
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

/** Questions met for the first time today, on this device or another. */
function newToday() {
  const start = new Date(Schedule.dayStart(Date.now(), 0));
  const firstAt = new Map();
  for (const e of S.events.concat(S.remote)) {
    const t = parseTs(e.ts);
    if (!firstAt.has(e.qid) || t < firstAt.get(e.qid)) firstAt.set(e.qid, t);
  }
  let n = 0;
  for (const t of firstAt.values()) if (t >= start.getTime()) n += 1;
  return n;
}

function buildQueue(opts) {
  const only = (opts && opts.only) || null;   // 'weak' limits to items answered wrong
  const extra = !!(opts && opts.extra);       // past today's new-question cap, asked for
  const now = Date.now();
  const qs = S.bank.questions;
  const byId = new Map(qs.map((q) => [q.id, q]));
  const wrongItems = new Set();
  for (const [qid, st] of S.qstate) {
    if (st.history.includes('x') && byId.has(qid)) wrongItems.add(byId.get(qid).item);
  }

  const due = [];
  const fresh = [];
  for (const q of qs) {
    if (only === 'weak' && !wrongItems.has(q.item)) continue;
    if (!unlocked(q)) continue;
    const st = S.qstate.get(q.id);
    if (!st) fresh.push(q);
    else if (st.due !== null && readyAt(st) <= now) due.push(q);
  }
  due.sort((a, b) => S.qstate.get(a.id).due - S.qstate.get(b.id).due);
  const room = extra ? SESSION_LEN : Math.max(0, NEW_PER_DAY - newToday());
  fresh.splice(room);

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
  return { list: spaceOutItems(out), due: i, fresh: j };
}

/** A question naming the answer and asking which item it belongs to only makes
 *  sense once the item itself is known, so it waits for its forward sibling.
 *  Little & Bjork's benefit comes from weighing the choices against each other,
 *  which a learner who has never met any of them cannot do. */
function unlocked(q) {
  if (!q.after) return true;
  return Schedule.known(S.qstate.get(q.after));
}

/** Avoid two questions about the same item back to back. */
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
    if (!res.ok) throw new Error('bank.json を読み込めませんでした。');
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
  if (res.status === 401) return 'トークンが通りませんでした。期限切れか入力違いです。';
  if (res.status === 403) return 'このトークンには読み書きの権限がありません。';
  if (res.status === 404) return 'リポジトリか学習セットが見つかりません。';
  return `通信に失敗しました(${res.status}${detail ? ' ' + detail : ''})。`;
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
        writeLS(LS.dirty + domain, S.dirty);
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
    S.lastSyncError = navigator.onLine ? '記録を送れませんでした。' : 'オフラインです。';
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
    app: 'obo-2',
  };
  S.events.push(ev);
  saveLocalEvents();
  S.dirty = true;
  writeLS(LS.dirty + S.cfg.domain, true);
  let st = S.qstate.get(q.id);
  if (!st) {
    st = Schedule.blank();
    S.qstate.set(q.id, st);
  }
  applyEvent(st, ev);
  pushEvents();
  return st;
}

/* ---------- screens ---------- */

/** Move to a screen. The change is a cross-fade with a short rise where the
 *  browser can do it (View Transitions), and an instant swap where it cannot
 *  or the person has asked for less motion. */
function show(name, opts) {
  const swap = () => {
    for (const el of document.querySelectorAll('.screen')) el.classList.toggle('on', el.id === 'screen-' + name);
    document.documentElement.dataset.screen = name;
    S.screen = name;
    fitDock();
    if (!(opts && opts.keepScroll)) window.scrollTo(0, 0);
  };
  if (document.startViewTransition && !reduceMotion() && S.screen && S.screen !== name) {
    document.documentElement.dataset.dir = (opts && opts.back) ? 'back' : 'forward';
    document.startViewTransition(swap);
  } else {
    swap();
  }
}

/** The bottom bar changes height (one button or two, a verdict line or not),
 *  and the page has to leave exactly that much room under its last line. */
const dockWatch = typeof ResizeObserver === 'function' ? new ResizeObserver(fitDock) : null;
function fitDock() {
  const dock = document.querySelector('.screen.on .dock:not([hidden])');
  const px = dock ? Math.ceil(dock.getBoundingClientRect().height) : 0;
  document.documentElement.style.setProperty('--dock-h', `${px}px`);
}
if (dockWatch) document.querySelectorAll('.dock').forEach((d) => dockWatch.observe(d));

function paintSyncNote() {
  const note = S.mode === 'local'
    ? 'この端末だけで動いています。記録は送りません。'
    : S.lastSyncError
      ? `${S.lastSyncError}答えはこの端末に残してあり、つながったら送ります。`
      : S.dirty ? '記録を送っています。' : '';
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
  if (Number.isNaN(left) || left < 0) return '';
  const hrs = Math.floor(left / 3600000);
  if (hrs >= 48) return `目標の日まであと${Math.floor(hrs / 24)}日`;
  if (hrs >= 1) return `目標の日まであと${hrs}時間`;
  return `目標の日まであと${Math.max(1, Math.floor(left / 60000))}分`;
}

function applyTheme() {
  const b = S.bank || {};
  const t = b.theme || {};
  const root = document.documentElement;
  const pairs = [['paper', '--t-paper'], ['ink', '--t-ink'], ['mark', '--t-mark'],
                 ['paper_dark', '--t-paper-d'], ['ink_dark', '--t-ink-d'], ['mark_dark', '--t-mark-d']];
  for (const [k, v] of pairs) {
    if (t[k]) root.style.setProperty(v, t[k]);
    else root.style.removeProperty(v);
  }
  const meta = $('meta-theme');
  if (meta) meta.content = getComputedStyle(root).getPropertyValue('--paper').trim() || '#ECEAE4';
}

/* ---------- line breaks ---------- */

/** Words that must never be split across lines: the set's own item names
 *  and the labels it uses. BudouX does not know "かつお節" is one word. */
let keepWhole = [];
function rememberWords() {
  const b = S.bank;
  const words = new Set();
  for (const it of b.items) {
    for (const w of [it.name, it.short_name]) if (w && w.length > 1 && w.length < 16) words.add(w);
  }
  for (const v of Object.values(b.type_labels || {})) words.add(v);
  for (const v of ['アミノ酸の側', '核酸の側']) words.add(v);
  keepWhole = [...words].sort((x, y) => y.length - x.length);
}

/** Put text in an element with a break opportunity at each phrase, so a line
 *  never ends in the middle of a word. word-break: keep-all does the rest. */
function phrase(el, text) {
  el.textContent = '';
  el.classList.add('phr');
  if (!text) return el;
  if (!window.BudouX) {
    el.textContent = text;
    return el;
  }
  const chunks = BudouX.parse(text);
  // a boundary that falls inside a protected word is dropped
  const cuts = [];
  let at = 0;
  for (const c of chunks.slice(0, -1)) {
    at += c.length;
    cuts.push(at);
  }
  const banned = new Set();
  for (const w of keepWhole) {
    let i = text.indexOf(w);
    while (i !== -1) {
      for (let k = i + 1; k < i + w.length; k++) banned.add(k);
      i = text.indexOf(w, i + 1);
    }
  }
  let from = 0;
  for (const c of cuts) {
    if (banned.has(c)) continue;
    el.appendChild(document.createTextNode(text.slice(from, c)));
    el.appendChild(document.createElement('wbr'));
    from = c;
  }
  el.appendChild(document.createTextNode(text.slice(from)));
  return el;
}

/* ---------- the shelf: every question is a card standing in the box it has reached ---------- */

const SHELF_LOOSE = 9;     // up to this many cards stand apart; more are drawn as a bundle

function boxLabel(b) {
  if (b === 0) return 'はじめ';
  const ivs = intervals();
  const m = ivs[Math.min(b, ivs.length - 1)];
  if (m < 60) return `${m}分`;
  if (m < 1440) return `${Math.round(m / 60)}時間`;
  if (m < 10080) return `${Math.round(m / 1440)}日`;
  return `${Math.round(m / 10080)}週`;
}

/** Cards per box. A question never asked sits in the first box as a pale
 *  card; a card whose time has come is drawn solid, one still waiting light. */
function shelfState() {
  const n = intervals().length;
  const boxes = Array.from({ length: n }, () => ({ due: 0, wait: 0, fresh: 0, ids: [] }));
  const now = Date.now();
  for (const q of S.bank.questions) {
    const st = S.qstate.get(q.id);
    if (!st) {
      boxes[0].fresh += 1;
      boxes[0].ids.push({ id: q.id, kind: 'new' });
      continue;
    }
    const b = boxes[Math.min(st.box, n - 1)];
    const due = st.due !== null && readyAt(st) <= now;
    if (due) b.due += 1;
    else b.wait += 1;
    b.ids.push({ id: q.id, kind: due ? 'due' : 'wait' });
  }
  return boxes;
}

/** A small stable number per card, so each card keeps its own height and lean. */
function jitter(id, salt) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

/** Width of a bundle of n cards: grows with the square root, so 160 cards
 *  look thicker than 11 without filling the shelf. */
function bundleWidth(n) {
  return Math.round(6 + 3.4 * Math.sqrt(n));
}

function paintShelf(host, opts) {
  const landed = (opts && opts.landed) || new Set();
  const current = (opts && opts.current) || null;
  const currentLabel = (opts && opts.currentLabel) || '';
  const boxes = shelfState();
  const order = { due: 0, wait: 1, new: 2 };
  host.innerHTML = '';
  let k = 0;
  const card = (c, isNew) => {
    const el = h('i', { class: `card card-${c.kind}${isNew ? ' landed' : ''}` });
    el.style.setProperty('--r', `${((jitter(c.id, 13) - 0.5) * 3).toFixed(1)}deg`);
    if (isNew) el.style.setProperty('--k', k++);
    return el;
  };
  const bundle = (cards, isNew) => {
    const el = h('span', { class: 'bundle' + (isNew ? ' landed' : '') });
    if (isNew) el.dataset.n = `+${cards.length}`;
    el.style.width = `${bundleWidth(cards.length)}px`;
    for (const kind of ['due', 'wait', 'new']) {
      const n = cards.filter((c) => c.kind === kind).length;
      if (!n) continue;
      const seg = h('span', { class: `bundle-${kind}` });
      seg.style.flexGrow = String(n);
      el.appendChild(seg);
    }
    if (isNew) el.style.setProperty('--k', k++);
    return el;
  };
  boxes.forEach((b, i) => {
    const total = b.due + b.wait + b.fresh;
    const cards = h('div', { class: 'cards' });
    const fresh = b.ids.filter((c) => landed.has(c.id));
    const mine = b.ids.filter((c) => c.id === current);
    const rest = b.ids.filter((c) => !landed.has(c.id) && c.id !== current).sort((x, y) => order[x.kind] - order[y.kind]);
    if (rest.length > SHELF_LOOSE) cards.appendChild(bundle(rest, false));
    else for (const c of rest) cards.appendChild(card(c, false));
    if (fresh.length > 3) cards.appendChild(bundle(fresh, true));
    else for (const c of fresh) cards.appendChild(card(c, true));
    // this question's card, lifted out of its box with its name on it
    for (const c of mine) {
      const el = h('i', { class: 'card current' + (currentLabel.length > 5 ? ' long' : ''), text: currentLabel });
      cards.appendChild(el);
    }
    host.appendChild(h('div', { class: 'box' + (i >= READY_FROM ? ' kept' : '') + (total ? '' : ' empty') },
      h('div', { class: 'tray' }, cards,
        h('span', { class: 'front' }, total ? h('span', { class: 'box-count', text: String(total) }) : null)),
      h('span', { class: 'box-label', text: boxLabel(i) })));
  });
  host.style.gridTemplateColumns = `repeat(${boxes.length}, minmax(0, 1fr))`;
  host.setAttribute('role', 'img');
  host.setAttribute('aria-label', boxes.map((b, i) => `${boxLabel(i)}の箱に${b.due + b.wait + b.fresh}問`).join('。'));
  return boxes;
}

// The boxes from one day on hold what has been answered right more than once
// at a spacing; the bracket over them counts those, rather than a word like
// "learned" that two answers ten minutes apart would not earn.
const READY_FROM = Schedule.READY_BOX;

function paintBracket(boxes) {
  const kept = boxes.slice(READY_FROM).reduce((n, b) => n + b.due + b.wait, 0);
  $('bracket-label').textContent = `${boxLabel(READY_FROM)}以上の箱 ${kept}問`;
  $('shelf-bracket').style.setProperty('--from', READY_FROM + 1);
  $('shelf-bracket').style.setProperty('--to', boxes.length + 1);
  $('shelf-bracket').style.gridTemplateColumns = `repeat(${boxes.length}, minmax(0, 1fr))`;
}

/** "あす" or "3日後に": the time before a verb. */
function whenAgain(ms) {
  const w = fromNow(ms);
  return w === 'あす' || w === '次の回' ? (w === '次の回' ? '次の回で' : 'あす') : `${w}に`;
}

/** When the next reviews come, and how many: "あすの復習は12問". */
function nextReviewLine(nextDue) {
  const when = fromNow(nextDue);
  const end = new Date(Schedule.dayStart(nextDue, 1));
  const n = S.bank.questions.filter((q) => {
    const at = readyAt(S.qstate.get(q.id));
    return at !== null && at <= end.getTime();
  }).length;
  return when === 'あす' ? `あすの復習は${n}問` : `次の復習は${when}に${n}問`;
}

/** One line under the shelf: what is due now, or when the next card is. */
function shelfCaption(c) {
  if (S.qstate.size === 0) return '正解した札は右の箱へ進みます。';
  return '';
  const room = Math.max(0, NEW_PER_DAY - newToday());
  const unseen = S.bank.questions.filter((x) => !S.qstate.has(x.id)).length;
  if (c.due > 0 || (room && unseen)) return room && unseen ? `今日の新しい問題はあと${Math.min(room, unseen)}問です。` : '';
  // when the day is done the button already says when the next review is
  if (Number.isFinite(c.nextDue)) return '';
  if (Number.isFinite(c.nextDue)) {
    const soon = S.bank.questions.filter((q) => {
      const st = S.qstate.get(q.id);
      const at = readyAt(st);
      return at !== null && at >= c.nextDue && at - c.nextDue < 3600000;
    }).length;
    return `次の復習は${fromNow(c.nextDue)}に${soon}問です。`;
  }
  return c.fresh ? `まだ出ていない問題が${c.fresh}問あります。` : '';
}

/* ---------- home ---------- */

function counts() {
  const now = Date.now();
  let due = 0;
  let fresh = 0;
  let wrong = 0;
  let learned = 0;
  let nextDue = Infinity;
  for (const q of S.bank.questions) {
    const st = S.qstate.get(q.id);
    if (!st) {
      if (unlocked(q)) fresh++;
    } else if (st.due !== null && readyAt(st) <= now) {
      if (unlocked(q)) due++;
    } else if (st.due !== null) {
      nextDue = Math.min(nextDue, readyAt(st));
    }
    if (st && st.history.includes('x')) wrong++;
    if (Schedule.known(st)) learned++;
  }
  return { due, fresh, wrong, learned, nextDue, total: S.bank.questions.length };
}

function paintHome() {
  const b = S.bank;
  applyTheme();
  rememberWords();
  $('home-kicker').textContent = fmtDeadline() || `${b.questions.length}問の学習セット`;
  phrase($('home-title'), b.cover_title || b.short_title || b.title);
  phrase($('home-goal'), b.goal || '');
  $('btn-browse').textContent = `${b.item_label || '項目'}の一覧`;
  $('btn-sets').hidden = S.mode !== 'remote';
  $('btn-primer').hidden = !(b.primer && b.primer.length);
  // an odd row out runs the full width instead of leaving a hole beside it
  const rows = [...document.querySelectorAll('.menu .row')].filter((r) => !r.hidden);
  rows.forEach((r, i) => r.classList.toggle('wide', rows.length % 2 === 1 && i === rows.length - 1));

  const c = counts();
  paintBracket(paintShelf($('shelf-boxes')));
  phrase($('home-status'), shelfCaption(c));
  // the whole of today, under the shelf: what is due and what is new
  const roomToday = Math.min(c.fresh, Math.max(0, NEW_PER_DAY - newToday()));
  const plan = [c.due ? `復習${c.due}問` : '', roomToday ? `新しい問題${roomToday}問` : ''].filter(Boolean);
  $('home-plan-text').textContent = plan.join('と');

  const q = buildQueue();
  // said only when the day is more than this one sitting; otherwise the
  // button already says it
  $('home-plan').hidden = !plan.length || c.due + roomToday <= q.list.length;
  const start = $('btn-start');
  const unseen = S.bank.questions.filter((x) => !S.qstate.has(x.id)).length;
  $('home-done').hidden = !!q.list.length;
  start.hidden = !q.list.length;
  if (!q.list.length) {
    $('done-main').textContent = '今日の分は終わりました';
    $('done-sub').textContent = Number.isFinite(c.nextDue) ? nextReviewLine(c.nextDue) : '';
  } else {
    start.disabled = false;
    $('start-main').textContent = `${q.list.length}問を解く`;
    const parts = [];
    if (q.due) parts.push(`復習${q.due}問`);
    if (q.fresh) parts.push(`新しい問題${q.fresh}問`);
    $('start-sub').textContent = parts.join('と');
  }
  // past the day's cap the way on is there, but quiet
  $('btn-more').hidden = !!q.list.length || unseen === 0;
  paintSyncNote();
}

/* ---------- quiz ---------- */

function startSession(opts) {
  const q = buildQueue(opts);
  const firstN = q.list.length;
  if (!q.list.length) {
    $('home-msg').textContent = '今は出す問題がありません。';
    return;
  }
  S.session = {
    queue: q.list.map((x) => ({ q: x, again: false })),
    idx: 0,
    answers: [],
    startedAt: Date.now(),
    reasked: 0,
    firstN,
  };
  show('quiz');
  paintQuestion();
}

/** One tick per question of the sitting, which never changes in number. A
 *  missed question asked again shows as a dot after them, not a new tick. */
function paintTicks() {
  const s = S.session;
  const host = $('q-ticks');
  host.innerHTML = '';
  let firstDone = 0;
  s.queue.forEach((slot, i) => {
    const a = s.answers[i];
    const cls = [slot.again ? 'tick-extra' : 'tick'];
    if (i === s.idx) cls.push('tick-now');
    if (a) cls.push(a.correct ? 'tick-ok' : 'tick-ng');
    if (!slot.again && (a || i === s.idx)) firstDone += 1;
    if (slot.again) host.appendChild(h('li', { class: cls.join(' ') }));
    else host.insertBefore(h('li', { class: cls.join(' ') }), host.querySelector('.tick-extra'));
  });
  const cur = s.queue[s.idx];
  $('q-count').textContent = cur && cur.again ? 'もう一度' : `${firstDone}/${s.firstN}`;
}

function paintQuestion() {
  const s = S.session;
  const { q, again } = s.queue[s.idx];
  s.answered = false;
  paintTicks();

  const item = S.bank.items.find((x) => x.id === q.item);
  const place = item && item.town ? (S.bank.items.find((x) => x.id === item.town) || {}).name : '';
  const typeLabel = (S.bank.type_labels && S.bank.type_labels[q.type]) || '';
  const st = S.qstate.get(q.id);
  // Labels can hold a "・" of their own, so the parts are separate elements
  // spaced by CSS rather than joined with one.
  const flag = again ? 'もう一度' : st && st.history.includes('x') ? '前に間違えた問題' : '';
  const kicker = $('q-kicker');
  kicker.innerHTML = '';
  if (flag) kicker.appendChild(h('span', { class: 'flag', text: flag }));
  for (const part of [place, typeLabel].filter(Boolean)) kicker.appendChild(h('span', { text: part }));
  phrase($('q-prompt'), q.prompt);
  const area = $('q-area');
  area.classList.remove('answered', 'spill', 'keep-kicker');
  area.style.height = '';
  $('q-head').style.transform = '';
  area.appendChild($('q-verdict'));
  $('q-verdict').append($('v-aside'), $('v-src'));
  $('v-more').hidden = true;

  const box = $('q-choices');
  box.innerHTML = '';
  const opts = shuffle(q.options, q.id);
  opts.forEach((opt, i) => {
    const btn = h('button', { type: 'button', class: 'choice', 'data-key': String(i + 1) },
      h('span', { class: 'choice-key', text: String(i + 1), 'aria-hidden': 'true' }),
      h('span', { class: 'choice-body' },
        phrase(h('span', { class: 'choice-text' }), opt.text),
        h('span', { class: 'choice-back' }, h('span', { class: 'choice-back-in' }))));
    btn.addEventListener('click', () => {
      if (!S.session.answered) return answer(opt, btn);
      // a marked choice opens its note on a tap
      if (!btn.classList.contains('has-back')) return;
      const open = btn.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    btn._opt = opt;
    box.appendChild(btn);
  });
  $('q-before').hidden = false;
  $('btn-dunno').hidden = false;
  $('btn-next').hidden = true;
  $('q-verdict').hidden = true;
  $('q-judge').hidden = true;
  $('v-cue').hidden = true;
  $('q-choices').classList.remove('answered');
  // before the answer: the shelf, with this question's card lifted out of
  // the box it is in; the answer will move it
  const here = st ? st.box : 0;
  paintShelf($('stage-shelf'), { current: q.id, currentLabel: q.item_name || '' });
  const lastBox = intervals().length - 1;
  $('q-where').textContent = !st ? `はじめて出る札。正解で${boxLabel(1)}の箱へ`
    : here >= lastBox ? `いま${boxLabel(here)}の箱。正解でここに残る`
      : `いま${boxLabel(here)}の箱。正解で${boxLabel(here + 1)}の箱へ`;
  $('q-page').classList.remove('answered');
  s.shownAt = Date.now();
}

/** What a choice really is, said under it once the answer is in. */
function backOf(q, opt) {
  if (opt.correct) return '';
  if (opt.why) return opt.why;
  if (!opt.item || opt.item === q.item) return '';
  if (q.kind === 'rev') {
    const owner = S.bank.items.find((x) => x.id === opt.item);
    const val = owner && owner.facets && owner.facets[q.facet] && owner.facets[q.facet].answer;
    return val ? `${q.facet_label}は「${val}」` : '';
  }
  return opt.item_name ? join(opt.item_name, 'のこと') : '';
}

function answer(opt, btn) {
  const s = S.session;
  const slot = s.queue[s.idx];
  const q = slot.q;
  if (s.answered) return;
  s.answered = true;
  const correct = !!(opt && opt.correct);
  const ms = Date.now() - s.shownAt;
  const before = S.qstate.get(q.id);
  const fromBox = before ? before.box : 0;
  const st = record(q, opt ? opt.text : null, correct, !opt, ms);
  s.answers[s.idx] = { q, correct, dunno: !opt, due: st.due, box: st.box, chosen: opt, why: opt && !correct ? backOf(q, opt) : '' };

  // A miss comes back before the sitting ends, once, a few questions on.
  let reasked = false;
  if (!correct && !slot.again && s.reasked < REASK_MAX) {
    const at = Math.min(s.queue.length, s.idx + 1 + REASK_GAP);
    s.queue.splice(at, 0, { q, again: true });
    s.reasked += 1;
    reasked = true;
  }

  // The area above the choices keeps its height, so the choices stay under
  // the finger; the question rises to the top of it and the explanation opens
  // below. A long question leaves too little room, and then the explanation
  // goes under the choices instead.
  const area = $('q-area');
  const head = $('q-head');
  const headTop0 = head.getBoundingClientRect().top;
  const roomH = area.getBoundingClientRect().height;
  const spill = roomH < 200;
  area.style.height = spill ? '' : `${roomH}px`;
  area.classList.add('answered');
  area.classList.toggle('spill', spill);
  if (spill) $('q-page').appendChild($('q-verdict'));
  const choicesBox = $('q-choices');
  choicesBox.classList.add('answered');

  const buttons = Array.from($('q-choices').children);
  buttons.forEach((el, i) => {
    const o = el._opt;
    const back = backOf(q, o);
    el.querySelector('.choice-back-in').textContent = el === btn ? '' : back;
    el.classList.toggle('has-back', !!back && el !== btn);
    el.classList.remove('open');
    el.style.setProperty('--i', i);
    if (o.correct) {
      el.dataset.state = 'correct';
      el.appendChild(svgUse('maru', 'mark mark-maru'));
    } else if (el === btn) {
      el.dataset.state = 'wrong';
      el.appendChild(svgUse('batsu', 'mark mark-batsu'));
    } else {
      el.dataset.state = 'other';
    }
    el.removeAttribute('aria-disabled');
    if (back && el !== btn) el.setAttribute('aria-expanded', 'false');
    else el.removeAttribute('aria-expanded');
    // what a screen reader says for each choice once it is marked
    const said = o.correct ? '正解' : el === btn ? '選んだ答え' : '';
    el.setAttribute('aria-label', [said, o.text, back].filter(Boolean).join('。'));
  });
  $('btn-dunno').hidden = true;
  $('q-page').classList.add('answered');

  const v = $('q-verdict');
  $('q-judge').dataset.tone = correct ? 'ok' : 'ng';
  $('v-head').textContent = correct ? '正解' : opt ? '不正解' : '答えは丸の選択肢';
  const vm = $('v-mark');
  vm.innerHTML = '';
  vm.appendChild(svgUse(correct ? 'maru' : 'batsu', 'judge-pen'));
  $('v-said').textContent = correct ? '' : `正解は${q.answer}。`;
  // one line under the mark: where the card went, or when it comes back
  // a long name would break the line; then the card is just this card
  const say = (name) => (reasked ? 'この回でもう一度出る'
    : !correct ? `${name}は${whenAgain(readyAt(st))}もう一度`
      : `${name}は${boxLabel(st.box)}の箱へ`);
  const named = say(q.item_name || 'この札');
  phrase($('v-next'), named.length <= 12 ? named : say('この札'));
  // why the picked wrong choice is wrong, first, in the explanation
  const chosenWhy = opt && !correct ? backOf(q, opt) : '';
  const cw = $('v-chosen');
  cw.hidden = !chosenWhy;
  cw.textContent = '';
  if (chosenWhy) {
    cw.append(h('span', { class: 'v-chosen-label', text: `選んだ「${opt.text}」` }), h('span', { text: chosenWhy }));
  }
  $('v-text').textContent = q.explain || '';
  const aside = $('v-aside');
  const showHitokoto = q.hitokoto && q.facet === (S.bank.core_facet || '');
  phrase(aside, showHitokoto ? q.hitokoto : '');
  aside.hidden = !showHitokoto;
  paintSources(q);
  v.hidden = false;
  $('q-judge').hidden = false;
  paintTrail($('q-trail'), q, fromBox, st.box);
  if (!spill) {
    // On a short screen the sources, then the one-line rule, go under the
    // choices first, so the explanation itself stays above them.
    const over = () => area.scrollHeight > area.clientHeight + 4;
    for (const id of ['v-src', 'v-aside']) {
      if (!over()) break;
      $('v-more').prepend($(id));
      $('v-more').hidden = false;
    }
    // An explanation that still does not fit goes below the choices whole,
    // and the page follows it down; nothing is left to scroll in a small box.
    if (over()) {
      $('q-verdict').append($('v-aside'), $('v-src'));
      $('v-more').hidden = true;
      // the verdict line stays under the question; the rest goes below
      $('q-page').appendChild($('q-verdict'));
      $('v-cue').hidden = false;
    }
  }
  paintTicks();

  // the label over the question names what was asked; it stays when it fits
  if (!spill && $('v-more').hidden && $('v-cue').hidden) {
    area.classList.add('keep-kicker');
    if (area.scrollHeight > area.clientHeight + 4) area.classList.remove('keep-kicker');
  }
  // the question comes down to sit over its verdict; the space gathers above
  const dyh = headTop0 - head.getBoundingClientRect().top;
  if (Math.abs(dyh) > 1 && !reduceMotion()) {
    head.animate([{ transform: `translateY(${dyh}px)` }, { transform: 'none' }],
      { duration: 220, easing: 'cubic-bezier(0.22, 0.75, 0.2, 1)' });
  }

  $('btn-next').textContent = s.idx + 1 >= s.queue.length ? '結果を見る' : '次の問題';
  $('q-before').hidden = true;
  $('btn-next').hidden = false;
  $('btn-next').focus({ preventScroll: true });
  if (spill) revealVerdict();
}



/** The explanation opens under the choices. The view follows it down far
 *  enough to show it, but never so far that the marked choices leave the top. */
function revealVerdict() {
  requestAnimationFrame(() => {
    const v = $('q-verdict');
    const box = $('q-choices');
    const dockTop = window.innerHeight - ($('q-dock').getBoundingClientRect().height || 0);
    const overshoot = v.getBoundingClientRect().bottom - dockTop + 16;
    const room = box.getBoundingClientRect().top - 72;
    const by = Math.min(overshoot, room);
    if (by > 8) window.scrollBy({ top: by, behavior: reduceMotion() ? 'auto' : 'smooth' });
  });
}

/** The shelf in small, under the question once it is answered: the card
 *  with its name on it slides from the box it was in to the box it is in
 *  now. Right on a right answer, left on a wrong one, so every answer shows
 *  the review rule at work. */
function paintTrail(host, q, from, to) {
  host.innerHTML = '';
  const n = intervals().length;
  const row = h('div', { class: 'trail-boxes' });
  row.style.gridTemplateColumns = `repeat(${n}, minmax(0, 1fr))`;
  for (let i = 0; i < n; i++) {
    row.appendChild(h('span', { class: 'trail-slot' + (i === to ? ' to' : '') },
      h('span', { class: 'trail-tray' }),
      h('span', { class: 'trail-label', text: boxLabel(i) })));
  }
  const card = h('i', { class: 'trail-card' });
  host.style.setProperty('--n', n);
  host.append(card, row);
  host.setAttribute('aria-label', `${q.item_name || 'この問題'}の札は${boxLabel(to)}の箱へ`);
  const boxes = row.children;
  const mid = (el) => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; };
  const left = host.getBoundingClientRect().left;
  card.style.left = `${mid(boxes[to]) - left}px`;
  const dx = mid(boxes[from]) - mid(boxes[to]);
  if (reduceMotion()) return;
  const rest = 'translateX(-50%) rotate(-5deg)';
  let easing = getComputedStyle(document.documentElement).getPropertyValue('--spring').trim() || 'ease-out';
  const frames = dx
    ? [{ transform: `translateX(${dx}px) translateX(-50%) rotate(0deg)` }, { transform: rest }]
    : [{ transform: 'translateX(-50%) translateY(-8px) rotate(0deg)' }, { transform: rest }];
  try {
    card.animate(frames, { duration: 760, delay: 180, easing, fill: 'backwards' });
  } catch (e) {
    easing = 'cubic-bezier(0.22, 0.75, 0.2, 1)';
    card.animate(frames, { duration: 600, delay: 180, easing, fill: 'backwards' });
  }
}

/** The shelf in small, in the bar under the answer: the card hops from the
 *  box it was in to the box it is in now. Up on a right answer, down on a
 *  wrong one, so every answer shows the review rule at work. */
function paintMini(host, from, to) {
  host.innerHTML = '';
  const n = intervals().length;
  const step = 18;   // box width plus gap, in px (14 + 4)
  for (let i = 0; i < n; i++) {
    const box = h('span', { class: 'mini-box' + (i === to ? ' to' : '') });
    if (i === to) {
      const card = h('span', { class: 'mini-card' });
      card.style.setProperty('--from', `${(from - to) * step}px`);
      box.appendChild(card);
    }
    host.appendChild(box);
  }
  host.setAttribute('aria-label', `${boxLabel(from)}の箱から${boxLabel(to)}の箱へ`);
}

function paintSources(q) {
  const src = $('v-src');
  src.innerHTML = '';
  // one link per site; the first page cited from each
  const seen = new Map();
  for (const u of q.sources || []) {
    if (typeof u !== 'string' || !/^https?:/.test(u)) continue;
    let host = u;
    try { host = new URL(u).hostname.replace(/^www\./, ''); } catch (e) { /* keep */ }
    if (!seen.has(host)) seen.set(host, u);
  }
  if (!seen.size) {
    src.hidden = true;
    return;
  }
  src.appendChild(h('span', { class: 'src-label', text: '出典' }));
  for (const [host, u] of [...seen].slice(0, 3)) {
    src.appendChild(h('a', { href: u, target: '_blank', rel: 'noopener', text: host }));
  }
  src.hidden = false;
}

function next() {
  const s = S.session;
  if (!s.answered) return;
  s.idx += 1;
  if (s.idx >= s.queue.length) return finish();
  const swap = () => {
    paintQuestion();
    window.scrollTo(0, 0);
  };
  if (document.startViewTransition && !reduceMotion()) {
    document.documentElement.dataset.dir = 'next';
    document.startViewTransition(swap);
  } else {
    swap();
  }
}

/* ---------- result ---------- */

function finish() {
  const s = S.session;
  const first = s.answers.filter((a, i) => a && !s.queue[i].again);
  const right = first.filter((a) => a.correct).length;
  const score = $('r-score');
  score.innerHTML = '';
  score.append(
    h('span', { class: 'score-num', text: String(right) }),
    h('span', { class: 'score-of', text: `/${first.length}` }),
    h('span', { class: 'score-label', text: '問を1回で正解' }));
  const mins = Math.max(1, Math.round((Date.now() - s.startedAt) / 60000));
  // when this sitting's cards come back, all of them, earliest first
  const backs = new Map();
  const ats = [...new Set(s.answers.filter(Boolean).map((a) => a.q.id))]
    .map((id) => readyAt(S.qstate.get(id))).filter((d) => d !== null && d !== undefined).sort((x, y) => x - y);
  for (const at of ats) {
    const w = fromNow(at);
    backs.set(w, (backs.get(w) || 0) + 1);
  }
  const parts = [...backs].slice(0, 2).map(([w, n]) => `${w}に${n}問`);
  $('r-note').textContent = parts.length
    ? `${mins}分で解きました。次は${parts.join('と')}が出ます。`
    : `${mins}分で解きました。`;

  // the shelf again, with this sitting's cards dropping into their boxes
  const landed = new Set(s.answers.filter(Boolean).map((a) => a.q.id));
  paintShelf($('r-shelf-boxes'), { landed });
  $('r-shelf-cap').textContent = `今回の${landed.size}問が入った箱`;

  // the misses once more, question and answer, now that the sitting is over:
  // a second look at the end is the benefit of delayed feedback, kept
  const missedList = $('r-missed');
  missedList.innerHTML = '';
  const shownMiss = new Set();
  for (const a of first) {
    if (a.correct || shownMiss.has(a.q.id)) continue;
    shownMiss.add(a.q.id);
    missedList.appendChild(h('li', {},
      phrase(h('p', { class: 'm-q' }), a.q.prompt),
      h('p', { class: 'm-mine' }, h('span', { class: 'm-label', text: a.chosen ? '選んだ答え' : 'わからない' }),
        a.chosen ? h('span', { class: 'm-text', text: a.chosen.text }) : null),
      a.why ? phrase(h('p', { class: 'm-why' }), a.why) : null,
      h('p', { class: 'm-a' }, h('span', { class: 'm-label', text: '正しい答え' }), phrase(h('span', { class: 'm-text' }), a.q.answer))));
  }
  $('r-missed-wrap').hidden = !shownMiss.size;

  // when each card from this sitting comes back, soonest first; the latest
  // answer to a card decides it, so a missed card answered again counts once
  const last = new Map();
  s.answers.forEach((a) => { if (a) last.set(a.q.id, a); });
  const at = (a) => readyAt(S.qstate.get(a.q.id)) || 0;
  const groups = new Map();
  for (const a of [...last.values()].sort((x, y) => at(x) - at(y))) {
    const label = fromNow(at(a));
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(a);
  }
  const dl = $('r-schedule');
  dl.innerHTML = '';
  for (const [label, arr] of groups) {
    const names = [...new Set(arr.map((a) => {
      const full = S.bank.items.find((x) => x.id === a.q.item);
      return (full && full.short_name) || a.q.item_name;
    }))];
    const shown = names.slice(0, 5);
    dl.appendChild(h('div', { class: 'schedule-row' },
      h('dt', { text: label === 'あす' ? 'あす' : label }),
      h('dd', {}, h('b', { text: `${arr.length}問` }),
        ...shown.map((n) => h('span', { class: 'name', text: n })),
        names.length > shown.length ? h('span', { class: 'name more', text: `ほか${names.length - shown.length}件` }) : null)));
  }

  // While today still has questions, the next sitting is the main button and
  // the score steps back; going home is the link. A finished day ends here.
  const more = buildQueue().list.length;
  const c = counts();
  const left = c.due + Math.min(c.fresh, Math.max(0, NEW_PER_DAY - newToday()));
  S.resultGoesOn = more > 0;
  $('screen-result').classList.toggle('goes-on', more > 0);
  $('btn-home').textContent = more ? `続けて${Math.min(more, SESSION_LEN)}問を解く` : 'ホームに戻る';
  $('btn-again').hidden = !more;
  $('btn-again').textContent = 'ホームに戻る';
  if (more) $('r-note').textContent = `${mins}分で解きました。今日はあと${left}問あります。`;
  $('r-kicker').textContent = `今回の${first.length}問`;
  show('result');
  paintSyncNote();
  pushEvents();
}

/* ---------- primer ---------- */

function paintPrimer() {
  const b = S.bank;
  const host = $('primer-body');
  host.innerHTML = '';
  host.appendChild(h('h1', { class: 'title', id: 'primer-title', text: b.short_title || b.title }));
  for (const block of b.primer || []) {
    if (typeof block === 'string') {
      host.appendChild(h('p', { text: block }));
    } else if (block.h) {
      host.appendChild(h('h2', { class: 'section-title', text: block.h }));
    } else if (block.p) {
      host.appendChild(h('p', { text: block.p }));
    } else if (block.pair) {
      // two families side by side, and the rule that joins them
      const col = (side) => h('div', { class: 'pair-col' },
        h('p', { class: 'pair-head', text: side.title }),
        side.note ? phrase(h('p', { class: 'pair-note' }), side.note) : null,
        h('ul', {}, side.items.map((x) => {
          const [name, level, note] = Array.isArray(x) ? x : [x, 0, ''];
          return h('li', {},
            level ? h('span', { class: 'amount', role: 'img', 'aria-label': `量は3段階の${level}` },
              ...Array.from({ length: 3 }, (_, i) => h('i', { class: i < level ? 'on' : '' }))) : null,
            h('span', { class: 'pair-name', text: name }),
            note ? phrase(h('span', { class: 'pair-tag' }), note) : null);
        })));
      host.appendChild(h('figure', { class: 'pair' },
        block.pair.legend ? h('p', { class: 'pair-legend', text: block.pair.legend }) : null,
        h('div', { class: 'pair-cols' }, col(block.pair.left), h('span', { class: 'pair-x', 'aria-hidden': 'true', text: '×' }), col(block.pair.right)),
        block.pair.caption ? h('figcaption', { text: block.pair.caption }) : null,
        block.pair.key ? h('p', { class: 'pair-key', text: block.pair.key }) : null));
    } else if (block.rows) {
      host.appendChild(h('dl', { class: 'rows' }, block.rows.map(([k, v]) =>
        h('div', { class: 'rows-row' }, h('dt', { text: k }), phrase(h('dd'), v)))));
    }
  }
}

/* ---------- browse ---------- */

function filterBrowse() {
  const q = $('browse-q').value.trim();
  for (const li of $('browse-list').querySelectorAll('.entries > li')) {
    li.hidden = !!q && !li.textContent.includes(q);
  }
  for (const g of $('browse-list').querySelectorAll('.section-title, .group-title')) g.hidden = !!q;
}

function paintBrowse() {
  const b = S.bank;
  $('browse-q').value = '';
  $('browse-key').textContent = `点1つが1問。塗った点は${boxLabel(READY_FROM)}以上の箱にある問題。`;
  const label = b.item_label || '項目';
  $('browse-title').textContent = `${label}の一覧`;
  const order = Object.keys(b.type_labels || {});
  const host = $('browse-list');
  host.innerHTML = '';
  for (const t of order) {
    const items = b.items.filter((x) => x.type === t);
    if (!items.length) continue;
    host.appendChild(h('h2', { class: 'section-title browse-type', text: b.type_labels[t] }));
    const known = b.category_order || [];
    const cats = [...new Set(items.map((x) => x.category))]
      .sort((x, y) => (known.indexOf(x) + 1 || 999) - (known.indexOf(y) + 1 || 999));
    const grouped = cats.length > 1 && cats.length < items.length;
    let ul = null;
    let lastCat = null;
    for (const it of items.slice().sort((x, y) => cats.indexOf(x.category) - cats.indexOf(y.category))) {
      if (!ul || (grouped && it.category !== lastCat)) {
        if (grouped) host.appendChild(h('h3', { class: 'group-title', text: it.category }));
        ul = h('ul', { class: 'entries' });
        host.appendChild(ul);
        lastCat = it.category;
      }
      const qs = b.questions.filter((q) => q.item === it.id);
      const dots = h('span', { class: 'dots', 'aria-hidden': 'true' }, qs.map((q) => {
        const st = S.qstate.get(q.id);
        return h('i', { class: Schedule.known(st) ? 'on' : st ? 'seen' : '' });
      }));
      const done = qs.filter((q) => Schedule.known(S.qstate.get(q.id))).length;
      const townName = it.town ? (b.items.find((x) => x.id === it.town) || {}).name : '';
      const meta = [townName, it.kind].filter(Boolean).join('・');
      const facets = Object.entries(it.facets || {}).filter(([, fx]) => fx && fx.answer);
      const body = h('div', { class: 'entry-body' },
        h('dl', { class: 'rows' }, facets.map(([key, fx]) =>
          h('div', { class: 'rows-row' }, h('dt', { text: fx.label || key }), h('dd', { text: fx.text || fx.answer })))),
        it.hitokoto ? phrase(h('p', { class: 'entry-note' }), it.hitokoto) : null,
        it.links && it.links.length ? h('p', { class: 'entry-links' }, it.links.map((l) =>
          h('a', { href: l.url, target: '_blank', rel: 'noopener', text: l.title }))) : null);
      const details = h('details', { class: 'entry' },
        h('summary', {},
          h('span', { class: 'entry-name', text: it.short_name || it.name }),
          meta ? h('span', { class: 'entry-meta', text: meta }) : null,
          h('span', { class: 'entry-score' }, dots, h('span', { class: 'sr', text: `${qs.length}問のうち${done}問をおぼえた` }))),
        body);
      ul.appendChild(h('li', {}, details));
    }
  }
}

/* ---------- boot ---------- */

/** A link can carry the repository and the set so only the token has to be
 *  typed on a phone. The token itself never goes in a URL. */
function prefillFromHash() {
  const hash = location.hash.replace(/^#/, '');
  if (!hash) return null;
  const p = new URLSearchParams(hash);
  const repo = p.get('repo');
  const domain = p.get('domain');
  if (!repo && !domain) return null;
  return { repo: repo || '', domain: domain || '', token: '' };
}

/* ---------- sets ---------- */

async function fetchSetIndex() {
  const res = await api('domains/index.json', {
    headers: { Accept: 'application/vnd.github.raw+json' },
  });
  if (!res.ok) throw new Error(await describe(res));
  const body = await res.json();
  return body.sets || [];
}

/** The set screen is printed on no set's paper. Leaving it puts the set back. */
function plainTheme() {
  const root = document.documentElement;
  for (const v of ['--t-paper', '--t-ink', '--t-mark', '--t-paper-d', '--t-ink-d', '--t-mark-d']) root.style.removeProperty(v);
}

async function paintSets() {
  plainTheme();
  const host = $('sets-list');
  const msg = $('sets-msg');
  host.innerHTML = '';
  msg.textContent = '読み込んでいます。';
  msg.dataset.tone = '';
  let sets;
  try {
    sets = await fetchSetIndex();
    writeLS(LS.sets, sets);
  } catch (e) {
    sets = readLS(LS.sets, []) || [];
    if (!sets.length) {
      msg.textContent = e.message || String(e);
      msg.dataset.tone = 'bad';
      return;
    }
  }
  msg.textContent = '';
  for (const set of sets) {
    const current = set.id === S.cfg.domain;
    const btn = h('button', { type: 'button', class: 'set', 'aria-current': current ? 'true' : null },
      h('span', { class: 'set-mark', 'aria-hidden': 'true', text: set.emblem || set.title.slice(0, 1) }),
      h('span', { class: 'set-body' },
        phrase(h('span', { class: 'set-title' }), set.title),
        phrase(h('span', { class: 'set-goal' }), set.goal),
        h('span', { class: 'set-meta', text: current ? `${set.questions}問 いま学習中` : `${set.questions}問` })));
    const t = set.theme || {};
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const paper = dark ? t.paper_dark : t.paper;
    const ink = dark ? t.ink_dark : t.ink;
    const mark = btn.querySelector('.set-mark');
    if (paper) mark.style.setProperty('--s-paper', paper);
    if (ink) mark.style.setProperty('--s-ink', ink);
    btn.addEventListener('click', () => switchSet(set.id));
    host.appendChild(h('li', {}, btn));
  }
}

/** Answers belong to the set they were given in. An unsent answer is sent
 *  before the switch; if it cannot be, the switch waits, so no answer is left
 *  behind or written into the wrong set's file. */
async function switchSet(id) {
  if (id === S.cfg.domain) {
    paintHome();
    show('home', { back: true });
    return;
  }
  const msg = $('sets-msg');
  if (S.dirty && !S.syncing) await pushEvents();
  if (S.syncing || S.dirty) {
    msg.textContent = '前の学習セットの記録をまだ送れていません。つながってからもう一度選んでください。';
    msg.dataset.tone = 'bad';
    return;
  }
  msg.textContent = '読み込んでいます。';
  msg.dataset.tone = '';
  S.cfg.domain = id;
  writeLS(LS.cfg, S.cfg);
  S.bank = null;
  S.events = [];
  S.remote = [];
  S.qstate = new Map();
  S.session = null;
  S.lastSyncError = '';
  await loadAndShow();
}

function paintSetup() {
  for (const el of document.querySelectorAll('[data-phrase]')) phrase(el, el.textContent);
  const cfg = S.cfg || prefillFromHash() || {};
  $('in-repo').value = cfg.repo || '';
  $('in-token').value = cfg.token || '';
  const pick = !cfg.domain;
  $('setup-next').hidden = !pick;
  $('btn-save-setup').textContent = pick ? '保存して学習セットを選ぶ' : '保存して読み込む';
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
    S.dirty = !!readLS(LS.dirty + S.cfg.domain, false);
    await pullRemoteEvents();
    rebuildState();
    paintHome();
    show('home');
    if (S.dirty) pushEvents();
  } catch (err) {
    if (!S.bank) {
      $('setup-msg').textContent = err.message || String(err);
      $('setup-msg').dataset.tone = 'bad';
      paintSetup();
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
    return;
  }
  await loadAndShow();
}

function goHome() {
  if (!S.bank) {
    // reached from the first setup, before any set is loaded
    paintSetup();
    show('setup', { back: true });
    return;
  }
  paintHome();
  show('home', { back: true });
}

function wire() {
  $('btn-save-setup').addEventListener('click', async () => {
    const prev = S.cfg || prefillFromHash() || {};
    const cfg = {
      repo: $('in-repo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, ''),
      token: $('in-token').value.trim(),
      domain: prev.domain || '',
    };
    if (!cfg.repo.includes('/') || !cfg.token) {
      $('setup-msg').textContent = 'リポジトリとトークンを入れてください。';
      $('setup-msg').dataset.tone = 'bad';
      return;
    }
    S.cfg = cfg;
    S.mode = 'remote';
    writeLS(LS.cfg, cfg);
    $('setup-msg').textContent = '読み込んでいます。';
    $('setup-msg').dataset.tone = '';
    if (!cfg.domain) {
      // no set named yet: show the list to pick from, which also proves the token
      try {
        await fetchSetIndex();
      } catch (err) {
        $('setup-msg').textContent = err.message || String(err);
        $('setup-msg').dataset.tone = 'bad';
        return;
      }
      $('setup-msg').textContent = '';
      $('sets-title').textContent = '最初の学習セット';
      show('sets');
      paintSets();
      return;
    }
    await loadAndShow();
  });

  $('btn-start').addEventListener('click', () => startSession());
  $('btn-more').addEventListener('click', () => startSession({ extra: true }));
  $('btn-next').addEventListener('click', next);
  $('btn-dunno').addEventListener('click', () => answer(null, null));
  $('btn-quit').addEventListener('click', goHome);
  $('btn-again').addEventListener('click', goHome);
  $('btn-home').addEventListener('click', () => {
    if (S.screen === 'result' && S.resultGoesOn && buildQueue().list.length) startSession();
    else goHome();
  });
  $('btn-primer').addEventListener('click', () => {
    paintPrimer();
    show('primer');
  });
  $('btn-primer-back').addEventListener('click', goHome);
  $('btn-browse').addEventListener('click', () => {
    paintBrowse();
    show('browse');
  });
  $('btn-browse-back').addEventListener('click', goHome);
  $('v-cue').addEventListener('click', () => {
    $('q-verdict').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'center' });
  });
  $('browse-q').addEventListener('input', filterBrowse);
  $('btn-sets').addEventListener('click', () => {
    $('sets-title').textContent = '学習セット';
    show('sets');
    paintSets();
  });
  $('btn-sets-back').addEventListener('click', () => {
    applyTheme();
    goHome();
  });
  $('btn-settings').addEventListener('click', () => {
    paintSetup();
    show('setup');
  });

  // Keys 1 to 4 answer, Enter goes on. For a laptop; the phone never sees it.
  document.addEventListener('keydown', (e) => {
    if (S.screen !== 'quiz' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    const s = S.session;
    if (!s) return;
    if (!s.answered && /^[1-9]$/.test(e.key)) {
      const btn = $('q-choices').querySelector(`[data-key="${e.key}"]`);
      if (btn) { e.preventDefault(); btn.click(); }
    } else if (s.answered && (e.key === 'Enter' || e.key === ' ')) {
      if (document.activeElement === $('btn-next')) return;
      e.preventDefault();
      next();
    }
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
