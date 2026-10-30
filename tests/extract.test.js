/* extract.js DOM 层测试：node tests/extract.test.js
 *
 * 用 jsdom 构造贴近 BOSS 列表页的结构，验证选择器回退、字体解密、可见性过滤、按钮查找与点击次数。
 */
'use strict';

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

/* ---------------------------------------------------------------- 环境搭建 */

function setup(html) {
  const dom = new JSDOM(html, { url: 'https://www.zhipin.com/web/geek/jobs?query=test' });
  const w = dom.window;

  // jsdom 不实现布局，getBoundingClientRect 恒为 0。这里给一个默认尺寸，
  // 带 .hidden 类的元素返回 0 尺寸，用来验证 isVisible 的过滤。
  w.Element.prototype.getBoundingClientRect = function () {
    if (this.classList && this.classList.contains('hidden')) {
      return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 };
    }
    return { width: 320, height: 130, top: 10, left: 10, right: 330, bottom: 140, x: 10, y: 10 };
  };
  w.Element.prototype.scrollIntoView = function () { };

  global.window = w;
  global.document = w.document;
  global.MouseEvent = w.MouseEvent;
  global.Event = w.Event;
  global.getComputedStyle = w.getComputedStyle.bind(w);
  global.location = w.location;
  global.DOMParser = w.DOMParser;

  // 每个用例重新 require，避免模块内缓存指向旧的 document
  delete require.cache[require.resolve('../src/core.js')];
  delete require.cache[require.resolve('../src/extract.js')];
  const C = require('../src/core.js');
  const E = require('../src/extract.js');

  return { dom, w, C, E };
}

const pua = (s) => s.split('').map((d) => String.fromCharCode(0xE031 + Number(d))).join('');

/* ---------------------------------------------------------------- 卡片抽取 */

console.log('== 卡片抽取 ==');

{
  const { E } = setup(`
    <div class="job-list-box">
      <ul>
        <li class="job-card-wrapper">
          <div class="job-card-wrap">
            <a href="/job_detail/abc123def.html?lid=x">
              <span class="job-name">产品运营</span>
              <span class="job-salary">${pua('12')}-${pua('24')}K·13薪</span>
              <div class="company-info"><h3 class="company-name">甲科技有限公司</h3></div>
              <span class="job-area">杭州·西湖区</span>
              <ul class="tag-list"><li>SaaS</li><li>B端</li><li>数据驱动</li></ul>
            </a>
          </div>
        </li>
      </ul>
    </div>
  `);

  const cards = E.collectCards(document, '0123456789');
  eq('包裹层不重复计算，只得到 1 张卡', cards.length, 1);

  const j = cards[0];
  eq('标题', j.title, '产品运营');
  eq('薪资解密', j.salary, '12-24K·13薪');
  eq('jobId 从 href 提取', j.id, 'abc123def');
  eq('公司名', j.company, '甲科技有限公司');
  eq('地区', j.area, '杭州·西湖区');
  eq('标签数', j.tags.length, 3);
  eq('薪资不可疑', j.salarySuspect, false);
  ok('保留 DOM 引用', j.el && j.el.className === 'job-card-wrap', String(j.el && j.el.className));
}

{
  // 只有 li.job-card-wrapper 的外层结构
  const { E } = setup(`
    <ul>
      <li class="job-card-wrapper">
        <a href="/job_detail/xyz789.html"><span class="job-name">用户运营</span></a>
      </li>
      <li class="job-card-wrapper">
        <a href="/job_detail/uvw456.html"><span class="job-name">增长运营</span></a>
      </li>
    </ul>
  `);
  const cards = E.collectCards(document, '0123456789');
  eq('回退到 li.job-card-wrapper', cards.length, 2);
  eq('第二张标题', cards[1].title, '增长运营');
  eq('第二张 jobId', cards[1].id, 'uvw456');
}

{
  // 不可见卡片应被过滤
  const { E } = setup(`
    <div class="job-card-wrap"><span class="job-name">可见岗位</span></div>
    <div class="job-card-wrap hidden"><span class="job-name">折叠岗位</span></div>
    <div class="job-card-wrap" style="display:none"><span class="job-name">隐藏岗位</span></div>
  `);
  const cards = E.collectCards(document, '0123456789');
  eq('过滤不可见卡片', cards.map((c) => c.title), ['可见岗位']);
}

