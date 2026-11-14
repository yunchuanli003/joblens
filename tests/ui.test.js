/* UI 冒烟测试：node tests/ui.test.js
 *
 * 验证 popup 与设置页的 DOM 结构、id 绑定、表单读写、校验与保存。
 * 这类测试最容易抓到「HTML 里叫 chips-prefer、JS 里拼成 chips_prefer」这种错。
 * v2.0 起两个页面都不再有任何「投递」入口，测试同时守住这一点。
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

const SRC = path.join(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- chrome mock */

function makeChrome(stored, { contentReply = null } = {}) {
  const calls = { set: [], sendMessage: [], openOptionsPage: 0 };
  return {
    calls,
    api: {
      storage: {
        local: {
          get(keys, cb) {
            const out = {};
            const list = keys == null ? Object.keys(stored) : (Array.isArray(keys) ? keys : [keys]);
            list.forEach((k) => { if (stored[k] !== undefined) out[k] = JSON.parse(JSON.stringify(stored[k])); });
            cb(out);
          },
          set(obj, cb) {
            calls.set.push(JSON.parse(JSON.stringify(obj)));
            Object.keys(obj).forEach((k) => { stored[k] = JSON.parse(JSON.stringify(obj[k])); });
            if (cb) cb();
          }
        }
      },
      tabs: {
        query(q, cb) { cb([{ id: 1, url: 'https://www.zhipin.com/web/geek/jobs' }]); },
        sendMessage(id, msg, cb) {
          calls.sendMessage.push(msg);
          if (cb) cb(typeof contentReply === 'function' ? contentReply(msg) : contentReply);
        },
        create() { }
      },
      runtime: {
        lastError: undefined,
        sendMessage() { },
        openOptionsPage() { calls.openOptionsPage++; }
      }
    }
  };
}

function loadPage(htmlFile, jsFiles, stored, opts) {
  const html = read(htmlFile).replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'https://example.com/', runScripts: 'outside-only' });
  const w = dom.window;
  const mock = makeChrome(stored, opts);
  w.chrome = mock.api;

  jsFiles.forEach((f) => w.eval(read(f)));
  return { dom, w, stored, calls: mock.calls };
}

/* ---------------------------------------------------------------- 用例 */

(async function run() {
  console.log('== popup ==');

  const popupStore = { config: {}, profile: {} };
  const contentReply = { ok: true, cards: 12, hit: 3, skip: 5 };

  const p = loadPage('popup.html', ['core.js', 'popup.js'], popupStore, { contentReply });
  await sleep(120);
  const pw = p.w;

  eq('已扫岗位显示', pw.document.getElementById('s-cards').textContent, '12');
  eq('推荐数显示', pw.document.getElementById('s-hit').textContent, '3');
  eq('跳过数显示', pw.document.getElementById('s-skip').textContent, '5');
  ok('站点状态为已连接',
    pw.document.getElementById('site').textContent === '已连接',
    pw.document.getElementById('site').textContent);
  eq('popup 没有开始投递按钮', pw.document.getElementById('btn-start'), null);
  eq('popup 没有停止按钮', pw.document.getElementById('btn-stop'), null);
  ok('页脚声明只读',
    pw.document.getElementById('quota').textContent.indexOf('只读') >= 0,
    pw.document.getElementById('quota').textContent);

  pw.document.getElementById('btn-scan').click();
  await sleep(120);
  ok('点扫描会向页面发 scan 消息', p.calls.sendMessage.some((m) => m.type === 'scan'),
    JSON.stringify(p.calls.sendMessage));

  console.log('== options ==');

  const optStore = {
    config: { limits: { max_cards: 120, scroll_rounds: 8 }, safety: { auto_start: false } },
    profile: { role_summary: '硬件测试工程师', title_core: ['EMC', '硬件测试'] }
  };
  const o = loadPage('options.html', ['core.js', 'options.js'], optStore, {});
  await sleep(120);
  const ow = o.w;

  eq('画像回填', ow.document.getElementById('p-role').value, '硬件测试工程师');
  eq('数值回填', String(ow.document.getElementById('l-max').value), '120');
  ok('列表字段渲染成 chips',
    ow.document.getElementById('chips-core').innerHTML.indexOf('EMC') > 0,
    ow.document.getElementById('chips-core').innerHTML);

  eq('已无招呼语字段', ow.document.getElementById('p-greet'), null);
  eq('已无单轮上限字段', ow.document.getElementById('l-session'), null);
  eq('已无投递间隔字段', ow.document.getElementById('pc-dmin'), null);
  eq('已无读 JD 复核开关', ow.document.getElementById('sf-readjd'), null);
  eq('已无清空记录按钮', ow.document.getElementById('btn-reset'), null);

  /* 改值 → 保存 → 落库 */
  ow.document.getElementById('l-max').value = '60';
  ow.document.getElementById('p-role').value = 'EMC 测试工程师';
  ow.document.getElementById('btn-save').click();
  await sleep(120);

  eq('保存写回扫描上限', o.stored.config.limits.max_cards, 60);
  eq('保存写回画像', o.stored.profile.role_summary, 'EMC 测试工程师');
  eq('保存后提示已保存', ow.document.getElementById('save-state').textContent, '已保存');

  /* 校验：待看阈值高于推荐阈值必须拦下，且不落库 */
  const before = JSON.stringify(o.stored.config);
  ow.document.getElementById('s-review').value = '90';
  ow.document.getElementById('s-approve').value = '50';
  ow.document.getElementById('btn-save').click();
  await sleep(120);
  ok('阈值倒置被拦下',
    ow.document.getElementById('toast').textContent.indexOf('待看阈值') >= 0,
    ow.document.getElementById('toast').textContent);
  eq('校验失败不写库', JSON.stringify(o.stored.config), before);

  /* ---- 结果 ---- */
  console.log('');
  if (fail) {
    console.log('✗ ' + fail + ' 项失败：\n');
    fails.forEach((f) => console.log('  · ' + f));
    process.exit(1);
  } else {
    console.log('✓ ' + pass + ' 项全部通过');
    process.exit(0);
  }
})();
