/* UI 冒烟测试：node tests/ui.test.js
 *
 * 验证 popup 与设置页的 DOM 结构、id 绑定、表单读写、校验与保存。
 * 这类测试最容易抓到「HTML 里叫 chips-prefer、JS 里拼成 chips_prefer」这种错。
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

/* 必须和 src 里的 todayStr() 一样用本地时间。用 toISOString() 会取到 UTC 日期，
   在 GMT+8 的 0:00~8:00 之间比本地日期早一天，测试会在半夜莫名失败。 */
const todayLocal = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

/* ---------------------------------------------------------------- chrome mock */

function makeChrome(stored, { tabUrl = 'https://www.zhipin.com/web/geek/jobs', contentReply = null } = {}) {
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
        query(q, cb) { cb([{ id: 1, url: tabUrl }]); },
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
  w.confirm = () => true;

  jsFiles.forEach((f) => w.eval(read(f)));
  return { dom, w, stored, calls: mock.calls };
}

/* ---------------------------------------------------------------- popup */

(async function run() {
  console.log('== popup ==');

  const popupStore = {
    config: {
      limits: { session_apply_max: 8, daily_apply_max: 30 },
      pacing: { delay_min_sec: 25, delay_max_sec: 70 }
    },
    profile: {},
    stats: { date: todayLocal(), applied: 6 }
  };
  const contentReply = { ok: true, running: false, cards: 12, hit: 3, applied: 0 };

  const p = loadPage('popup.html', ['core.js', 'popup.js'], popupStore, { contentReply });
  await sleep(120);
  const pw = p.w;

  eq('今日已投显示', pw.document.getElementById('s-today').textContent, '6');
  eq('推荐数显示', pw.document.getElementById('s-hit').textContent, '3');
  eq('额度文案', pw.document.getElementById('quota').textContent, '额度 6 / 30 · 单轮 8');
  ok('站点状态为已连接', pw.document.getElementById('site').textContent === '已连接',
    pw.document.getElementById('site').textContent);
  ok('状态栏有引导文案', pw.document.getElementById('status').textContent.length > 0,
    pw.document.getElementById('status').textContent);

  const bar = pw.document.getElementById('bar');
  eq('进度条宽度 20%', bar.style.width, '20%');

  // 点击扫描应转发消息
  pw.document.getElementById('btn-scan').click();
  await sleep(80);
  ok('扫描按钮转发 scan 消息', p.calls.sendMessage.some((m) => m.type === 'scan'),
    JSON.stringify(p.calls.sendMessage));

  /* 换一批：转发 refresh，并把「新增 N 个」留在状态栏 */
  const rfp = loadPage('popup.html', ['core.js', 'popup.js'], popupStore, {
    contentReply: (m) => (m.type === 'refresh'
      ? { ok: true, reloaded: false, added: 3, hit: 1, cards: 12, how: '下一页' }
      : contentReply)
  });
  await sleep(120);
  rfp.w.document.getElementById('btn-refresh').click();
  await sleep(120);
  ok('换一批转发 refresh 消息', rfp.calls.sendMessage.some((m) => m.type === 'refresh'),
    JSON.stringify(rfp.calls.sendMessage));
  ok('换一批回报新增数与推荐数',
    rfp.w.document.getElementById('status').textContent.indexOf('新增 3 个') >= 0,
    rfp.w.document.getElementById('status').textContent);

  /* 扫描报告：popup 取回文本并展开 */
  console.log('== popup：扫描报告 ==');
  const REPORT = '# boss-scout 扫描报告\n时间 2026-10-29 23:40:00\n' +
    '卡片 2｜推荐 1｜待看 0｜跳过 1\n\n## 推荐 (1)\n1.  70 推荐  EMC 测试工程师 | 杭州 | 15-25K\n';
  const hasReport = (m) => (m.type === 'report'
    ? { ok: true, text: REPORT, total: 2, counts: { approve: 1, review: 0, reject: 1 } }
    : contentReply);

  const pr = loadPage('popup.html', ['core.js', 'popup.js'], popupStore, { contentReply: hasReport });
  await sleep(120);
  const prd = pr.w.document;
  prd.getElementById('btn-report').click();
  await sleep(90);

  ok('请求了 report 消息', pr.calls.sendMessage.some((m) => m.type === 'report'),
    JSON.stringify(pr.calls.sendMessage));
  eq('报告面板展开', prd.getElementById('rep').hidden, false);
  ok('报告文本写入', prd.getElementById('rep-text').value.indexOf('EMC 测试工程师') > 0,
    prd.getElementById('rep-text').value);
  prd.getElementById('rep-x').click();
  eq('收起后隐藏', prd.getElementById('rep').hidden, true);

  const pe = loadPage('popup.html', ['core.js', 'popup.js'], popupStore, {
    contentReply: (m) => (m.type === 'report' ? { ok: true, text: '', total: 0 } : contentReply)
  });
  await sleep(120);
  pe.w.document.getElementById('btn-report').click();
  await sleep(90);
  eq('无结果时也展开（报告带诊断）', pe.w.document.getElementById('rep').hidden, false);
  ok('无结果时提示看诊断', pe.w.document.getElementById('status').textContent.indexOf('报告') >= 0,
    pe.w.document.getElementById('status').textContent);

  /* 页面诊断：把 DOM 结构原样导到同一个文本框里，标题要换成「页面诊断」 */
  console.log('== popup：页面诊断 ==');
  const PROBE = '# boss-scout 页面诊断\nurl https://www.zhipin.com/web/geek/jobs\n## 卡片选择器命中\n  .job-card-wrap → 15\n';
  const pd = loadPage('popup.html', ['core.js', 'popup.js'], popupStore, {
    contentReply: (m) => (m.type === 'probe' ? { ok: true, text: PROBE } : contentReply)
  });
  await sleep(120);
  const pdd = pd.w.document;
  ok('popup 有页面诊断入口', !!pdd.getElementById('btn-probe'));
  pdd.getElementById('btn-probe').click();
  await sleep(90);
  ok('请求了 probe 消息', pd.calls.sendMessage.some((m) => m.type === 'probe'),
    JSON.stringify(pd.calls.sendMessage));
  eq('诊断面板展开', pdd.getElementById('rep').hidden, false);
  eq('标题切换为页面诊断', pdd.getElementById('rep-title').textContent, '页面诊断');
  ok('诊断文本写入', pdd.getElementById('rep-text').value.indexOf('job-card-wrap') > 0,
    pdd.getElementById('rep-text').value);

  /* 未连接场景（非 BOSS 页面） */  console.log('== popup：非 BOSS 页面 ==');
  const p2 = loadPage('popup.html', ['core.js', 'popup.js'],
    { config: {}, profile: {}, stats: {} },
    { contentReply: null });
  await sleep(100);
  eq('未连接时站点文案', p2.w.document.getElementById('site').textContent, '未在 BOSS 页面');
  eq('未连接时扫描按钮禁用', p2.w.document.getElementById('btn-scan').disabled, true);

  /* 额度用满场景 */
  console.log('== popup：额度用满 ==');
  const fullStore = {
    config: { limits: { session_apply_max: 8, daily_apply_max: 30 }, pacing: {} },
    profile: {},
    stats: { date: todayLocal(), applied: 30 }
  };
  const p3 = loadPage('popup.html', ['core.js', 'popup.js'], fullStore, { contentReply });
  await sleep(100);
  ok('额度用满显示警告', p3.w.document.getElementById('warn').className.indexOf('show') >= 0,
    p3.w.document.getElementById('warn').className);
  eq('额度用满禁用开始按钮', p3.w.document.getElementById('btn-start').disabled, true);

  /* ---------------------------------------------------------------- options */

  console.log('== 设置页 ==');

  const optStore = {
    config: {
      limits: { session_apply_max: 8, daily_apply_max: 30, max_cards: 120, scroll_rounds: 8 },
      pacing: {
        delay_min_sec: 25, delay_max_sec: 70, jitter_ratio: 0.25, rest_every: 5,
        rest_min_sec: 120, rest_max_sec: 360, read_jd_min_sec: 3, read_jd_max_sec: 9
      },
      safety: { consecutive_failure_limit: 3, read_jd_before_approve: true, manual_confirm: false },
      scoring: { approve_threshold: 62, review_threshold: 42, reject_keywords: ['保险', '贷款'] },
      puaMap: '0123456789'
    },
    profile: {
      role_summary: '3 年 SaaS 产品运营',
      experience: '3 年',
      min_salary_k: 12,
      activity_max_idle_days: 14,
      target_cities: ['杭州', '上海'],
      prefer: ['产品运营', 'SaaS'],
      avoid: ['电销'],
      must_have: [],
      reject_keywords: [],
      greeting_template: ''
    },
    records: { 'id:a': { status: 'applied' }, 'id:b': { status: 'skipped' } }
  };

  const o = loadPage('options.html', ['core.js', 'options.js'], optStore, {});
  await sleep(140);
  const ow = o.w;
  const $ = (id) => ow.document.getElementById(id);

  eq('求职方向回填', $('p-role').value, '3 年 SaaS 产品运营');
  eq('目标城市回填', $('p-cities').value, '杭州, 上海');
  eq('薪资下限回填', String($('p-minsal').value), '12');
  eq('HR 活跃门槛回填', String($('p-idle').value), '14');
  eq('单轮上限回填', String($('l-session').value), '8');
  eq('每日上限回填', String($('l-daily').value), '30');
  eq('投递间隔下限回填', String($('pc-dmin').value), '25');
  eq('抖动量回填', String($('pc-jitter').value), '0.25');
  eq('推荐阈值回填', String($('s-approve').value), '62');
  eq('字体映射回填', $('adv-pua').value, '0123456789');
  eq('读 JD 复核开关回填', $('sf-readjd').checked, true);
  eq('逐条确认开关回填', $('sf-confirm').checked, false);
  /* 默认必须是「扩展代发」：老用户升级后不能突然一条都不发 */
  eq('招呼语交给 BOSS 默认关闭', $('sf-handoff').checked, false);

  ok('偏好词 chips 渲染', $('chips-prefer').querySelectorAll('i').length === 2,
    $('chips-prefer').innerHTML);
  ok('城市 chips 渲染', $('chips-cities').querySelectorAll('i').length === 2,
    $('chips-cities').innerHTML);
  eq('个人排除词空白时不应显示全局默认词', $('chips-rejectkw').querySelectorAll('i').length, 0);
  eq('通用排除词 chips 渲染到自己容器', $('chips-srejectkw').querySelectorAll('i').length, 2);
  ok('记录统计文案', $('records-info').textContent.indexOf('2 个岗位') >= 0,
    $('records-info').textContent);

  ok('初始状态为已保存', $('save-state').textContent === '已保存', $('save-state').textContent);

  /* 修改字段 → 脏标记 → 保存 */
  $('l-daily').value = '20';
  $('l-daily').dispatchEvent(new ow.Event('input', { bubbles: true }));
  eq('修改后标记未保存', $('save-state').textContent, '未保存');

  $('p-prefer').value = '产品运营, SaaS, 增长';
  $('p-prefer').dispatchEvent(new ow.Event('input', { bubbles: true }));
  eq('chips 随输入更新', $('chips-prefer').querySelectorAll('i').length, 3);

  $('p-idle').value = '7';
  $('p-idle').dispatchEvent(new ow.Event('input', { bubbles: true }));

  $('p-core').value = '产品运营, 用户运营';
  $('p-core').dispatchEvent(new ow.Event('input', { bubbles: true }));
  eq('标题核心词 chips 渲染', $('chips-core').querySelectorAll('i').length, 2);
  $('sf-autostart').checked = true;
  $('sf-autostart').dispatchEvent(new ow.Event('change', { bubbles: true }));
  $('sf-handoff').checked = true;
  $('sf-handoff').dispatchEvent(new ow.Event('change', { bubbles: true }));

  const before = o.calls.set.length;
  $('btn-save').click();
  await sleep(120);

  eq('保存写入了一次', o.calls.set.length, before + 1);
  eq('每日上限已更新', o.stored.config.limits.daily_apply_max, 20);
  eq('偏好词已更新', o.stored.profile.prefer.join(','), '产品运营,SaaS,增长');
  eq('标题核心词已写入', o.stored.profile.title_core.join(','), '产品运营,用户运营');
  eq('HR 活跃门槛已写入', o.stored.profile.activity_max_idle_days, 7);
  eq('自动扫描开关已写入', o.stored.config.safety.auto_start, true);
  eq('招呼语交给 BOSS 已写入', o.stored.config.safety.handoff_greeting, true);
  eq('未编辑字段保持不变', o.stored.config.pacing.delay_min_sec, 25);
  eq('保存后状态复位', $('save-state').textContent, '已保存');
  ok('保存后通知页面刷新', o.calls.sendMessage.some((m) => m.type === 'reload'),
    JSON.stringify(o.calls.sendMessage));

  /* 节奏档位：载入时按现有数值认档，点一下把八个参数一起改掉 */
  console.log('== 设置页：节奏档位 ==');
  eq('保守档按现有数值高亮', $('pace-btns').querySelector('button.on').dataset.pace, 'safe');
  ok('档位旁给出预估耗时', $('pace-eta').textContent.indexOf('跑满') === 0, $('pace-eta').textContent);

  $('pace-btns').querySelector('[data-pace="fast"]').click();
  eq('选快档改间隔下限', String($('pc-dmin').value), '5');
  eq('选快档改间隔上限', String($('pc-dmax').value), '12');
  eq('选快档改休息频率', String($('pc-every').value), '10');
  eq('快档被高亮', $('pace-btns').querySelector('button.on').dataset.pace, 'fast');
  eq('改档后标记未保存', $('save-state').textContent, '未保存');

  /* 非法值应被拦截 */
  console.log('== 设置页：校验 ==');
  $('pc-dmin').value = '100';
  $('pc-dmin').dispatchEvent(new ow.Event('input', { bubbles: true }));
  $('pc-dmax').value = '10';
  $('pc-dmax').dispatchEvent(new ow.Event('input', { bubbles: true }));

  const beforeBad = o.calls.set.length;
  $('btn-save').click();
  await sleep(80);

  eq('非法间隔不写入', o.calls.set.length, beforeBad);
  ok('给出校验提示', $('toast').textContent.indexOf('间隔') >= 0, $('toast').textContent);

  /* 恢复合法值再存 */
  $('pc-dmin').value = '30';
  $('pc-dmin').dispatchEvent(new ow.Event('input', { bubbles: true }));
  $('pc-dmax').value = '80';
  $('pc-dmax').dispatchEvent(new ow.Event('input', { bubbles: true }));
  $('btn-save').click();
  await sleep(100);
  eq('修正后可保存', o.stored.config.pacing.delay_min_sec, 30);

  /* 字体映射必须 10 位 */
  $('adv-pua').value = 'abc';
  $('adv-pua').dispatchEvent(new ow.Event('input', { bubbles: true }));
  const beforePua = o.calls.set.length;
  $('btn-save').click();
  await sleep(80);
  eq('非法字体映射不写入', o.calls.set.length, beforePua);
  ok('提示字体映射错误', $('toast').textContent.indexOf('10 位') >= 0, $('toast').textContent);

  /* 标题核心词为空：可以保存，但必须提醒（它决定标题级误判挡不挡得住） */
  $('adv-pua').value = '0123456789';
  $('adv-pua').dispatchEvent(new ow.Event('input', { bubbles: true }));
  $('p-core').value = '';
  $('p-core').dispatchEvent(new ow.Event('input', { bubbles: true }));
  $('btn-save').click();
  await sleep(120);
  ok('空标题核心词保存时提醒', $('toast').textContent.indexOf('标题核心词') >= 0, $('toast').textContent);
  eq('仍然保存成功', o.stored.profile.title_core.length, 0);

  /* ---------------------------------------------------------------- 结果 */

  console.log('');
  if (fail) {
    console.log(`✗ ${fail} 项失败 / 共 ${pass + fail} 项\n`);
    fails.forEach((f, i) => console.log(`${i + 1}. ${f}\n`));
    process.exit(1);
  } else {
    console.log(`✓ ${pass} 项全部通过`);
    process.exit(0);
  }
})();
