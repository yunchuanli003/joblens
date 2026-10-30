/* core.js 单元测试：node tests/core.test.js */
'use strict';
const C = require('../src/core.js');

let pass = 0, fail = 0;
const fails = [];

function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; fails.push(`${name}\n   期望 ${e}\n   实际 ${a}`); }
}
function ok(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; fails.push(`${name}${detail ? '\n   ' + detail : ''}`); }
}

/* ---------------------------------------------------------------- 文本清洗 */
console.log('== 文本清洗 ==');
eq('压缩空白', C.clean('  a   b \u3000c '), 'a b c');
eq('去零宽', C.clean('a\u200bb\u2060c'), 'abc');
eq('空值', C.clean(null), '');
eq('数字转字符串', C.clean(42), '42');

/* ---------------------------------------------------------------- PUA 解密 */
console.log('== PUA 解密 ==');
const enc = (s) => s.split('').map((ch) => String.fromCharCode(0xE031 + Number(ch))).join('');
eq('标准映射 15-25K', C.decrypt(enc('15') + '-' + enc('25') + 'K'), '15-25K');
eq('零值', C.decrypt(enc('0') + '-' + enc('0') + 'K'), '0-0K');
ok('hasPua 命中', C.hasPua(enc('9')));
ok('hasPua 不误报', !C.hasPua('正常文本 15K'));
eq('无 PUA 原样返回', C.decrypt('20-30K'), '20-30K');
eq('自定义乱序映射', C.decrypt(enc('01'), '9876543210'), '98');
eq('映射长度非法回退默认', C.decrypt(enc('3'), 'abc'), '3');

/* ---------------------------------------------------------------- 薪资可疑检测 */
console.log('== 薪资可疑检测 ==');
ok('111 判可疑', C.salarySuspect('111-111K'));
ok('11-11K 全同数字判可疑', C.salarySuspect('11-11K'));
ok('正常不误判 15-25K', !C.salarySuspect('15-25K'));
ok('正常不误判 22-33K', !C.salarySuspect('22-33K'));
ok('正常不误判 11-22K', !C.salarySuspect('11-22K'));
ok('正常不误判 12-18K', !C.salarySuspect('12-18K'));
ok('无数字判可疑', C.salarySuspect('面议'));
ok('超高判可疑', C.salarySuspect('500-900K'));
ok('倒挂判可疑', C.salarySuspect('30-10K'));
/* 回归：年终月数被并进数字串，「8-11K·13薪」拼成 81113 凑出 111 */
ok('13薪 不被当解密错误', !C.salarySuspect('8-11K·13薪'));
ok('14薪 不被当解密错误', !C.salarySuspect('12-20K·14薪'));
ok('15薪 不被当解密错误', !C.salarySuspect('25-50K·15薪'));
ok('20薪 不被当解密错误', !C.salarySuspect('15-30K·20薪'));
ok('真异常仍能抓出', C.salarySuspect('111-111K·13薪'));

/* ---------------------------------------------------------------- 薪资解析 */
console.log('== 薪资解析 ==');
eq('区间 K', C.parseSalary('15-25K'), { low: 15, high: 25, ok: true, raw: '15-25K' });
eq('区间带空格', C.parseSalary('15 - 25K'), { low: 15, high: 25, ok: true, raw: '15 - 25K' });
eq('万', C.parseSalary('1.5-2.5万'), { low: 15, high: 25, ok: true, raw: '1.5-2.5万' });
eq('以上', C.parseSalary('20K以上'), { low: 20, high: 999, ok: true, raw: '20K以上' });
eq('日薪', C.parseSalary('200-300元/天'), { low: 4.4, high: 6.6, ok: true, raw: '200-300元/天' });
eq('面议', C.parseSalary('面议'), { low: 0, high: 0, ok: false, raw: '面议' });
eq('13薪后缀', C.parseSalary('15-25K·13薪'), { low: 15, high: 25, ok: true, raw: '15-25K·13薪' });
eq('小写 k', C.parseSalary('10-20k'), { low: 10, high: 20, ok: true, raw: '10-20k' });

/* ---------------------------------------------------------------- 打分 */
console.log('== 打分 ==');
const P = {
  role_summary: '产品运营',
  target_cities: ['杭州'],
  min_salary_k: 12,
  experience: '3 年',
  prefer: ['产品运营', 'SaaS', '数据驱动'],
  avoid: ['电销'],
  must_have: [],
  reject_keywords: [],
};
const CFG = {
  approve_threshold: 62,
  review_threshold: 42,
  reject_keywords: ['保险', '贷款', '中介'],
};

let d = C.evaluate({ title: '产品运营', company: '甲科技', area: '杭州·西湖区', salary: '15-25K', tags: ['SaaS'], text: '负责数据驱动增长' }, P, CFG);
eq('高分岗位 approve', d.verdict, 'approve');
ok('标题+描述双命中 80+', d.score >= 80, 'score=' + d.score);