{
  // 没有标题的空卡片应跳过
  const { E } = setup(`<div class="job-card-wrap"><span class="job-salary">10-20K</span></div>`);
  eq('无标题卡片跳过', E.collectCards(document, '0123456789').length, 0);
}

{
  // 错误映射导致薪资可疑
  const { E } = setup(`
    <div class="job-card-wrap">
      <a href="/job_detail/s1.html"><span class="job-name">测试岗</span></a>
      <span class="job-salary">${pua('12')}-${pua('34')}K</span>
    </div>
  `);
  const cards = E.collectCards(document, '1111111111');
  eq('错映射解密成 11-11K', cards[0].salary, '11-11K');
  eq('标记为可疑', cards[0].salarySuspect, true);
}

{
  const { E } = setup(`<div class="job-card-wrap"><a href="/job_detail/"><span class="job-name">空ID</span></a></div>`);
  eq('空 jobId 返回空串', E.readCard(document.querySelector('.job-card-wrap'), '0123456789').id, '');
}

console.log('== jobId 解析 ==');
{
  const { E } = setup('<div></div>');
  eq('带查询串', E.jobIdFromHref('/job_detail/abc.html?lid=1&x=2'), 'abc');
  eq('相对路径', E.jobIdFromHref('https://www.zhipin.com/job_detail/zz9.html'), 'zz9');
  eq('非详情链接', E.jobIdFromHref('/web/geek/jobs'), '');
  eq('空值', E.jobIdFromHref(null), '');
}

/* ---------------------------------------------------------------- 详情面板 */

console.log('== 详情面板 ==');
{
  const { E } = setup(`
    <div class="job-detail-box">
      <div class="job-sec-text">岗位职责：负责 B 端 SaaS 产品的日常运营，包含数据分析与用户增长策略制定。</div>
    </div>
  `);
  const p = E.readPanel();
  ok('读到面板', !!p);
  ok('面板文本含关键词', p && p.text.indexOf('SaaS') >= 0, p && p.text.slice(0, 40));
}

{
  const { E } = setup(`<div class="job-detail-box">太短</div>`);
  eq('过短面板视为未加载', E.readPanel(), null);
}

{
  const { E } = setup(`<div class="job-detail-box hidden">这是一段足够长的岗位描述内容用于测试可见性过滤逻辑</div>`);
  eq('不可见面板不读取', E.readPanel(), null);
}

/* 页面上带 job-detail 的元素常常有七八个：第一个可能是永不变化的壳。
   只认「第一个」的话，点开卡片永远判「面板没变化」——这是线上实际踩到的坑。 */
{
  const { E } = setup(`
    <div class="job-detail-wrap">左侧列表占位文案，始终不变的一段说明文字</div>
    <div class="job-detail-panel">
      <div class="job-sec-text">岗位职责：负责数据看板搭建与指标口径统一，3 年以上经验。</div>
    </div>
  `);
  const p = E.readPanel();
  ok('候选里第一个是壳时也能挑到真面板', p && p.text.indexOf('岗位职责') >= 0, p && p.text.slice(0, 40));
}

{
  const { E } = setup(`
    <div class="job-detail-outer">
      <div class="job-detail-side">相关推荐 更多职位 猜你喜欢</div>
      <div class="job-detail-box">
        <div class="job-sec-text">岗位职责：负责 B 端 SaaS 产品运营与用户增长。</div>
      </div>
    </div>
  `);
  const p = E.readPanel();
  ok('含 JD 的候选优先于纯文字壳', p && p.text.indexOf('SaaS') >= 0, p && p.text.slice(0, 40));
  ok('取最内层而不是整块外层', p && p.text.indexOf('相关推荐') < 0, p && p.text.slice(0, 60));
}

/* 详情页 HTML 解析：不点卡片、不等面板，直接拿 JD */
{
  const { E } = setup('<div></div>');
  const jd = E.jdFromHtml('<html><body><div class="job-sec-text">岗位职责：负责 B 端 SaaS 产品运营策略与数据分析，3 年以上经验。</div></body></html>');
  ok('从详情页 HTML 抽出 JD', jd.indexOf('SaaS') >= 0, jd);
  eq('过短的段落不当成 JD', E.jdFromHtml('<div class="job-sec-text">太短</div>'), '');
  eq('空 HTML 返回空', E.jdFromHtml(''), '');
}

