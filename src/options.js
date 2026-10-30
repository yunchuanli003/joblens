/* options：表单读写 + 校验，不参与页面操作 */
'use strict';

const C = window.BossCore;
const $ = (id) => document.getElementById(id);

/* 表单 → 存储路径映射。kind: text(默认) / num / list / bool */
const MAP = {
  'p-role': { src: 'profile', path: 'role_summary' },
  'p-exp': { src: 'profile', path: 'experience' },
  'p-minsal': { src: 'profile', path: 'min_salary_k', kind: 'num' },
  'p-greet': { src: 'profile', path: 'greeting_template' },
  'p-cities': { src: 'profile', path: 'target_cities', kind: 'list' },
  'p-prefer': { src: 'profile', path: 'prefer', kind: 'list' },
  'p-core': { src: 'profile', path: 'title_core', kind: 'list' },
  'p-avoid': { src: 'profile', path: 'avoid', kind: 'list' },
  'p-must': { src: 'profile', path: 'must_have', kind: 'list' },
  'p-rejectkw': { src: 'profile', path: 'reject_keywords', kind: 'list' },

  'l-session': { src: 'config', path: 'limits.session_apply_max', kind: 'num' },
  'l-daily': { src: 'config', path: 'limits.daily_apply_max', kind: 'num' },
  'l-max': { src: 'config', path: 'limits.max_cards', kind: 'num' },
  'l-scroll': { src: 'config', path: 'limits.scroll_rounds', kind: 'num' },

  'pc-dmin': { src: 'config', path: 'pacing.delay_min_sec', kind: 'num' },
  'pc-dmax': { src: 'config', path: 'pacing.delay_max_sec', kind: 'num' },
  'pc-jitter': { src: 'config', path: 'pacing.jitter_ratio', kind: 'num' },
  'pc-every': { src: 'config', path: 'pacing.rest_every', kind: 'num' },
  'pc-rmin': { src: 'config', path: 'pacing.rest_min_sec', kind: 'num' },
  'pc-rmax': { src: 'config', path: 'pacing.rest_max_sec', kind: 'num' },
  'pc-jdmin': { src: 'config', path: 'pacing.read_jd_min_sec', kind: 'num' },
  'pc-jdmax': { src: 'config', path: 'pacing.read_jd_max_sec', kind: 'num' },

  's-approve': { src: 'config', path: 'scoring.approve_threshold', kind: 'num' },
  's-review': { src: 'config', path: 'scoring.review_threshold', kind: 'num' },
  's-rejectkw': { src: 'config', path: 'scoring.reject_keywords', kind: 'list' },

  'sf-breaker': { src: 'config', path: 'safety.consecutive_failure_limit', kind: 'num' },
  'sf-readjd': { src: 'config', path: 'safety.read_jd_before_approve', kind: 'bool' },
  'sf-confirm': { src: 'config', path: 'safety.manual_confirm', kind: 'bool' },
  'sf-autostart': { src: 'config', path: 'safety.auto_start', kind: 'bool' },
  'sf-handoff': { src: 'config', path: 'safety.handoff_greeting', kind: 'bool' },

  'adv-pua': { src: 'config', path: 'puaMap' }
};

const LIST_IDS = Object.keys(MAP).filter((id) => MAP[id].kind === 'list');

/* 输入框 → chips 容器 id 的显式映射。
   不要用字符串拼接推导：'s-rejectkw' 去掉前缀后同样是 'rejectkw'，
   会和 'p-rejectkw' 撞到同一个容器，导致全局默认词显示在个人字段下面。 */
const CHIP_TARGET = {
  'p-cities': 'chips-cities',
  'p-prefer': 'chips-prefer',
  'p-core': 'chips-core',
  'p-avoid': 'chips-avoid',
  'p-must': 'chips-must',
  'p-rejectkw': 'chips-rejectkw',
  's-rejectkw': 'chips-srejectkw'
};
const CHIP_STYLE = {
  'p-prefer': 'hot', 'p-cities': 'hot', 'p-core': 'hot',
  'p-avoid': 'bad', 'p-rejectkw': 'bad', 's-rejectkw': 'bad'
};

let LOADED = { config: null, profile: null };
let dirty = false;

/* ---------------------------------------------------------------- 路径存取 */

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, path, val) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = val;
}

/* ---------------------------------------------------------------- 列表解析 */