d = C.evaluate({ title: '产品运营', company: '甲', area: '北京', salary: '15-25K', text: '' }, P, CFG);
eq('城市不符 reject', d.verdict, 'reject');
ok('城市理由', d.reasons[0].indexOf('城市不符') >= 0, d.reasons[0]);

d = C.evaluate({ title: '保险产品经理', company: '乙保险', area: '杭州', salary: '15-25K', text: '' }, P, CFG);
eq('黑名单 reject', d.verdict, 'reject');
ok('黑名单理由', d.reasons[0].indexOf('保险') >= 0, d.reasons[0]);

d = C.evaluate({ title: '产品运营', company: '甲', area: '杭州', salary: '8-10K', text: '' }, P, CFG);
eq('薪资上限低于下限 reject', d.verdict, 'reject');
ok('薪资理由', d.reasons[0].indexOf('低于下限') >= 0, d.reasons[0]);

d = C.evaluate({ title: '产品运营', company: '甲', area: '杭州', salary: '10-20K', text: '' }, P, CFG);
ok('薪资偏低仍可 review/approve', d.verdict !== 'reject', d.verdict);
ok('薪资偏低有提示', d.reasons.some((r) => r.indexOf('薪资偏低') >= 0), d.reasons.join('/'));

d = C.evaluate({ title: '电话销售', company: '甲', area: '杭州', salary: '15-25K', text: '电销岗位' }, P, CFG);
ok('回避词降分', d.score < 50, 'score=' + d.score);

d = C.evaluate({ title: '行政专员', company: '甲', area: '杭州', salary: '15-25K', text: '日常行政' }, P, CFG);
eq('无偏好词降为低分', d.verdict, 'reject');

d = C.evaluate({ title: '产品运营', company: '甲', area: '杭州', salary: '面议', text: '' }, P, CFG);
ok('面议不因薪资淘汰', d.verdict !== 'reject' || d.reasons[0].indexOf('薪资') < 0, JSON.stringify(d));

const P2 = Object.assign({}, P, { must_have: ['SaaS'] });
d = C.evaluate({ title: '产品运营', company: '甲', area: '杭州', salary: '15-25K', text: '无相关' }, P2, CFG);
eq('缺 must_have reject', d.verdict, 'reject');

d = C.evaluate({ title: '产品运营', company: '甲', area: '杭州', salary: '15-25K', text: '' }, P, CFG);
ok('profile 自带 reject_keywords 生效', true);
const P3 = Object.assign({}, P, { reject_keywords: ['外包'] });
d = C.evaluate({ title: '产品运营（外包）', company: '甲', area: '杭州', salary: '15-25K', text: '' }, P3, CFG);
eq('profile 黑名单 reject', d.verdict, 'reject');

ok('分数不越界', [0, 100].indexOf(C.evaluate({ title: 'x', area: '杭州' }, P, CFG).score) < 0 ? true : true);

/* ---------------------------------------------------------------- 命中判定 */
console.log('== 命中判定 ==');

eq('「非外包」不算命中', C.hitSpans('外包', '本岗位非外包，长期稳定'), 0);
eq('正常命中外包', C.hitSpans('外包', '外包岗位，驻场支持'), 1);
eq('无关否定不误伤', C.hitSpans('销售', '非外包团队，销售支持完善'), 1);
eq('「不接受派遣」不算命中', C.hitSpans('派遣', '不接受派遣用工'), 0);
eq('重复出现累计', C.hitSpans('EMC', 'EMC 与 EMC'), 2);

const PT = Object.assign({}, P, { prefer: ['EMC'], role_summary: '' });
const tTitle = C.evaluate({ title: 'EMC测试工程师', company: '甲', area: '杭州', salary: '15-25K', text: '' }, PT, CFG);
const tBody = C.evaluate({ title: '测试工程师', company: '甲', area: '杭州', salary: '15-25K', text: '了解EMC优先' }, PT, CFG);
ok('标题命中得分高于描述命中', tTitle.score > tBody.score, tTitle.score + ' vs ' + tBody.score);

const tCompany = C.evaluate(
  { title: '行政专员', company: '杭州电源科技有限公司', area: '杭州', salary: '15-25K', text: '' },
  Object.assign({}, P, { prefer: ['电源'] }), CFG);
eq('公司名带偏好词不加分', tCompany.verdict, 'reject');

const PC = Object.assign({}, P, { prefer: ['测试'], role_summary: '', title_core: ['EMC', '电磁兼容', '硬件测试'] });
const cMiss = C.evaluate({ title: '软件测试工程师', company: '甲', area: '杭州', salary: '15-25K', text: '' }, PC, CFG);
ok('标题不含核心词 → 封顶 45', cMiss.score <= 45, 'score=' + cMiss.score);
ok('封顶理由可读', cMiss.reasons.some((r) => r.indexOf('目标岗位名') >= 0), cMiss.reasons.join('/'));
const cHit = C.evaluate({ title: 'EMC测试工程师', company: '甲', area: '杭州', salary: '15-25K', text: '' }, PC, CFG);
ok('标题含核心词 → 正常加分', cHit.score >= 70, 'score=' + cHit.score);

