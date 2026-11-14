/* content.js 流程测试：node tests/flow.test.js
 *
 * 在 jsdom 里加载 core + extract + content，mock chrome API，
 * 跑一遍「扫描 → 打分标注 → 报告」的链路。
 * 这是唯一能验证 content.js 内部流程的手段，不需要任何真实站点或账号。
 *
 * v2.0 起 content.js 只读：没有任何点击岗位、发消息的路径，
 * 所以这里不断言「点了什么」，只断言「扫到了什么、标了什么、报了什么」。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const fails = [];

function ok(name, cond, detail) {
  if (cond) pass++;
  else { fail++; fails.push(name + (detail ? '\n   ' + detail : '')); }
}
function eq(name, a, b) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A === B) pass++;
  else { fail++; fails.push(`${name}\n   期望 ${B}\n   实际 ${A}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pua = (s) => s.split('').map((d) => String.fromCharCode(0xE031 + Number(d))).join('');

const SRC = path.join(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

/* ---------------------------------------------------------------- 页面结构 */

function pageHtml() {
  return `<!DOCTYPE html><html><head><title>BOSS直聘</title></head><body>
  <div class="job-list-box"><ul>
    <li class="job-card-wrapper">
      <div class="job-card-wrap" id="card-good">
        <a href="/job_detail/good001.html">
          <span class="job-name">产品运营</span>
          <span class="job-salary">${pua('18')}-${pua('28')}K</span>
          <h3 class="company-name">甲科技有限公司</h3>
          <span class="job-area">杭州·西湖区</span>
          <ul class="tag-list"><li>SaaS</li><li>数据驱动</li></ul>
        </a>
      </div>
    </li>
    <li class="job-card-wrapper">
      <div class="job-card-wrap" id="card-bad">
        <a href="/job_detail/bad002.html">
          <span class="job-name">保险销售顾问</span>
          <span class="job-salary">${pua('10')}-${pua('20')}K</span>
          <h3 class="company-name">乙保险公司</h3>
          <span class="job-area">杭州·上城区</span>
        </a>
      </div>
    </li>
  </ul></div>
  <div class="job-detail-box" id="panel"><div class="job-sec-text">请从左侧选择一个岗位查看详情</div></div>
  </body></html>`;
}

const PROFILE = {
  role_summary: '产品运营',
  target_cities: ['杭州'],
  min_salary_k: 10,
  experience: '3 年',
  prefer: ['产品运营', 'SaaS', '数据驱动'],
  avoid: ['电销'],
  must_have: [],
  reject_keywords: [],
  activity_max_idle_days: 0
};

const CONFIG = {
  limits: { scroll_rounds: 1, max_cards: 20, panel_wait_ms: 2000 },
  safety: { auto_start: false },
  scoring: {
    approve_threshold: 62, review_threshold: 42,
    reject_keywords: ['保险', '贷款', '中介']
  },
  puaMap: '0123456789'
};

const DEFAULT_URL = 'https://www.zhipin.com/web/geek/jobs?query=%E4%BA%A7%E5%93%81%E8%BF%90%E8%90%A5';

function boot(opts) {
  opts = opts || {};
  const dom = new JSDOM(opts.html || pageHtml(), {
    url: opts.url || DEFAULT_URL,
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const w = dom.window;

  // jsdom 不做布局：给固定尺寸，并让 .hidden 元素尺寸为 0
  w.Element.prototype.getBoundingClientRect = function () {
    if (this.classList && this.classList.contains('hidden')) {
      return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 };
    }
    return { width: 340, height: 140, top: 20, left: 20, right: 360, bottom: 160, x: 20, y: 20 };
  };
  w.Element.prototype.scrollIntoView = function () { };
  w.scrollBy = () => { };
  w.scrollTo = () => { };

  /* chrome API mock：只保留 content.js 实际用到的部分 */
  const stored = Object.assign({ config: CONFIG, profile: PROFILE }, opts.stored || {});
  const handlers = [];
  let clicked = 0;

  w.chrome = {
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          const list = keys == null ? Object.keys(stored) : (Array.isArray(keys) ? keys : [keys]);
          list.forEach((k) => { if (stored[k] !== undefined) out[k] = JSON.parse(JSON.stringify(stored[k])); });
          cb(out);
        },
        set(obj, cb) {
          Object.keys(obj).forEach((k) => { stored[k] = JSON.parse(JSON.stringify(obj[k])); });
          if (cb) cb();
        },
        remove(keys, cb) {
          const list = Array.isArray(keys) ? keys : [keys];
          list.forEach((k) => { delete stored[k]; });
          if (cb) cb();
        }
      }
    },
    runtime: {
      onMessage: { addListener(fn) { handlers.push(fn); } },
      sendMessage() { },
      openOptionsPage() { }
    }
  };

  /* 任何卡片被点到都记一笔：用来证明扫描过程完全不碰页面 */
  w.document.querySelectorAll('.job-card-wrap').forEach((el) => {
    el.addEventListener('click', () => { clicked++; });
  });

  const code = [read('core.js'), read('extract.js'), read('content.js')].join('\n;\n');
  w.eval(code);

  return { dom, w, stored, handlers, clicked: () => clicked };
}