/* HR 活跃度：卡片右侧那句「今日活跃 / 3日内活跃 / 本月活跃」
   卡片是最容易读到它的地方（详情页要发请求），所以扫描阶段就该用它筛一遍 */
{
  const { E } = setup(`
    <div class="job-card-wrap">
      <a href="/job_detail/act1.html"><span class="job-name">EMC 测试工程师</span></a>
      <span class="job-area">宁波</span>
      <div class="job-card-right"><span class="boss-name">王女士</span><span class="boss-active">3日内活跃</span></div>
    </div>
    <div class="job-card-wrap">
      <a href="/job_detail/act2.html"><span class="job-name">电源测试工程师</span></a>
      <div class="job-card-right"><span class="boss-active">半年前活跃</span></div>
    </div>
    <div class="job-card-wrap">
      <a href="/job_detail/act3.html"><span class="job-name">硬件测试工程师</span></a>
      <div class="job-note">负责社群活跃度运营</div>
    </div>
  `);
  const cards = E.collectCards(document, '0123456789');
  eq('卡片读出活跃档位', cards[0].activity, '3日内活跃');
  eq('久未活跃的档位也照样读出来', cards[1].activity, '半年前活跃');
  eq('跟 HR 无关的「活跃」不误判', cards[2].activity, '');
}

/* 详情页 HTML 里也有活跃度：卡片上只写「近期活跃」时，这里是唯一的第二来源 */
{
  const { E } = setup('<div></div>');
  const p = E.parseJdHtml('<html><body>' +
    '<div class="job-boss-info">王女士 · HR · 1月内活跃</div>' +
    '<div class="job-sec-text">岗位职责：负责产线测试设备维护与 EMC 整改，3 年以上经验。</div>' +
    '</body></html>');
  eq('详情页读出 HR 档位', p.activity, '1月内活跃');
  ok('详情页 JD 和活跃度互不影响', p.text.indexOf('EMC') >= 0, p.text);
  eq('没有活跃度时留空串', E.parseJdHtml(
    '<div class="job-sec-text">岗位职责：负责产线测试设备维护与整改，三年以上经验。</div>').activity, '');
  eq('jdFromHtml 仍然只返回正文', E.jdFromHtml(
    '<div class="job-boss-info">1月内活跃</div><div class="job-sec-text">岗位职责：负责 B 端 SaaS 产品运营策略与数据分析，3 年以上经验。</div>'
  ).indexOf('1月内活跃'), -1);
}

/* ---------------------------------------------------------------- 沟通按钮 */

console.log('== 沟通按钮 ==');
{
  const { E } = setup(`
    <div class="job-detail-box">
      <div class="job-sec-text">岗位职责详情描述内容足够长以通过面板长度检查</div>
      <a class="btn btn-startchat">立即沟通</a>
    </div>
  `);
  const panel = E.readPanel();
  const btn = E.findChatButton(panel.el);
  ok('按 class 命中按钮', !!btn);
  eq('按钮文本', btn && E.txt(btn), '立即沟通');
}

{
  const { E } = setup(`<div id="box"><button>打招呼</button></div>`);
  const btn = E.findChatButton(document.getElementById('box'));
  ok('无 class 时按文本兜底', !!btn);
  eq('兜底按钮文本', btn && E.txt(btn), '打招呼');
}

{
  const { E } = setup(`<div id="box"><button>投递简历</button><button>举报</button></div>`);
  eq('非沟通类按钮不误判', E.findChatButton(document.getElementById('box')), null);
}

{
  const { E } = setup(`<div id="box"><button class="hidden">立即沟通</button></div>`);
  eq('不可见按钮不返回', E.findChatButton(document.getElementById('box')), null);
}

/* ---------------------------------------------------------------- 弹窗 */

console.log('== 弹窗 ==');
{
  const { E, C } = setup(`
    <div class="dialog-wrap">
      <div class="dialog-con">今日沟通次数已达上限，明天再来吧</div>
      <a class="btn-sure">我知道了</a>
    </div>
  `);
  const dlg = E.topDialog();
  ok('找到弹窗', !!dlg);
  eq('分类为 limit', C.classifyPopupText(E.txt(dlg)), 'limit');
  const act = E.dialogActionFor('limit', dlg);
  ok('找到关闭按钮', !!act);
  eq('关闭按钮文本', act && E.txt(act), '我知道了');
}