function parseList(s) {
  return String(s || '')
    .split(/[,，、;；\n\r]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function renderChips(inputId) {
  const holder = document.getElementById(CHIP_TARGET[inputId] || '');
  if (!holder) return;
  const items = parseList($(inputId).value);
  const cls = CHIP_STYLE[inputId] || '';
  holder.innerHTML = items
    .map((t) => `<i class="${cls}">${escapeHtml(t)}</i>`)
    .join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------------------------------------------------------- 表单填充 */

function fill() {
  Object.keys(MAP).forEach((id) => {
    const m = MAP[id];
    const el = $(id);
    if (!el) return;
    const v = getPath(m.src === 'config' ? LOADED.config : LOADED.profile, m.path);
    if (m.kind === 'bool') el.checked = !!v;
    else if (m.kind === 'list') el.value = (v || []).join(', ');
    else el.value = (v === undefined || v === null) ? '' : v;
  });
  LIST_IDS.forEach(renderChips);
}

function collect() {
  const out = { config: {}, profile: {} };
  Object.keys(MAP).forEach((id) => {
    const m = MAP[id];
    const el = $(id);
    if (!el) return;
    const dst = m.src === 'config' ? out.config : out.profile;
    let v;
    if (m.kind === 'bool') v = el.checked;
    else if (m.kind === 'list') v = parseList(el.value);
    else if (m.kind === 'num') {
      const n = Number(el.value);
      v = Number.isFinite(n) ? n : 0;
    } else v = String(el.value || '').trim();
    setPath(dst, m.path, v);
  });
  return out;
}

/* ---------------------------------------------------------------- 节奏档位 */

/* 三个档位只是同一组参数的三份预设。用户嫌慢就点一下，不用自己算八个数字。 */
const PACE_PRESETS = {
  fast: { dmin: 5, dmax: 12, jitter: 0.3, every: 10, rmin: 30, rmax: 60, jdmin: 1, jdmax: 3 },
  normal: { dmin: 12, dmax: 30, jitter: 0.25, every: 8, rmin: 60, rmax: 150, jdmin: 2, jdmax: 5 },
  safe: { dmin: 25, dmax: 70, jitter: 0.25, every: 5, rmin: 120, rmax: 360, jdmin: 3, jdmax: 9 }
};
const PACE_KEYS = {
  dmin: 'pc-dmin', dmax: 'pc-dmax', jitter: 'pc-jitter', every: 'pc-every',
  rmin: 'pc-rmin', rmax: 'pc-rmax', jdmin: 'pc-jdmin', jdmax: 'pc-jdmax'
};

function currentPace() {
  const v = {};
  Object.keys(PACE_KEYS).forEach((k) => { v[k] = Number($(PACE_KEYS[k]).value); });
  return v;
}

/* 改数字时高亮对得上的档位；改过之后谁都不匹配就只留 ETA，不硬凑一个档 */
function syncPace() {
  const cur = currentPace();
  let hit = '';
  Object.keys(PACE_PRESETS).forEach((n) => {
    const p = PACE_PRESETS[n];
    if (Object.keys(PACE_KEYS).every((k) => Math.abs(Number(p[k]) - cur[k]) < 1e-9)) hit = n;
  });
  document.querySelectorAll('#pace-btns button').forEach((b) => {
    b.classList.toggle('on', b.dataset.pace === hit);
  });

  const eta = $('pace-eta');
  if (!eta) return;
  const n = Math.max(1, Number($('l-session').value) || 8);
  const avg = (cur.dmin + cur.dmax) / 2;
  const rests = cur.every > 0 ? Math.max(0, Math.floor((n - 1) / cur.every)) : 0;
  const restAvg = (cur.rmin + cur.rmax) / 2;
  const sec = n * avg + rests * restAvg;
  const txt = sec < 90 ? Math.round(sec) + ' 秒' : (Math.round(sec / 6) / 10) + ' 分钟';
  eta.textContent = '跑满 ' + n + ' 份约 ' + txt;
}

function applyPace(name) {
  const p = PACE_PRESETS[name];
  if (!p) return;
  Object.keys(PACE_KEYS).forEach((k) => {
    const el = $(PACE_KEYS[k]);
    if (!el) return;
    el.value = p[k];
    el.dispatchEvent(new Event('input', { bubbles: true }));   // 走统一监听：标脏 + 重算 ETA
  });
  syncPace();
}

/* ---------------------------------------------------------------- 校验 */

function validate(cfg) {
  const e = [];
  const L = cfg.limits, P = cfg.pacing, S = cfg.scoring;
  if (L.session_apply_max < 1) e.push('单轮上限至少 1 份');
  if (L.session_apply_max > L.daily_apply_max) e.push('单轮上限不应大于每日上限');
  if (L.daily_apply_max > 60) e.push('每日上限超过 60 份风险很高，建议压到 30 以内');
  if (P.delay_min_sec > P.delay_max_sec) e.push('投递间隔下限不能大于上限');
  if (P.rest_min_sec > P.rest_max_sec) e.push('休息时长下限不能大于上限');
  if (P.read_jd_min_sec > P.read_jd_max_sec) e.push('读 JD 停留下限不能大于上限');
  if (S.review_threshold > S.approve_threshold) e.push('待看阈值不能大于推荐阈值');
  if (!/^\d{10}$/.test(String(cfg.puaMap || ''))) e.push('字体映射必须是 0-9 组成的 10 位数字');
  return e;
}

/* ---------------------------------------------------------------- 提示 */

let toastTimer = null;
function toast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function markDirty(on) {
  dirty = on;
  const s = $('save-state');
  s.className = 'state' + (on ? ' dirty' : ' saved');
  s.textContent = on ? '未保存' : '已保存';
}

/* ---------------------------------------------------------------- 保存 */

async function save() {
  const got = collect();
  const cfg = C.deepMerge(LOADED.config, got.config);
  const profile = C.deepMerge(LOADED.profile, got.profile);

  const errs = validate(cfg);
  if (errs.length) {
    toast('⚠ ' + errs.join('；'), 4200);
    return;
  }

  await new Promise((res) => chrome.storage.local.set({ config: cfg, profile }, res));
  LOADED = { config: cfg, profile };

  // 通知已打开的 BOSS 页面立即生效
  try {
    const tabs = await new Promise((res) => chrome.tabs.query({ url: 'https://www.zhipin.com/*' }, res));
    (tabs || []).forEach((t) => {
      if (t.id != null) chrome.tabs.sendMessage(t.id, { type: 'reload' }, () => void chrome.runtime.lastError);
    });
  } catch (e) { /* 无 BOSS 页面时忽略 */ }

  markDirty(false);
  /* 标题核心词是最容易被漏掉、又最影响判定的一项：空着的时候「口腔医助」
     这类岗位也会拿到 30 分。保存成功但提醒一句，别让人以为配好了。 */
  const cores = (profile.title_core || []).filter(Boolean);
  if (!cores.length) toast('已保存 · 标题核心词为空，标题级误判挡不住', 4600);
  else toast('已保存');
}

/* ---------------------------------------------------------------- 绑定 */

async function boot() {
  const v = await new Promise((res) => chrome.storage.local.get(['config', 'profile', 'records'], (x) => res(x || {})));
  LOADED.config = C.deepMerge(C.DEFAULTS, v.config || {});
  LOADED.profile = C.deepMerge(C.PROFILE_TEMPLATE, v.profile || {});
  fill();

  const n = Object.keys(v.records || {}).length;
  const applied = Object.values(v.records || {}).filter((r) => r && r.status === 'applied').length;
  $('records-info').textContent = n ? `已记录 ${n} 个岗位，其中 ${applied} 个已投递` : '暂无记录';

  syncPace();
}

Object.keys(MAP).forEach((id) => {
  const el = $(id);
  if (!el) return;
  const ev = (el.tagName === 'TEXTAREA' || el.type === 'text' || el.type === 'number') ? 'input' : 'change';
  el.addEventListener(ev, () => {
    markDirty(true);
    if (MAP[id].kind === 'list') renderChips(id);
    if (Object.values(PACE_KEYS).indexOf(id) >= 0 || id === 'l-session') syncPace();
  });
});

document.querySelectorAll('#pace-btns button').forEach((b) => {
  b.addEventListener('click', () => applyPace(b.dataset.pace));
});

$('btn-save').addEventListener('click', save);

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    save();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (!dirty) return;
  e.preventDefault();
  e.returnValue = '';
});

$('btn-reset').addEventListener('click', async () => {
  if (!confirm('确定清空所有投递记录和今日计数？此操作不可恢复。')) return;
  await new Promise((res) => chrome.storage.local.set({ records: {}, stats: { date: '', applied: 0 } }, res));
  $('records-info').textContent = '暂无记录';
  toast('已清空');
});

boot();