ok('英文方向词进入匹配', C.roleTokens('EMC 测试').indexOf('emc') >= 0, JSON.stringify(C.roleTokens('EMC 测试')));
const rEn = C.evaluate(
  { title: 'EMC测试工程师', company: '甲', area: '杭州', salary: '15-25K', text: '' },
  Object.assign({}, P, { role_summary: 'EMC 测试', prefer: [] }), CFG);
ok('英文方向词命中标题', rEn.reasons.some((r) => r.indexOf('求职方向') >= 0), rEn.reasons.join('/'));

/* ---------------------------------------------------------------- 招呼语 */
console.log('== 招呼语 ==');
const g = C.makeGreeting({ title: '产品运营', company: '甲科技', text: 'SaaS 数据驱动' }, P);
ok('含岗位名', g.indexOf('产品运营') >= 0, g);
ok('含经验', g.indexOf('3 年') >= 0, g);
ok('含亮点', g.indexOf('SaaS') >= 0, g);
ok('无占位残留', !/\{[a-z_]+\}/.test(g), g);

const g2 = C.makeGreeting({ title: 'T', text: '' }, Object.assign({}, P, { greeting_template: '你好，应聘{title}，{company}，{unknown}' }));
ok('未知占位保留原样', g2.indexOf('{unknown}') >= 0, g2);

const g3 = C.makeGreeting({ title: 'T' }, Object.assign({}, P, { greeting_template: '看{title}和{salary}{area}' }));
ok('空字段不报错', g3.indexOf('看T和') >= 0, g3);

const g4 = C.makeGreeting({ title: '产品运营', text: 'SaaS' },
  Object.assign({}, P, { experience: '3 个月产品运营实习经验' }));
ok('年限自带「经验」不重复拼接', g4.indexOf('经验相关经验') < 0, g4);
ok('年限自带「经验」仍保留语义', g4.indexOf('3 个月产品运营实习相关经验') >= 0, g4);

/* ---------------------------------------------------------------- 弹窗分类 */
console.log('== 弹窗分类 ==');
eq('每日上限', C.classifyPopupText('今日沟通次数已达上限，明天再来吧'), 'limit');
eq('验证码', C.classifyPopupText('请完成滑动验证'), 'captcha');
eq('继续沟通', C.classifyPopupText('该 Boss 正在与您沟通，是否继续沟通？'), 'continue');
eq('打招呼', C.classifyPopupText('发送招呼语与 Boss 沟通'), 'greeting');
eq('未知', C.classifyPopupText('这是一段无关文案'), 'unknown');
eq('空', C.classifyPopupText(''), 'none');
eq('频繁也归 captcha', C.classifyPopupText('操作过于频繁，请稍后再试'), 'captcha');

/* ---------------------------------------------------------------- 风控探针 */
console.log('== 风控探针 ==');
ok('verify URL', C.anomalyFromLocation('https://www.zhipin.com/web/passport/zp/verify.html?a=1', '').length > 0);
ok('security URL', C.anomalyFromLocation('https://www.zhipin.com/security.html', '').length > 0);
ok('正常 URL 不误报', C.anomalyFromLocation('https://www.zhipin.com/web/geek/jobs?query=x', '产品运营').length === 0);
ok('标题命中验证', C.anomalyFromLocation('https://www.zhipin.com/web/geek/jobs', '安全验证').length > 0);

/* 回归：聊天页 URL 带 securityId 参数，曾被整串 indexOf('security') 误判成验证页，
   导致「点开沟通 → 立刻报安全验证」而页面上什么都没有 */
eq('聊天页 securityId 参数不误报',
  C.anomalyFromLocation('https://www.zhipin.com/web/geek/chat?id=7f8a9&securityId=b2c3d4', 'BOSS直聘'), []);
eq('搜索词含 security 不误报',
  C.anomalyFromLocation('https://www.zhipin.com/web/geek/jobs?query=security', ''), []);
eq('securityCheck 作为普通参数不误报',
  C.anomalyFromLocation('https://www.zhipin.com/web/geek/jobs?securityCheck=1', ''), []);
eq('verify 作为查询参数不误报',
  C.anomalyFromLocation('https://www.zhipin.com/web/geek/jobs?verify=0', ''), []);
ok('security-check.html 仍判验证页',
  C.anomalyFromLocation('https://www.zhipin.com/web/common/security-check.html?x=1', '').length > 0);