{
  const { E, C } = setup(`
    <div class="dialog-wrap">
      <div class="dialog-con">该 Boss 正在与您沟通，是否继续沟通？</div>
      <a class="btn">继续沟通</a>
      <a class="btn">取消</a>
    </div>
  `);
  const dlg = E.topDialog();
  eq('分类为 continue', C.classifyPopupText(E.txt(dlg)), 'continue');
  eq('选中继续按钮', E.txt(E.dialogActionFor('continue', dlg)), '继续沟通');
}

{
  const { E } = setup(`<div class="dialog-wrap"><div>很小</div></div>`);
  // 尺寸足够时才会被当作弹窗；这里主要验证不会抛错
  const dlg = E.topDialog();
  ok('小弹窗也能返回（尺寸由 mock 决定）', dlg !== undefined);
}

{
  const { E } = setup(`<div class="dialog-wrap hidden">请完成滑动验证</div>`);
  eq('不可见弹窗不作为目标', E.topDialog(), null);
}

/* ---------------------------------------------------------------- 点击 */

console.log('== 点击 ==');
{
  const { E, w } = setup(`<div id="box"><button id="b">立即沟通</button></div>`);
  const b = w.document.getElementById('b');
  let clickCount = 0, downCount = 0;
  b.addEventListener('click', () => { clickCount++; });
  b.addEventListener('mousedown', () => { downCount++; });

  E.clickEl(b);

  eq('click 恰好触发一次', clickCount, 1);
  eq('mousedown 恰好触发一次', downCount, 1);
}

{
  const { E } = setup('<div></div>');
  eq('null 元素安全返回', E.clickEl(null), false);
}

/* ---------------------------------------------------------------- 异常探针 */

console.log('== 异常探针 ==');
{
  const { E } = setup('<div></div>');
  eq('正常页面无异常', E.anomalyNow(), []);
}

/* ---------------------------------------------------------------- 换一批控件 */

console.log('== 换一批控件 ==');
{
  const { E, w } = setup(`
    <div class="job-list-box"><ul></ul></div>
    <a class="load-more" id="more">加载更多岗位</a>`);
  const r = E.findMoreButton(w.document);
  ok('找到「加载更多」', r && r.el.id === 'more', JSON.stringify(r && r.word));
  eq('返回命中的词', r && r.word, '加载更多');
}

{
  const { E, w } = setup(`<div class="job-list-box"><ul></ul></div>`);
  eq('没有更多控件时返回 null', E.findMoreButton(w.document), null);
}

{
  // 正文段落里有「查看更多」，不能被当成翻页按钮点下去
  const { E, w } = setup(`<div class="job-desc">点击查看更多公司介绍与福利待遇详情</div>`);
  eq('正文里的「查看更多」不算控件', E.findMoreButton(w.document), null);
}

{
  const { E, w } = setup(`
    <div class="pagination"><a class="page-prev">上一页</a><a class="page-next" id="next">下一页</a></div>`);
  eq('找到下一页', E.findNextPage(w.document).id, 'next');
}

{
  const { E, w } = setup(`<div class="pagination"><a class="page-next disabled" id="next">下一页</a></div>`);
  eq('禁用态的下一页跳过', E.findNextPage(w.document), null);
}

{
  const { E, w } = setup(`<div class="pagination"><a class="page-next" aria-disabled="true">下一页</a></div>`);
  eq('aria-disabled 也跳过', E.findNextPage(w.document), null);
}

{
  // 没有 pager 类名时退化为按文本找
  const { E, w } = setup(`<div class="foot"><a id="n">下一页</a></div>`);
  eq('文本兜底找到下一页', E.findNextPage(w.document).id, 'n');
}

{
  const { E, w } = setup(`
    <div class="job-list-sort"><a class="active">推荐</a><a id="latest">最新</a></div>`);
  eq('找到「最新」排序页签', E.findSortLatest(w.document).el.id, 'latest');
}

{
  const { E, w } = setup(`<div class="job-list-sort"><a>推荐</a><a>薪资</a></div>`);
  eq('没有最新页签时返回 null', E.findSortLatest(w.document), null);
}