function send(handlers, msg) {
  return new Promise((resolve) => {
    let done = false;
    const reply = (r) => { if (!done) { done = true; resolve(r); } };
    handlers[0](msg, {}, reply);
    setTimeout(() => reply(null), 8000);
  });
}

/* ---------------------------------------------------------------- 用例 */

(async function run() {
  console.log('== content.js 只读链路 ==');

  const env = boot();
  const { w, handlers, clicked } = env;
  await sleep(150);   // 等 boot() 里的异步初始化完成

  ok('注入悬浮面板', !!w.document.getElementById('joblens-host'));

  const pong = await send(handlers, { type: 'ping' });
  ok('ping 有响应', pong && pong.ok, JSON.stringify(pong));
  eq('初始没有卡片', pong && pong.cards, 0);
  eq('ping 不再上报投递计数', pong && 'applied' in pong, false);

  /* ---- 扫描 ---- */
  const scanned = await send(handlers, { type: 'scan' });
  ok('扫描成功', scanned && scanned.ok, JSON.stringify(scanned));
  eq('扫描到 2 个岗位', scanned && scanned.cards, 2);
  eq('推荐 1 个', scanned && scanned.hit, 1);

  const badges = w.document.querySelectorAll('.bs-badge');
  eq('每张卡都有徽章', badges.length, 2);

  const goodBadge = w.document.querySelector('#card-good .bs-badge');
  const badBadge = w.document.querySelector('#card-bad .bs-badge');
  eq('高分卡标记为 approve', goodBadge && goodBadge.dataset.v, 'approve');
  eq('保险岗标记为 reject', badBadge && badBadge.dataset.v, 'reject');
  ok('徽章显示分数', /^\d+/.test(goodBadge.textContent), goodBadge.textContent);
  eq('扫描过程不点击任何岗位', clicked(), 0);

  /* ---- 面板统计 ---- */
  const shadow = w.document.getElementById('joblens-host').shadowRoot;
  eq('统计显示岗位数', shadow.getElementById('s-cards').textContent, '2');
  eq('统计显示推荐数', shadow.getElementById('s-hit').textContent, '1');
  eq('统计显示跳过数', shadow.getElementById('s-skip').textContent, '1');
  eq('面板没有开始投递按钮', shadow.getElementById('btn-start'), null);
  eq('面板没有停止按钮', shadow.getElementById('btn-stop'), null);

  /* ---- 扫描报告 ---- */
  const reportBox = shadow.getElementById('report');
  const reportText = () => shadow.getElementById('r-text').value;

  eq('报告初始隐藏', reportBox.hidden, true);
  shadow.getElementById('btn-report').click();
  await sleep(60);

  eq('点报告后打开', reportBox.hidden, false);
  const rt = reportText();
  ok('报告含标题与汇总', rt.indexOf('# joblens 扫描报告') === 0 && rt.indexOf('卡片 2｜推荐 1') > 0, rt);
  ok('报告含推荐岗位', rt.indexOf('## 推荐 (1)') > 0 && rt.indexOf('产品运营') > 0, rt);
  ok('报告含跳过岗位', rt.indexOf('## 跳过 (1)') > 0 && rt.indexOf('保险销售顾问') > 0, rt);
  ok('报告带判定理由', rt.indexOf('↳ ') > 0, rt);
  ok('报告不再含投递诊断', rt.indexOf('聊天页诊断') < 0 && rt.indexOf('点开卡片诊断') < 0, rt);

  /* ---- 消息白名单 ---- */
  const started = await send(handlers, { type: 'start' });
  eq('start 消息已无处理者', started, null);
  const stopped = await send(handlers, { type: 'stop' });
  eq('stop 消息已无处理者', stopped, null);

  /* ---- 配置变更后重打分 ---- */
  env.stored.config = Object.assign({}, CONFIG, {
    scoring: { approve_threshold: 95, review_threshold: 42, reject_keywords: ['保险'] }
  });
  await send(handlers, { type: 'reload' });
  await sleep(80);
  const after = await send(handlers, { type: 'ping' });
  ok('阈值抬到 95 后没有推荐', after && after.hit === 0, JSON.stringify(after));
  eq('卡片仍在', after && after.cards, 2);

  /* ---- 结果 ---- */
  console.log('');
  if (fail) {
    console.log('✗ ' + fail + ' 项失败：\n');
    fails.forEach((f) => console.log('  · ' + f));
    process.exit(1);   // content.js 里有 setInterval，不主动退出进程不会结束
  } else {
    console.log('✓ ' + pass + ' 项全部通过');
    process.exit(0);
  }
})();