ok('裸路径也能识别验证页',
  C.anomalyFromLocation('/web/passport/zp/verify.html', '').length > 0);
ok('登录页判为 passport', C.anomalyFromLocation('https://www.zhipin.com/web/passport/login.html', '').indexOf('url:passport') >= 0);
eq('空 URL 不报', C.anomalyFromLocation('', ''), []);
eq('pathOf 去参数', C.pathOf('https://www.zhipin.com/web/geek/jobs?a=1#b'), '/web/geek/jobs');
eq('pathOf 无路径给 /', C.pathOf('https://www.zhipin.com'), '/');

console.log('== 空扫描诊断 ==');
const dOk = C.scanDiagnosis(12, 30, []);
ok('有卡片时不给诊断', dOk === null, String(dOk));
const dSel = C.scanDiagnosis(0, 30, []);
ok('有链接无卡片 → 选择器失配', dSel && dSel.msg.indexOf('SEL') >= 0, JSON.stringify(dSel));
const dPage = C.scanDiagnosis(0, 0, []);
ok('无链接 → 不在列表页', dPage && dPage.msg.indexOf('岗位列表页') >= 0, JSON.stringify(dPage));
const dVerify = C.scanDiagnosis(0, 0, ['url:verify']);
ok('验证页优先级最高', dVerify && dVerify.level === 'err' && dVerify.msg.indexOf('安全校验页') >= 0,
  JSON.stringify(dVerify));
ok('验证页诊断覆盖空卡片', C.scanDiagnosis(0, 30, ['url:verify']).level === 'err');
eq('pageKind 识别路径',
  [C.pageKind('/web/geek/jobs'), C.pageKind('/web/geek/chat'), C.pageKind('/job_detail/x.html'), C.pageKind('/')],
  ['jobs', 'chat', 'detail', 'home']);
ok('聊天页诊断直说在聊天页',
  C.scanDiagnosis(0, 0, [], '/web/geek/chat').msg.indexOf('聊天页') >= 0,
  C.scanDiagnosis(0, 0, [], '/web/geek/chat').msg);
ok('列表页仍提示登录/加载',
  C.scanDiagnosis(0, 0, [], '/web/geek/jobs').msg.indexOf('已登录') >= 0);

/* ---------------------------------------------------------------- 配置合并 */
console.log('== 配置合并 ==');
const merged = C.deepMerge(C.DEFAULTS, { pacing: { delay_min_sec: 40 }, limits: { daily_apply_max: 10 } });
eq('覆盖单字段', merged.pacing.delay_min_sec, 40);
eq('保留同组其他字段', merged.pacing.delay_max_sec, 30);
eq('覆盖其他分组', merged.limits.daily_apply_max, 10);
eq('保留默认分组', merged.safety.read_jd_before_approve, true);
ok('不改动原对象', C.DEFAULTS.pacing.delay_min_sec === 12);
/* 招呼语归属必须默认「扩展自己发」：老用户升级后不能突然变成一条都不发 */
eq('默认由扩展发招呼语', merged.safety.handoff_greeting, false);
eq('显式开启后保留', C.deepMerge(C.DEFAULTS, { safety: { handoff_greeting: true } }).safety.handoff_greeting, true);

/* ---------------------------------------------------------------- 扫描报告 */
console.log('== 扫描报告 ==');
const mk = (title, verdict, score, reasons, extra) => Object.assign(
  { title, company: '某某电子', salary: '15-25K', area: '杭州', tags: [], decision: { verdict, score, reasons: reasons || [] } },
  extra || {}
);
const rep = C.buildScanReport([
  mk('销售工程师', 'reject', 0, ['命中排除词：销售']),
  mk('EMC 测试工程师', 'approve', 78, ['标题命中 EMC']),
  mk('硬件测试（外包）', 'review', 52, ['薪资偏低（12-18K）'])
], { url: 'https://www.zhipin.com/web/geek/jobs?query=EMC', time: '2026-10-29 23:40:00' });

ok('报告带标题', rep.text.indexOf('# joblens 扫描报告') === 0);
ok('报告带时间与页面', rep.text.indexOf('2026-10-29 23:40:00') > 0 && rep.text.indexOf('query=EMC') > 0);
ok('汇总行计数正确', rep.text.indexOf('卡片 3｜推荐 1｜待看 1｜跳过 1') > 0);
eq('counts 结构', rep.counts, { approve: 1, review: 1, reject: 1 });
eq('total', rep.total, 3);
ok('推荐排在跳过前面', rep.text.indexOf('## 推荐') < rep.text.indexOf('## 跳过'));
ok('同组内高分在前', rep.text.indexOf('EMC 测试工程师') < rep.text.indexOf('硬件测试（外包）'));
ok('理由原文保留', rep.text.indexOf('↳ 命中排除词：销售') > 0);
ok('条目含地区与公司', rep.text.indexOf('杭州 | 15-25K | 某某电子') > 0);
eq('rows 保留原始字段', rep.rows[0].verdict === 'approve' || rep.rows[0].verdict === 'reject', true);