{
  // 岗位卡片里的「查看更多」是岗位内容，点了会打开该岗位 —— 必须挡掉
  const { E, w } = setup(`
    <div class="job-list-box"><ul>
      <li class="job-card-wrapper">
        <div class="job-card-wrap" id="c1">
          <a href="/job_detail/rf001.html">
            <span class="job-name">射频工程师</span>
            <span class="job-salary">8-11K</span>
            <span class="see-more">查看更多</span>
          </a>
        </div>
      </li>
    </ul></div>`);
  eq('卡片内的「查看更多」不当翻页控件', E.findMoreButton(w.document), null);
  ok('卡片里的元素被判为岗位入口',
    E.isJobEntry(w.document.getElementById('c1').querySelector('.see-more')));
}

{
  // 外层容器包着岗位链接，点它同样会跳进岗位
  const { E, w } = setup(`
    <div class="more-box"><a href="/job_detail/x.html">查看更多职位</a></div>`);
  eq('包着岗位链接的容器也不点', E.findMoreButton(w.document), null);
}

{
  // 右侧详情区里的「查看更多」也不是翻页控件
  const { E, w } = setup(`
    <div class="job-detail-box">
      <div class="company-info"><a href="/gongsi/abc.html">查看更多</a></div>
    </div>`);
  eq('详情区里的「查看更多」不点', E.findMoreButton(w.document), null);
}

{
  const { E, w } = setup(`
    <div class="job-list-box"><ul></ul></div>
    <div class="more-btn" id="more">加载更多</div>`);
  eq('卡片外的「加载更多」仍能找到', E.findMoreButton(w.document).el.id, 'more');
}

/* ---------------------------------------------------------------- 聊天页 */

console.log('== 聊天页 ==');
{
  const { E, w } = setup(`
    <div class="chat-input" id="ci" contenteditable="true"></div>
    <button class="btn-send" id="s">发送</button>
    <div class="message-list"><div class="chat-message">你好，我想投递这个岗位</div></div>`);

  eq('找到 contenteditable 输入框', E.chatInput().id, 'ci');
  eq('找到发送按钮', E.chatSendButton().id, 's');
  ok('初始输入框为空', E.inputEmpty(E.chatInput()));

  E.typeInto(E.chatInput(), '你好，我是王小明');
  ok('写入后非空', !E.inputEmpty(E.chatInput()));
  eq('写入内容可读回', E.inputText(E.chatInput()), '你好，我是王小明');

  ok('消息列表能认出已发内容', E.chatMessageSent('你好，我想投递这个岗位'));
  ok('没发过的句子不误判', !E.chatMessageSent('完全不同的另一句话'));
  ok('过短的探针不做判断', !E.chatMessageSent('你好'));
}

{
  const { E, w } = setup(`<textarea class="chat-input-editor" id="ta"></textarea>`);
  const ta = w.document.getElementById('ta');
  eq('textarea 也能识别', E.chatInput().id, 'ta');
  E.typeInto(ta, '老师您好');
  eq('textarea 写入读 value', E.inputText(ta), '老师您好');
  ok('textarea 非空判定', !E.inputEmpty(ta));
}

{
  const { E } = setup(`<div class="chat-box">该 Boss 已关闭沟通</div>`);
  eq('没有输入框时返回 null', E.chatInput(), null);
}

/* 灰着的发送键点下去等于没点：不能返回它，交给回车兜底 */
{
  const { E, w } = setup(`
    <div class="chat-input" id="ci" contenteditable="true"></div>
    <button class="btn-send disabled" id="s">发送</button>`);
  eq('灰着的发送键不算可用', E.chatSendButton(), null);

  let hit = 0;
  w.document.getElementById('ci').addEventListener('keydown', (e) => { if (e.key === 'Enter') hit++; });
  E.pressEnter(w.document.getElementById('ci'));
  eq('回车事件真的派发到编辑器', hit, 1);
}

/* 发送键在编辑器上层的容器里，也要顺着祖先找得到 */
{
  const { E } = setup(`
    <div class="chat-editor">
      <div class="chat-input" id="ci" contenteditable="true"></div>
      <div class="send-area"><span id="s" class="btn-send">发送</span></div>
    </div>`);
  eq('在编辑器附近找到发送键', E.chatSendButton(E.chatInput()).id, 's');
}

/* 「发送简历」的类名里也有 send，点下去就是真的投简历——绝不能当成聊天发送键 */
{
  const { E } = setup(`
    <div class="chat-input" id="ci" contenteditable="true"></div>
    <button class="btn-send-resume">发送简历</button>
    <button class="btn-send">发送</button>`);
  eq('跳过「发送简历」，选中真正的发送键', E.chatSendButton(E.chatInput()).className, 'btn-send');
}