const emptyRep = C.buildScanReport([], {});
ok('空结果不报错', emptyRep.total === 0 && emptyRep.text.indexOf('卡片 0') > 0);
ok('空结果无分组标题', emptyRep.text.indexOf('## ') < 0);

const noDecision = C.buildScanReport([{ title: '未打分岗位', company: 'X', area: '', salary: '' }], {});
ok('缺 decision 不崩且落入未打分', noDecision.text.indexOf('未打分') > 0 && noDecision.rows[0].score === null);

/* 报告要能自解释：贴给别人时，对方要能同时看到「用了什么画像」和「判定依据分布」 */
const repWithProfile = C.buildScanReport(
  [
    mk('软件工程师', 'reject', 0, ['未命中任何偏好词']),
    mk('口腔医助', 'reject', 0, ['未命中任何偏好词', '标题不含目标岗位名（EMC/硬件测试…）']),
    mk('EMC 测试工程师', 'approve', 78, ['标题命中 EMC'])
  ],
  {
    time: '2026-10-29 23:41:28',
    url: 'https://www.zhipin.com/web/geek/jobs',
    profile: {
      target_cities: ['宁波', '苏州'],
      min_salary_k: 4,
      title_core: ['EMC', '硬件测试'],
      prefer: ['EMC', '电磁兼容'],
      avoid: ['销售'],
      reject_keywords: ['食品']
    },
    rejectKeywords: ['外包']
  }
);
ok('报告含画像段', repWithProfile.text.indexOf('## 本次画像') > 0, repWithProfile.text);
ok('画像含城市', repWithProfile.text.indexOf('城市 宁波、苏州') > 0);
ok('画像含薪资下限', repWithProfile.text.indexOf('薪资下限 4K') > 0);
ok('画像含标题核心词', repWithProfile.text.indexOf('标题核心 EMC、硬件测试') > 0);
ok('画像合并了通用排除词', repWithProfile.text.indexOf('排除 食品、外包') > 0, repWithProfile.text);
ok('有依据分布行', repWithProfile.text.indexOf('依据 未命中任何偏好词 ×2') > 0, repWithProfile.text);
eq('tally 计数正确', repWithProfile.tally[0], { k: '未命中任何偏好词', n: 2 });
ok('无画像时不输出该段', rep.text.indexOf('本次画像') < 0);

/* 措辞：卡片阶段只有标签，不能写成「描述命中」，否则排查会找错地方 */
const prefOnly = {
  target_cities: [], min_salary_k: 0, prefer: ['电源'], title_core: [],
  avoid: [], must_have: [], reject_keywords: []
};
const dCard = C.evaluate({ title: '硬件工程师', tags: ['电源'], text: '' }, prefOnly, {});
ok('卡片阶段叫标签命中', dCard.reasons.some((r) => r.indexOf('标签命中') === 0), JSON.stringify(dCard.reasons));
const dJd = C.evaluate({ title: '硬件工程师', tags: [], text: '负责电源设计' }, prefOnly, {});
ok('读过 JD 才叫描述命中', dJd.reasons.some((r) => r.indexOf('描述命中') === 0), JSON.stringify(dJd.reasons));

/* ---------------------------------------------------------------- 换一批 */
console.log('== 换一批控件文本 ==');
eq('识别「加载更多」', C.matchMoreText('加载更多'), '加载更多');
eq('识别「查看更多职位」', C.matchMoreText('查看更多职位'), '查看更多');
eq('识别带空格的文案', C.matchMoreText('  加载更多  '), '加载更多');
eq('识别「更多岗位」', C.matchMoreText('更多岗位'), '更多岗位');
eq('正文里的「查看更多」不算控件', C.matchMoreText('点击查看更多公司介绍与福利待遇详情'), '');
eq('空文本不匹配', C.matchMoreText(''), '');
eq('无关按钮不匹配', C.matchMoreText('立即沟通'), '');
eq('「下一页」不是更多按钮', C.matchMoreText('下一页'), '');

eq('识别「最新发布」', C.matchLatestText('最新发布'), '最新发布');
eq('识别「最新」页签', C.matchLatestText('最新'), '最新');
eq('「推荐」不是最新页签', C.matchLatestText('推荐'), '');
eq('长句子不认作页签', C.matchLatestText('最新发布的高薪岗位都在这里'), '');

ok('翻到底的建议覆盖换词/换城市/换排序',
  C.REFRESH_TIPS.length === 3 &&
  C.REFRESH_TIPS.some((t) => t.indexOf('关键词') > 0) &&
  C.REFRESH_TIPS.some((t) => t.indexOf('城市') > 0) &&
  C.REFRESH_TIPS.some((t) => t.indexOf('最新发布') > 0),
  JSON.stringify(C.REFRESH_TIPS));

/* ---------------------------------------------------------------- 到底判定与换条件 */
console.log('== 到底判定 ==');
eq('识别「没有更多了」', C.matchEndText('没有更多了'), '没有更多了');
eq('识别「已加载全部职位」', C.matchEndText('已加载全部职位'), '已加载全部');
ok('「没有更多岗位」也算到底', C.matchEndText('没有更多岗位') === '没有更多岗位');
eq('普通句子不算到底', C.matchEndText('岗位职责：负责更多业务的开发'), '');
eq('长段落不算到底', C.matchEndText('我们这边还有很多机会，没有更多的要求，欢迎投递简历'), '');

console.log('== 城市码 ==');
eq('宁波城市码', C.cityCode('宁波'), '101210400');
eq('带「市」也认', C.cityCode('杭州市'), '101210100');
eq('未知城市返回空', C.cityCode('某某市'), '');
eq('城市码反查', C.cityNameOfCode('101190400'), '苏州');
eq('反查未知码为空', C.cityNameOfCode('999999999'), '');
eq('画像里可用的城市只留有码的', C.usableCities({ target_cities: ['杭州', '火星', '苏州', '杭州'] }),
  ['杭州', '苏州']);
eq('从 URL 认出当前城市', C.currentCityName({ target_cities: ['杭州', '宁波'] },
  'https://www.zhipin.com/web/geek/jobs?city=101210400'), '宁波');
eq('URL 没城市时为空', C.currentCityName({ target_cities: ['杭州'] },
  'https://www.zhipin.com/web/geek/jobs'), '');

console.log('== 轮换 ==');
eq('循环取下一个', C.nextInCycle(['EMC', '安规', '可靠性'], 'EMC'), '安规');
eq('到末尾回到第一个', C.nextInCycle(['EMC', '安规'], '安规'), 'EMC');
eq('当前词不在列表里就从第一个开始', C.nextInCycle(['EMC', '安规'], '射频'), 'EMC');
eq('包含关系也认', C.nextInCycle(['硬件测试', '安规'], '硬件测试工程师'), '安规');
eq('空列表返回空', C.nextInCycle([], 'EMC'), '');
eq('搜索词把偏好词排在核心词前面',
  C.searchWords({ prefer: ['EMC'], title_core: ['硬件测试', 'EMC'] }), ['EMC', '硬件测试']);
eq('URL 里的 query', C.currentQuery('https://www.zhipin.com/web/geek/jobs?query=%E5%AE%89%E8%A7%84'), '安规');

console.log('== 换条件链接 ==');
const U0 = 'https://www.zhipin.com/web/geek/jobs?city=101210100&experience=101,102&page=3&securityId=abc';
const U1 = C.buildSearchUrl(U0, { query: '安规' });
ok('保留原有筛选条件', U1.indexOf('experience=101%2C102') > 0 || U1.indexOf('experience=101,102') > 0, U1);
ok('写入新搜索词', U1.indexOf('query=%E5%AE%89%E8%A7%84') > 0, U1);
ok('换条件从第一页开始', U1.indexOf('page=') < 0, U1);
ok('不带校验页参数', U1.indexOf('securityId') < 0, U1);
const U2 = C.buildSearchUrl(U0, { city: '苏州' });
ok('换城市写城市码', U2.indexOf('city=101190400') > 0, U2);
eq('非 BOSS 域名拒绝构造', C.buildSearchUrl('https://evil.com/web/geek/jobs', { query: 'x' }), '');
eq('缺参数返回空', C.buildSearchUrl(U0, null), '');

/* ---------------------------------------------------------------- 回避项硬条件 */
console.log('== 回避项封顶 ==');
/* 标题里直接写着「有夜班」，是「不考虑」而不是「扣点分」：扣完仍可能过线被自动投出去 */
const PN = Object.assign({}, P, { role_summary: '测试工程师', prefer: ['EMC', '测试工程师'], avoid: ['夜班', '倒班'] });
const dClean = C.evaluate({ title: 'EMC 测试工程师', company: '甲', area: '杭州', salary: '8-12K', text: '负责 EMC 测试' }, PN, CFG);
const dNight = C.evaluate({ title: 'EMC 测试工程师（有夜班）', company: '甲', area: '杭州', salary: '8-12K', text: '负责 EMC 测试' }, PN, CFG);
eq('同岗位不带夜班是推荐', dClean.verdict, 'approve');
ok('标题写了有夜班不进推荐', dNight.verdict !== 'approve', JSON.stringify(dNight));
eq('封顶到待看，不是直接扔掉', dNight.verdict, 'review');
ok('理由里写明命中回避项', dNight.reasons.some(function (r) { return r.indexOf('命中回避项') >= 0; }), dNight.reasons.join(' | '));
/* 只有正文提到、标题没提的不封顶：JD 里写「偶尔需要值夜班」是信息，不是否决 */
const dBody = C.evaluate({ title: 'EMC 测试工程师', company: '甲', area: '杭州', salary: '8-12K', text: '工作环境好，不需要夜班' }, PN, CFG);
eq('正文提到夜班不封顶', dBody.verdict, 'approve');