{
  const { E } = setup(`
    <div class="chat-input" id="ci" contenteditable="true"></div>
    <button class="btn-send-resume">发送简历</button>`);
  eq('只有「发送简历」时宁可不点', E.chatSendButton(), null);
}

/* 类名整批换掉的版本：靠「底部 + 面积大」定位编辑器，靠「搜索栏里的不算」排除干扰 */
{
  const { E, w } = setup(`
    <div class="im">
      <div class="search" contenteditable="true" id="search"></div>
      <div class="im-footer"><div contenteditable="true" id="ed"></div></div>
    </div>`);
  w.Element.prototype.getBoundingClientRect = function () {
    if (this.id === 'search') return { width: 120, height: 16, top: 10, left: 10, right: 130, bottom: 26, x: 10, y: 10 };
    if (this.id === 'ed') return { width: 600, height: 90, top: 700, left: 10, right: 610, bottom: 790, x: 10, y: 700 };
    return { width: 320, height: 130, top: 10, left: 10, right: 330, bottom: 140, x: 10, y: 10 };
  };
  const picked = E.chatInput();
  eq('按位置找到底部那个编辑器', picked && picked.id, 'ed');
}

/* 失败时要把现场证据打出来，否则只能靠用户手动翻 DOM */
{
  const { E } = setup(`
    <div class="chat-box">
      <div class="message-list"><div class="chat-message">你好</div><div class="chat-message">在吗</div></div>
      <div class="chat-input" id="ci" contenteditable="true"></div>
    </div>`);
  eq('数得清会话里有几条消息', E.chatMsgCount(), 2);
  const d = E.chatDiagnose();
  ok('诊断里有可编辑元素与发送键结论',
    d.indexOf('可编辑元素 1 个') >= 0 && d.indexOf('发送键：') >= 0 && d.indexOf('消息条数：2') >= 0, d);
}

/* ---------------------------------------------------------------- 滚动与卡片点击 */

console.log('== 滚动与卡片点击 ==');

{
  const { E, w } = setup(`
    <div class="job-list-box" id="list"><ul></ul></div>
    <div class="job-detail-box">右侧详情</div>`);
  /* jsdom 的 scrollHeight 恒为 0，这里伪造「内容比视口高」 */
  const list = w.document.getElementById('list');
  Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 4000 });
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 800 });
  Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 0 });

  eq('能找到可滚动的列表容器', E.findScrollHost(), list);
  E.scrollToBottom(list);
  ok('滚到底后 scrollTop 到底', list.scrollTop === 4000, String(list.scrollTop));
  E.scrollToTop(list);
  eq('滚回顶部', list.scrollTop, 0);
}

{
  const { E } = setup(`<div class="chat-box">聊天页</div>`);
  eq('没有可滚动容器时返回 null', E.findScrollHost(), null);
}

/* 回归：BOSS 的滚动容器不一定命中选择器表。选择器一旦失配，
   滚动会打在无关的侧栏上——页面纹丝不动，脚本却判定「到底了」。
   所以优先「从第一张卡片往上找可滚祖先」。 */
{
  const { E, w } = setup(`
    <div class="job-detail-box">详情</div>
    <div class="scroll-body" id="outer" style="overflow-y:auto">
      <ul><li class="job-card-wrap">
        <a href="/job_detail/z1.html"><span class="job-name">EMC 工程师</span></a>
      </li></ul>
    </div>`);
  const outer = w.document.getElementById('outer');
  Object.defineProperty(outer, 'scrollHeight', { configurable: true, value: 3000 });
  Object.defineProperty(outer, 'clientHeight', { configurable: true, value: 700 });
  eq('从卡片祖先找到真正的滚动容器', E.findScrollHost(), outer);
}

/* 到底提示：BOSS 最后一页会在列表底部写一句，看到它就不该再滚 */
{
  const { E, w } = setup(`
    <div class="job-list-box"><ul><li class="job-card-wrap">
      <a href="/job_detail/z1.html"><span class="job-name">EMC 工程师</span></a>
    </li></ul><div id="end">没有更多了</div></div>`);
  eq('识别列表底部的「没有更多了」', E.endOfList(), '没有更多了');

  w.document.getElementById('end').textContent = '岗位很多，可以继续投递简历';
  eq('普通文案不算到底', E.endOfList(), '');
}