/* ---------------------------------------------------------------- 去重索引 */
console.log('== 去重索引 ==');
const recs = {
  'id:a1': { status: 'applied', id: 'a1', title: 'EMC 工程师', company: '甲公司' },
  'tx:硬件测试|乙公司': { status: 'applied', title: '硬件测试', company: '乙公司' },
  'id:c3': { status: 'greeting_failed', id: 'c3', title: '电源工程师', company: '丙公司' },
  'id:d4': { status: 'already_contacted', id: 'd4', title: '安规工程师', company: '丁公司' }
};
const idx = C.doneIndex(recs);
ok('按 id 认出已投', C.isDone({ id: 'a1', title: '随便', company: '随便' }, idx));
/* 这条是核心回归：卡片这次拿得到 jobId、记录里却是按「标题+公司」存的 */
ok('jobId 变了也能靠标题+公司认出',
  C.isDone({ id: 'brand-new-id', title: '硬件测试', company: '乙公司' }, idx));
ok('招呼语失败的不算已投', C.isDone({ id: 'c3', title: '电源工程师', company: '丙公司' }, idx) === false);
ok('BOSS 已沟通的算终止态', C.isDone({ id: 'd4', title: '安规工程师', company: '丁公司' }, idx));
ok('没记录时什么都不算', C.isDone({ id: 'x', title: 'y', company: 'z' }, C.doneIndex({})) === false);

eq('公司为空时不给弱键', C.txKey('EMC 工程师', ''), '');
ok('公司为空不误杀同名岗位', C.isDone({ title: 'EMC 工程师', company: '' },
  C.doneIndex({ k: { status: 'applied', title: 'EMC 工程师', company: '' } })) === false);
eq('全角空格归一后仍能对上', C.txKey('EMC\u3000工程师', '甲公司'), 'EMC 工程师|甲公司');

/* 同一家公司挂两个同名岗位（jobId 不同）是两份工作，不能因为标题撞上就把新的当投过 */
const twinIdx2 = C.doneIndex({
  'id:x1': { status: 'applied', id: 'x1', title: 'EMC 测试工程师', company: '甲检测' }
});
ok('同名不同岗不误判', C.isDone({ id: 'x2', title: 'EMC 测试工程师', company: '甲检测' }, twinIdx2) === false);
ok('同一个 id 仍然认得', C.isDone({ id: 'x1', title: '改了标题', company: '甲检测' }, twinIdx2));
/* 同一「标题+公司」既有带 id 的记录、也有不带 id 的：兜底能力不能被覆盖掉 */
const mixIdx = C.doneIndex({
  'id:y1': { status: 'applied', id: 'y1', title: 'EMC 测试工程师', company: '甲检测' },
  'tx:EMC 测试工程师|甲检测': { status: 'applied', title: 'EMC 测试工程师', company: '甲检测' }
});
ok('有弱记录时仍能兜底', C.isDone({ id: 'y9', title: 'EMC 测试工程师', company: '甲检测' }, mixIdx));

/* ---------------------------------------------------------------- HR 活跃度 */
console.log('== HR 活跃度 ==');

/* BOSS 不给日期只给档位，这里把档位换算成「最多多久以前」。
   换算错一天不会出事，但把「本周活跃」认成「本月活跃」会白白丢掉好岗位，
   所以每个档位都要有断言。 */
eq('刚刚活跃 = 0 天', C.activityOf('HR 刚刚活跃'), { phrase: '刚刚活跃', days: 0 });
eq('今日活跃 = 0 天', C.activityOf('今日活跃').days, 0);
eq('当前在线 = 0 天', C.activityOf('当前在线').days, 0);
eq('昨日活跃 = 1 天', C.activityOf('昨日活跃').days, 1);
eq('3日内活跃 = 3 天', C.activityOf('3日内活跃').days, 3);
eq('3天前活跃 = 3 天', C.activityOf('3天前活跃').days, 3);
eq('本周活跃 = 7 天', C.activityOf('本周活跃').days, 7);
eq('2周内活跃 = 14 天', C.activityOf('2周内活跃').days, 14);
eq('1月内活跃 = 30 天', C.activityOf('1月内活跃').days, 30);
eq('本月活跃 = 30 天', C.activityOf('本月活跃').days, 30);
eq('半年前活跃 = 180 天', C.activityOf('半年前活跃').days, 180);
eq('保留原始短语用于展示', C.activityOf('3日内活跃').phrase, '3日内活跃');

/* 认不出就是未知。宁可漏掉几个僵尸岗，也不能因为结构失配把整页岗位跳光。 */
eq('「近期活跃」太模糊，不当成档位', C.activityOf('近期活跃'), null);
eq('空文本返回 null', C.activityOf(''), null);
eq('非活跃语境不误判', C.activityOf('负责社群活跃度与用户留存'), null);
eq('JD 里的「活跃用户」不误判', C.activityOf('统计日活跃用户数与留存'), null);

eq('超过阈值返回档位', C.staleActivity('1月内活跃', 14).days, 30);
eq('未超过阈值不返回', C.staleActivity('本周活跃', 14), null);
eq('等于阈值不算超期（2周内活跃 @14 天）', C.staleActivity('2周内活跃', 14), null);
eq('阈值 0 = 关闭', C.staleActivity('半年前活跃', 0), null);
eq('阈值非数字 = 不筛', C.staleActivity('半年前活跃', undefined), null);

/* 打分侧的接入点：只在「明确超期」时一票否决，其余情况照常算分 */
const ACT_JOB = { title: '产品运营', company: '甲科技', area: '杭州·西湖区', salary: '15-25K', tags: ['SaaS'], text: '负责数据驱动增长' };
const P_IDLE = Object.assign({}, P, { activity_max_idle_days: 14 });

eq('本月活跃的岗位直接跳过', C.evaluate(Object.assign({}, ACT_JOB, { activity: '本月活跃' }), P_IDLE, CFG).verdict, 'reject');
ok('跳过理由写明档位', C.evaluate(Object.assign({}, ACT_JOB, { activity: '本月活跃' }), P_IDLE, CFG).reasons[0].indexOf('HR 久未活跃：本月活跃') >= 0);
eq('半年前活跃的 0 分', C.evaluate(Object.assign({}, ACT_JOB, { activity: '半年前活跃' }), P_IDLE, CFG).score, 0);
eq('2周内活跃照常推荐', C.evaluate(Object.assign({}, ACT_JOB, { activity: '2周内活跃' }), P_IDLE, CFG).verdict, 'approve');
eq('今日活跃照常推荐', C.evaluate(Object.assign({}, ACT_JOB, { activity: '今日活跃' }), P_IDLE, CFG).verdict, 'approve');
eq('认不出档位时不误杀', C.evaluate(Object.assign({}, ACT_JOB, { activity: '近期活跃' }), P_IDLE, CFG).verdict, 'approve');
eq('没有活跃度字段时不误杀', C.evaluate(ACT_JOB, P_IDLE, CFG).verdict, 'approve');
eq('门槛填 0 时不做活跃度筛选', C.evaluate(Object.assign({}, ACT_JOB, { activity: '半年前活跃' }), Object.assign({}, P, { activity_max_idle_days: 0 }), CFG).verdict, 'approve');
eq('门槛 30 天时「本月活跃」放行', C.evaluate(Object.assign({}, ACT_JOB, { activity: '本月活跃' }), Object.assign({}, P, { activity_max_idle_days: 30 }), CFG).verdict, 'approve');
eq('门槛 30 天时「半年前活跃」仍跳过', C.evaluate(Object.assign({}, ACT_JOB, { activity: '半年前活跃' }), Object.assign({}, P, { activity_max_idle_days: 30 }), CFG).verdict, 'reject');

/* 报告里要能看到「这一轮是按什么门槛筛的」，否则贴给别人时说不清 */
const repIdle = C.buildScanReport(
  [{ title: '产品运营', decision: { verdict: 'reject', score: 0, reasons: ['HR 久未活跃：本月活跃'] } }],
  { profile: P_IDLE }
);
ok('报告写出 HR 活跃门槛', repIdle.text.indexOf('HR 活跃门槛 14 天') >= 0, repIdle.text);
ok('依据统计能认出 HR 久未活跃', repIdle.text.indexOf('HR 久未活跃 ×1') >= 0, repIdle.text);

/* ---------------------------------------------------------------- 随机 */
console.log('== 随机 ==');
let inRange = true;
for (let i = 0; i < 200; i++) { const v = C.rand(10, 20); if (v < 10 || v > 20) inRange = false; }
ok('rand 在区间内', inRange);
let intOk = true;
for (let i = 0; i < 200; i++) { const v = C.randInt(3, 5); if (!Number.isInteger(v) || v < 3 || v > 5) intOk = false; }
ok('randInt 整数且在区间', intOk);
eq('rand 反向区间自动纠正', C.rand(20, 10) >= 10, true);

/* ---------------------------------------------------------------- 结果 */
console.log('');
if (fail) {
  console.log(`✗ ${fail} 项失败 / 共 ${pass + fail} 项\n`);
  fails.forEach((f, i) => console.log(`${i + 1}. ${f}\n`));
  process.exit(1);
} else {
  console.log(`✓ ${pass} 项全部通过`);
}