/* 岗位正文里的「没有更多」不能当成列表到底 */
{
  const { E, w } = setup(`
    <div class="job-list-box"><ul><li class="job-card-wrap" id="c">
      <a href="/job_detail/z1.html"><span class="job-name">EMC 工程师</span></a>
      <span class="see">没有更多了</span>
    </li></ul></div>`);
  ok('卡片里的文案不算到底', E.endOfList() === '', w.document.getElementById('c').innerHTML.slice(0, 40));
}

{
  const { E, w } = setup(`
    <ul><li class="job-card-wrapper" id="c">
      <div class="job-card-wrap">
        <a href="/job_detail/abc.html"><span class="job-name">产品运营</span></a>
      </div>
    </li></ul>`);
  const card = w.document.getElementById('c');
  /* 关键回归：绝不能返回卡片里的 <a href>，点它会整页跳转、脚本上下文销毁 */
  eq('点击目标是卡片容器而不是链接', E.cardClickTarget(card), card);
  ok('点击目标不是 <a>', E.cardClickTarget(card).tagName !== 'A');
}

{
  const { E, w } = setup(`
    <ul><li class="job-card-wrapper" id="c">
      <div class="job-card-wrap">
        <a href="/job_detail/abc.html"><span class="job-name">产品运营</span></a>
        <a class="btn btn-startchat" id="chat">立即沟通</a>
      </div>
    </li></ul>`);
  const card = w.document.getElementById('c');
  const btn = E.findCardChatButton(card);
  ok('找到卡片自带的沟通按钮', btn && btn.id === 'chat', btn && btn.id);
}

{
  const { E, w } = setup(`
    <ul><li class="job-card-wrapper" id="c">
      <div class="job-card-wrap"><a href="/job_detail/abc.html"><span class="job-name">产品运营</span></a></div>
    </li></ul>`);
  eq('卡片没有沟通按钮时返回 null', E.findCardChatButton(w.document.getElementById('c')), null);
}

/* 新版卡片把按钮做成纯文本 span，一个 btn 类名都没有：只能按文本找，
   而且不能找到卡片自己的详情链接上去（点了会整页跳转）。 */
{
  const { E, w } = setup(`
    <div class="job-card-wrap" id="c">
      <a href="/job_detail/abc.html"><span class="job-name">产品运营</span><span class="job-salary">18-28K</span></a>
      <div class="ops"><span class="go-chat">立即沟通</span></div>
    </div>`);
  const btn = E.findCardChatButton(w.document.getElementById('c'));
  ok('没有 btn 类名时按文本找到沟通按钮', !!btn && E.txt(btn) === '立即沟通', btn && E.txt(btn));
  eq('取最深的那个元素（包裹层点了没用）', btn && btn.className, 'go-chat');
}

{
  const { E, w } = setup(`
    <div class="job-card-wrap" id="c"><a href="/job_detail/abc.html">立即沟通</a></div>`);
  eq('详情链接不会被当成沟通按钮', E.findCardChatButton(w.document.getElementById('c')), null);
}

/* 「继续沟通」是 BOSS 自己标的「已经联系过」，不能再当新岗位点一遍 */
{
  const { E } = setup(`<div class="job-detail-box"><a class="btn-startchat">继续沟通</a></div>`);
  ok('认得出「继续沟通」', E.isContactedText('继续沟通'));
  ok('「已沟通」也算', E.isContactedText('已沟通'));
  ok('「立即沟通」不算', E.isContactedText('立即沟通') === false);
  ok('空文本不算', E.isContactedText('') === false);
}

/* 点开卡片的候选目标：只点容器有版本完全没反应，要能顺着往卡片里试 */
{
  const { E, w } = setup(`
    <div class="job-card-wrap" id="c">
      <a href="/job_detail/z1.html"><span class="job-name">EMC 工程师</span></a>
    </div>`);
  const card = w.document.getElementById('c');
  const chain = E.cardClickChain(card);
  eq('第一个目标还是卡片容器', chain[0].how, '卡片容器');
  ok('标题在候选里', chain.some((t) => t.how === '卡片标题'), JSON.stringify(chain.map((t) => t.how)));
  ok('详情链接在候选里', chain.some((t) => t.how === '详情链接'), JSON.stringify(chain.map((t) => t.how)));
  ok('标题与链接都要拦默认跳转',
    chain.filter((t) => t.how !== '卡片容器').every((t) => t.blockNav === true));
  eq('不会把同一个元素排两遍', new Set(chain.map((t) => t.el)).size, chain.length);
  eq('没有卡片时返回空', E.cardClickChain(null).length, 0);
}

/* 点不开时要把「为什么点不开」写清楚，尤其是新开标签页这种死路 */
{
  const { E, w } = setup(`
    <div class="job-card-wrap" id="c">
      <a href="/job_detail/z1.html" target="_blank"><span class="job-name">EMC 工程师</span></a>
    </div>
    <div class="job-detail-box"></div>`);
  const d = E.cardDiag(w.document.getElementById('c'), ['卡片容器', '卡片标题']);
  ok('记录了试过哪些目标', d.indexOf('试过 2 个目标') >= 0, d);
  ok('指出 target=_blank 会开新标签页', d.indexOf('target=_blank') >= 0, d);
  ok('数了页面上有多少个详情区候选', d.indexOf('job-detail」元素 1 个') >= 0 || /job-detail.*元素 1 个/.test(d), d);
  ok('带上一段卡片 HTML 方便比对选择器', d.indexOf('job-card-wrap') >= 0, d);
}

/* ---------------------------------------------------------------- 页面诊断 */

console.log('== 页面诊断 ==');

{
  const { E } = setup(`
    <div class="job-list-box" id="list">
      <ul><li class="job-card-wrapper"><div class="job-card-wrap">
        <a href="/job_detail/abc.html"><span class="job-name">产品运营</span>
        <span class="job-salary">12-24K</span></a>
      </div></li></ul>
    </div>
    <div class="pagination"><a class="page-next" id="next">下一页</a></div>
    <div class="job-detail-box"><div class="job-sec-text">岗位职责：负责增长</div>
      <a class="btn btn-startchat">立即沟通</a></div>`);

  const text = E.probePage();
  ok('诊断带标题', text.indexOf('# boss-scout 页面诊断') === 0, text.slice(0, 60));
  ok('诊断列出卡片命中数', text.indexOf('解析出卡片 1 个') > 0, text.slice(0, 400));
  ok('诊断带首个卡片 HTML', text.indexOf('job-card-wrap') > 0);
  ok('诊断列出分页候选', text.indexOf('page-next') > 0);
  ok('诊断报告详情面板命中', text.indexOf('readPanel()：命中') > 0);
  ok('诊断报告沟通按钮', text.indexOf('findChatButton()') > 0 && text.indexOf('startchat') > 0);
  ok('诊断标注卡片内元素', text.indexOf('[卡片内]') > 0);
  /* 活跃度读不到时诊断必须自己说出来——否则用户只会看到「怎么没筛掉僵尸岗」 */
  ok('诊断说明活跃度读不到', text.indexOf('卡片带活跃度 0/1') > 0, text.slice(0, 400));
}

{
  const { E } = setup(`
    <div class="job-card-wrap">
      <a href="/job_detail/act9.html"><span class="job-name">EMC 测试</span></a>
      <span class="boss-active">3日内活跃</span>
    </div>
    <div class="job-card-wrap">
      <a href="/job_detail/act8.html"><span class="job-name">硬件测试</span></a>
      <span class="boss-active">本月活跃</span>
    </div>`);
  const text = E.probePage();
  ok('诊断统计带活跃度的卡片数', text.indexOf('卡片带活跃度 2/2') > 0, text.slice(0, 400));
  ok('诊断给出档位样例', text.indexOf('3日内活跃') > 0 && text.indexOf('本月活跃') > 0, text.slice(0, 400));
}

{
  const { E } = setup(`<div class="chat-box">与 Boss 沟通中</div>`);
  const text = E.probePage();
  ok('无卡片时诊断不崩且说明 0 个', text.indexOf('解析出卡片 0 个') > 0, text.slice(0, 300));
  ok('无面板时写明未命中', text.indexOf('readPanel()：未命中') > 0);
}

/* ---------------------------------------------------------------- 结果 */

console.log('');
if (fail) {
  console.log(`✗ ${fail} 项失败 / 共 ${pass + fail} 项\n`);
  fails.forEach((f, i) => console.log(`${i + 1}. ${f}\n`));
  process.exit(1);
} else {
  console.log(`✓ ${pass} 项全部通过`);
}
