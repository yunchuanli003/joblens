/* boss-scout core — 纯逻辑，无 DOM / 无 chrome API 依赖，可在 Node 中直接测试 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BossCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------------------------------------------------------------- 默认配置 */

  var DEFAULTS = {
    pacing: {
      /* 「标准」档：一份 12~30 秒、每 8 份休息 1~2.5 分钟。
         原来默认 25~70 秒 + 每 5 份歇 2~6 分钟，8 份要跑十分钟，
         慢到人以为卡死；真正的风控看的是量，不是这几秒。 */
      delay_min_sec: 12,
      delay_max_sec: 30,
      rest_every: 8,
      rest_min_sec: 60,
      rest_max_sec: 150,
      jitter_ratio: 0.25,
      read_jd_min_sec: 2,
      read_jd_max_sec: 5
    },
    limits: {
      session_apply_max: 8,
      daily_apply_max: 30,
      scroll_rounds: 8,
      max_cards: 120,
      panel_wait_ms: 3000
    },
    safety: {
      consecutive_failure_limit: 3,
      read_jd_before_approve: true,
      manual_confirm: false,
      auto_start: false,
      /* false = 扩展自己按模板发招呼语；true = 只点「立即沟通」进聊天页，
         招呼语交给 BOSS 自带的自动打招呼。两套都发 = 对方收到两条。 */
      handoff_greeting: false
    },
    scoring: {
      approve_threshold: 62,
      review_threshold: 42,
      reject_keywords: [
        '保险', '贷款', '中介', '培训贷', '招聘提成', '无责底薪', '地推',
        '外包派遣', '人力资源服务', '劳务派遣', '催收', '电销'
      ]
    },
    puaMap: '0123456789'
  };

  var PROFILE_TEMPLATE = {
    role_summary: '3 年 B 端 SaaS 产品运营，想找产品运营 / 用户运营岗',
    target_cities: ['杭州'],
    min_salary_k: 12,
    /* HR 超过这么多天没活跃就跳过。BOSS 只给档位不给日期，所以这里比的是
       「档位上界」：14 天时「2周内活跃」放行、「本月活跃」和「半年前活跃」被拦。
       填 0 = 不按活跃度筛（老配置里没有这个字段时也是 0，行为不变）。 */
    activity_max_idle_days: 14,
    experience: '3 年',
    prefer: ['产品运营', '用户运营', 'SaaS', 'B 端', '数据驱动', '增长'],
    title_core: [],
    avoid: ['纯电销', '电话销售', '夜班', '轮班', '外包'],
    must_have: [],
    reject_keywords: [],
    greeting_template: ''
  };

  /* ---------------------------------------------------------------- 工具 */

  var ZERO_WIDTH = /[\u200b-\u200f\u2060\ufeff]/g;

  function clean(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(ZERO_WIDTH, '').replace(/[\s\u3000]+/g, ' ').trim();
  }

  /* ---------------------------------------------------------------- 去重 */

  /* BOSS 同一岗位在不同时刻可能给出不同形态的卡片：有时带 job_detail 链接能取到
     jobId，有时整张卡片是个 div、取不到。只用 jobId 去重，就会出现「这次存成
     id:xxx、下次算成 tx:标题|公司」，对不上 → 已投的岗位又被投一遍。
     所以两套键一起记：id 是强证据，标题+公司是兜底。 */
  function txKey(title, company) {
    var t = clean(title || '');
    var c = clean(company || '');
    if (!t || !c) return '';        // 公司为空时同标题不能当证据，宁可漏也不误杀
    return t + '|' + c;
  }

  /* 从投递记录里建索引。已投（applied）和「BOSS 显示已沟通」都算终止态：
     后者不进额度统计，但同样不该再走一遍流程。 */
  function doneIndex(records) {
    var ids = {};
    var tx = {};
    Object.keys(records || {}).forEach(function (k) {
      var r = records[k];
      if (!r) return;
      if (r.status !== 'applied' && r.status !== 'already_contacted') return;
      if (r.id) ids[String(r.id)] = 1;
      var t = txKey(r.title, r.company);
      /* 同一「标题+公司」可能有多条记录。优先留那条当初没取到 jobId 的：
         它是唯一需要靠标题兜底的，被有 id 的记录覆盖掉就兜不住了。 */
      if (t && (!tx[t] || (tx[t].id && !r.id))) tx[t] = { id: r.id || '' };
    });
    return { ids: ids, tx: tx };
  }

  function isDone(job, idx) {
    if (!job || !idx) return false;
    if (job.id && idx.ids[String(job.id)]) return true;
    var t = txKey(job.title, job.company);
    if (!t || !idx.tx[t]) return false;
    /* 那条记录自己带 jobId，说明当初认的是一份具体岗位；这次 jobId 不同
       （前面已经比过了）就是另一份工作 —— 同一家公司挂两个同名岗位很常见，
       不能因为标题撞上就把新的也当投过。只有记录当初没有 jobId 才走兜底。 */
    return !idx.tx[t].id;
  }

  function deepMerge(base, over) {
    var out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    if (!over || typeof over !== 'object') return out;
    Object.keys(over).forEach(function (k) {
      var v = over[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
        out[k] = deepMerge(base[k], v);
      } else if (v !== undefined) {
        out[k] = v;
      }
    });
    return out;
  }

  function rand(min, max) {
    if (max < min) { var t = min; min = max; max = t; }
    return min + Math.random() * (max - min);
  }

  function randInt(min, max) {
    return Math.floor(rand(min, max + 1));
  }

  /* ---------------------------------------------------------------- 字体私用区解密
   *
   * BOSS 把薪资数字替换成 U+E031..U+E03A 区间的私用区字符，配自定义字体渲染。
   * 不还原就完全读不出数字（DOM 里是一串不可见字符）。
   * 映射可能随字体下发变化，因此做成可配置的 10 位字符串。
   */

  var PUA_START = 0xE031;
  var PUA_END = 0xE03A;

  function hasPua(s) {
    if (!s) return false;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= PUA_START && c <= PUA_END) return true;
    }
    return false;
  }

  function decrypt(text, map) {
    if (!text) return '';
    var m = (map && map.length === 10) ? map : DEFAULTS.puaMap;
    var out = '';
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c >= PUA_START && c <= PUA_END) out += m.charAt(c - PUA_START);
      else out += text.charAt(i);
    }
    return out;
  }

  /* 解密结果自检：命中以下任一模式说明映射大概率错了 */
  function salarySuspect(decrypted) {
    if (!decrypted) return false;
    /* 先摘掉「·13薪」这类年终月数：它会被并进数字串，
       "8-11K·13薪" 拼成 81113，正好凑出连续的 111，把正常薪资判成解密错误。 */
    var s = String(decrypted).replace(/\s*[·•x×*]?\s*\d+\s*薪/g, '');
    var digits = s.replace(/[^\d]/g, '');
    if (digits.length >= 4) {
      if (/^(\d)\1+$/.test(digits)) return true;                 // 全同一个数字
      if (/(\d)\1\1/.test(digits)) return true;                   // 连续三个相同
    }
    if (!/\d/.test(s)) return true;
    // 月薪区间上限超过 400K 或低于 1K，基本不可能
    var r = parseSalary(s);
    if (r.ok && (r.high > 400 || r.low <= 0)) return true;
    if (r.ok && r.high < r.low) return true;
    return false;
  }

  /* ---------------------------------------------------------------- 薪资解析 */

  var UNIT_TO_K = { k: 1, K: 1, 千: 1, 万: 10, w: 1, W: 1 };

  function parseSalary(text) {
    var raw = clean(text);
    var fail = { low: 0, high: 0, ok: false, raw: raw };
    if (!raw) return fail;
    var s = raw.replace(/\s/g, '');

    var m = s.match(/(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)([Kk千万wW])/);
    if (m) {
      var u = UNIT_TO_K[m[3]] || 1;
      return { low: +(parseFloat(m[1]) * u).toFixed(1), high: +(parseFloat(m[2]) * u).toFixed(1), ok: true, raw: raw };
    }
    m = s.match(/(\d+(?:\.\d+)?)([Kk千万wW])以上/);
    if (m) {
      var u2 = UNIT_TO_K[m[2]] || 1;
      return { low: +(parseFloat(m[1]) * u2).toFixed(1), high: 999, ok: true, raw: raw };
    }
    m = s.match(/(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)元\/天/);
    if (m) {
      return {
        low: +(parseFloat(m[1]) * 22 / 1000).toFixed(1),
        high: +(parseFloat(m[2]) * 22 / 1000).toFixed(1),
        ok: true, raw: raw
      };
    }
    m = s.match(/(\d+(?:\.\d+)?)元\/(?:天|时)/);
    if (m) {
      var k = +(parseFloat(m[1]) * 22 / 1000).toFixed(1);
      return { low: k, high: k, ok: true, raw: raw };
    }
    return fail;
  }

  /* ---------------------------------------------------------------- 打分 */

  function anyIn(needles, hay) {
    if (!needles || !needles.length || !hay) return [];
    var low = hay.toLowerCase();
    return needles.filter(function (n) { return n && low.indexOf(String(n).toLowerCase()) >= 0; });
  }

  /* 否定前缀：JD 写「非外包」「无销售」「不接受派遣」「免学历」时不算命中。
     只有紧邻的 4 个字才算，避免把「非外包团队，销售支持完善」里的「销售」也否掉。 */
  var NEG_PREFIX = /[非无不免别禁]/;

  function hitSpans(needle, hay) {
    var n = String(needle == null ? '' : needle).toLowerCase();
    var h = String(hay == null ? '' : hay).toLowerCase();
    if (!n || !h) return 0;
    var count = 0;
    var from = 0;
    var idx;
    while ((idx = h.indexOf(n, from)) >= 0) {
      var pre = h.slice(Math.max(0, idx - 4), idx);
      if (!NEG_PREFIX.test(pre)) count++;
      from = idx + n.length;
    }
    return count;
  }

  /* 把命中拆成「标题命中」和「描述命中」——
     标题写着「EMC 测试工程师」是岗位本质；JD 正文提一句 EMC 只是沾边。
     同一个词在标题出现就不再重复计入描述。 */
  function splitHits(terms, title, body, seen) {
    var inTitle = [];
    var inBody = [];
    (terms || []).forEach(function (t) {
      if (!t) return;
      var key = String(t).toLowerCase();
      if (seen && seen[key]) return;
      if (hitSpans(t, title) > 0) {
        inTitle.push(t);
        if (seen) seen[key] = 1;
      } else if (hitSpans(t, body) > 0) {
        inBody.push(t);
        if (seen) seen[key] = 1;
      }
    });
    return { title: inTitle, body: inBody };
  }

  function bigrams(s) {
    var out = [];
    var seen = {};
    for (var i = 0; i < s.length - 1; i++) {
      var g = s.slice(i, i + 2);
      if (/^[\u4e00-\u9fa5]{2}$/.test(g) && !seen[g]) { seen[g] = 1; out.push(g); }
    }
    return out;
  }

  /* 求职方向的匹配片段：中文用二元组，英文/型号词单独提出来。
     原来只认二元组，「EMC 测试」只能匹配到「测试」，标题里的 EMC 完全没用上。 */
  function roleTokens(s) {
    var out = bigrams(s);
    var seen = {};
    out.forEach(function (g) { seen[g] = 1; });
    var en = String(s || '').match(/[A-Za-z][A-Za-z0-9+#.\-]{1,}/g) || [];
    en.forEach(function (t) {
      var low = t.toLowerCase();
      if (!seen[low]) { seen[low] = 1; out.push(low); }
    });
    return out;
  }

  /* ---------------------------------------------------------------- HR 活跃度 */

  /* BOSS 不写「HR 最后一次上线是几号」，只写一个档位：刚刚活跃 / 今日活跃 /
     3日内活跃 / 本周活跃 / 2周内活跃 / 本月活跃 / 半年前活跃。
     所以这里做的是「把档位换算成最多多少天以前」——它是上界不是精确值：
     「1月内活跃」可能是一小时前，也可能是 29 天前。拿它做硬筛可以接受，
     因为真正被筛掉的是「HR 已经一个月没上线」那类岗位，投过去本来也没人看。

     三条底线：
     1. 认不出 = 未知，一律放行。宁可漏掉几个僵尸岗，也不能因为一次结构失配
        把整页岗位跳光——那样用户看到的是「今天一个都不推荐」，比误投十个更糟。
     2. 只认严格句式（时间档位 + 活跃 / 在线），不认 JD 正文里的「社群活跃度」。
     3. 越靠前越先匹配：先认「半年前」「一年前」，再认带数字的通用句式。 */
  var ACTIVITY_RULES = [
    { re: /半年前活跃|半年内未活跃/, days: 180 },
    { re: /一年前活跃|1\s*年前活跃/, days: 365 },
    { re: /刚刚活跃|刚才活跃|今日活跃|今天活跃|实时活跃|当前在线|正在在线/, days: 0 },
    { re: /昨日活跃|昨天活跃/, days: 1 },
    { re: /(\d+)\s*小时前活跃/, days: 0 },
    { re: /(\d+)\s*日内活跃|(\d+)\s*天内活跃|近(\d+)\s*日活跃/, days: 'd' },
    { re: /(\d+)\s*天前活跃/, days: 'd' },
    { re: /(\d+)\s*周内活跃|近(\d+)\s*周活跃/, days: 'w' },
    { re: /(\d+)\s*周前活跃/, days: 'w' },
    { re: /本周活跃|本周内活跃|这周活跃/, days: 7 },
    { re: /(\d+)\s*个?月内活跃|近(\d+)\s*个?月活跃/, days: 'm' },
    { re: /(\d+)\s*个?月前活跃/, days: 'm' },
    { re: /本月活跃|本月内活跃|这个月活跃/, days: 30 }
  ];

  /* 从一段文字里认出「HR 最近一次活跃」的档位；认不出返回 null。
     注意「近期活跃」这种模糊说法故意不认：它可能是今天，也可能是上个月。 */
  function activityOf(text) {
    var t = clean(text || '');
    if (!t) return null;
    for (var i = 0; i < ACTIVITY_RULES.length; i++) {
      var r = ACTIVITY_RULES[i];
      var m = t.match(r.re);
      if (!m) continue;
      var days = r.days;
      if (typeof days === 'string') {
        var n = 0;
        for (var k = 1; k < m.length; k++) {
          if (m[k] !== undefined && m[k] !== '') { n = parseInt(m[k], 10); break; }
        }
        if (!(n > 0)) continue;
        days = days === 'w' ? n * 7 : (days === 'm' ? n * 30 : n);
      }
      return { phrase: clean(m[0]), days: days };
    }
    return null;
  }

  /* 超过 maxDays 天没活跃就返回那条描述，否则 null。
     maxDays <= 0 / 非数字 表示不按活跃度筛——老配置里没这个字段时就是「不筛」。 */
  function staleActivity(text, maxDays) {
    var lim = Number(maxDays);
    if (!(lim > 0)) return null;
    var a = activityOf(text);
    if (!a) return null;
    return a.days > lim ? a : null;
  }

  function evaluate(job, profile, cfg) {
    job = job || {};
    profile = profile || {};
    cfg = cfg || {};

    var title = job.title || '';
    var company = job.company || '';
    var area = job.area || '';
    var text = job.text || '';
    var tags = (job.tags || []).join(' ');
    /* 公司名单独拿出来：公司叫「杭州电源科技」不该因为名字里有「电源」就给岗位加分。
       但排除词要看公司名——「XX人力资源服务有限公司」的行业写在校名里。 */
    var body = tags + '\n' + text;
    var full = [title, company, tags, text].join('\n');

    var reasons = [];

    /* 1. 硬门槛：城市 */
    var cities = (profile.target_cities || []).filter(Boolean);
    if (cities.length && area && !cities.some(function (c) { return area.indexOf(c) >= 0; })) {
      return { verdict: 'reject', score: 0, reasons: ['城市不符（' + area + '，目标 ' + cities.join(',') + '）'] };
    }

    /* 2. 硬门槛：薪资 */
    var minK = parseFloat(profile.min_salary_k || 0);
    var sal = parseSalary(job.salary || '');
    if (minK > 0 && sal.ok) {
      if (sal.high < minK) {
        return { verdict: 'reject', score: 0, reasons: ['薪资上限 ' + sal.high + 'K 低于下限 ' + minK + 'K'] };
      }
      if (sal.low < minK) reasons.push('薪资偏低（' + sal.low + '-' + sal.high + 'K）');
    }
    if (job.salarySuspect) reasons.push('薪资解密存疑，需人工核对');

    /* 3. 黑名单（含公司名）。这里也走否定判定：
       JD 写「本岗位非外包」时不该被「外包」硬淘汰。 */
    var rejects = (cfg.reject_keywords || []).concat(profile.reject_keywords || []);
    var hits = rejects.filter(function (n) { return n && hitSpans(n, full) > 0; });
    if (hits.length) {
      return { verdict: 'reject', score: 0, reasons: ['命中排除词：' + hits.slice(0, 3).join('、')] };
    }

    /* 4. HR 活跃度：两周没上线的 HR，投过去大概率没人看。
       只对「卡片上明确写出档位」的卡片生效；认不出（含「近期活跃」）一律放行。 */
    var idle = staleActivity(job.activity, profile.activity_max_idle_days);
    if (idle) {
      return { verdict: 'reject', score: 0, reasons: ['HR 久未活跃：' + idle.phrase] };
    }

    /* 5. 标题核心词：标题里一个都没有，说明岗位名根本不是你要的方向。
       这是唯一能挡住「软件测试工程师」「电源销售」这类标题级误判的手段。 */
    var cores = (profile.title_core || []).filter(Boolean);
    var coreHits = splitHits(cores, title, '');

    /* 6. 偏好词打分：标题命中是岗位本质，描述命中只是沾边，权重必须分开 */
    var score = 50;
    var prefer = (profile.prefer || []).concat(profile.must_have || []);
    var ph = splitHits(prefer, title, body);
    if (prefer.length) {
      if (!ph.title.length && !ph.body.length) {
        score -= 20;
        reasons.push('未命中任何偏好词');
      } else {
        score += Math.min(ph.title.length * 12 + ph.body.length * 5, 36);
        if (ph.title.length) reasons.push('标题命中：' + ph.title.slice(0, 4).join('、'));
        /* 卡片阶段还没有 JD 正文，此时 body 里只有标签。写成「描述命中」会误导排查 */
        if (ph.body.length) {
          reasons.push((text ? '描述命中：' : '标签命中：') + ph.body.slice(0, 4).join('、'));
        }
      }
    }

    if (cores.length) {
      if (coreHits.title.length) {
        score += 10;
        reasons.push('岗位名对得上：' + coreHits.title.slice(0, 3).join('、'));
      } else {
        score = Math.min(score, 45);
        reasons.push('标题不含目标岗位名（' + cores.slice(0, 3).join('/') + '…）');
      }
    }

    /* 7. 回避词：标题命中扣得比描述重 */
    var ah = splitHits(profile.avoid || [], title, body);
    var avoidHits = ah.title.concat(ah.body);
    if (avoidHits.length) {
      score -= Math.min(ah.title.length * 18 + ah.body.length * 10, 45);
      reasons.push('命中回避项：' + avoidHits.slice(0, 3).join('、'));
    }

    /* 8. 必要关键词 */
    var must = profile.must_have || [];
    if (must.length) {
      var mh = splitHits(must, title, body);
      if (!mh.title.length && !mh.body.length) {
        return { verdict: 'reject', score: 0, reasons: ['缺少必要关键词：' + must.slice(0, 3).join('、')] };
      }
    }

    /* 9. 标题与求职方向的相关性（英文词也参与，原来「EMC」被整个忽略） */
    var role = clean(profile.role_summary || '');
    if (role) {
      var tl = title.toLowerCase();
      var grams = roleTokens(role);
      if (grams.some(function (g) { return tl.indexOf(g) >= 0; })) {
        score += 10;
        reasons.push('标题与求职方向相关');
      }
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    var approveAt = Number(cfg.approve_threshold || 62);
    var reviewAt = Number(cfg.review_threshold || 42);

    /* 标题里就写着「有夜班 / 两班倒」这类硬条件，是「不考虑」而不是「扣点分」：
       扣 18 分之后仍然可能过线，于是自动投过去——用户明确说了不接受，这是错投。
       封顶到「待看」：不自动投，但留在列表里，人要投还能自己点。 */
    if (ah.title.length) score = Math.min(score, approveAt - 1);

    if (score >= approveAt) return { verdict: 'approve', score: score, reasons: reasons.length ? reasons : ['综合匹配'] };
    if (score >= reviewAt) return { verdict: 'review', score: score, reasons: reasons.length ? reasons : ['需要人工判断'] };
    return { verdict: 'reject', score: score, reasons: reasons.length ? reasons : ['综合匹配度低'] };
  }

  /* ---------------------------------------------------------------- 招呼语 */

  var DEFAULT_GREETING =
    '您好，看到贵司在招「{title}」，我有{exp}相关经验，' +
    '过往做过{highlight}，和岗位要求比较契合，方便的话想和您详细聊聊，谢谢！';

  function makeGreeting(job, profile) {
    job = job || {};
    profile = profile || {};
    var tmpl = profile.greeting_template || DEFAULT_GREETING;
    var blob = (job.title || '') + '\n' + (job.text || '');
    var hits = anyIn(profile.prefer || [], blob);
    var highlight = hits.length ? hits.slice(0, 2).join('、') : (profile.role_summary || '相关业务');
    var exp = String(profile.experience || '').trim() || '相关';
    /* 默认模板后面自带「相关经验」，用户若把「经验」也写进年限会拼成「…经验相关经验」 */
    if (tmpl === DEFAULT_GREETING) exp = exp.replace(/经验\s*$/, '') || exp;
    var vars = {
      title: job.title || '',
      company: job.company || '',
      exp: exp,
      highlight: highlight,
      salary: job.salary || '',
      area: job.area || ''
    };
    var out = tmpl.replace(/\{(\w+)\}/g, function (_, k) {
      return vars[k] !== undefined ? vars[k] : '{' + k + '}';
    });
    return clean(out);
  }

  /* ---------------------------------------------------------------- 弹窗分类 */

  var POPUP_RULES = [
    { kind: 'limit', words: ['今日沟通次数已达上限', '沟通次数已达上限', '已达今日上限', '明天再来', '今日打招呼次数已用完'] },
    { kind: 'captcha', words: ['滑动验证', '拖动滑块', '请输入验证码', '安全验证', '人机验证', '完成验证', '操作过于频繁', '访问异常', '当前环境异常'] },
    { kind: 'continue', words: ['继续沟通', '留在此页', '继续上次', '继续聊天'] },
    { kind: 'greeting', words: ['发送招呼语', '打个招呼', '和TA聊聊'] }
  ];

  function classifyPopupText(text) {
    var t = clean(text);
    if (!t) return 'none';
    for (var i = 0; i < POPUP_RULES.length; i++) {
      var r = POPUP_RULES[i];
      for (var j = 0; j < r.words.length; j++) {
        if (t.indexOf(r.words[j]) >= 0) return r.kind;
      }
    }
    return 'unknown';
  }

  /* ---------------------------------------------------------------- 风控探针（URL / 标题层） */

  /* 只认 pathname，绝不看 query / hash。
   *
   * 这里踩过一个真实的坑：BOSS 的聊天页 URL 会带 securityId 之类的查询参数，
   * 早先的实现对整个 href 做 indexOf('security')，于是「点开沟通、页面跳到
   * /web/geek/chat?...securityId=...」被判定成安全验证页，一整轮投递当场中断——
   * 而屏幕上什么验证都没出现。校验页的路径是稳定的，查询参数不是。 */
  var ANOMALY_PATH = [
    ['url:verify', /\/verify(\.html)?$/],
    ['url:security', /\/security([-_]?check)?(\.html)?$/],
    ['url:captcha', /\/captcha/],
    ['url:passport', /^\/web\/passport\//]
  ];

  /* 取出 pathname：同时接受完整 URL 和裸路径 */
  function pathOf(url) {
    var s = String(url || '');
    if (s.charAt(0) === '/') return s.split(/[?#]/)[0].toLowerCase();
    var m = s.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i);
    if (m) return (m[1] || '/').toLowerCase();
    return '';
  }

  function anomalyFromLocation(url, title) {
    var path = pathOf(url);
    var hits = [];
    ANOMALY_PATH.forEach(function (e) {
      if (e[1].test(path) && hits.indexOf(e[0]) < 0) hits.push(e[0]);
    });
    var kind = classifyPopupText(title || '');
    if (kind === 'captcha' || kind === 'limit') hits.push('title:' + kind);
    return hits;
  }

  /* 扫描结果为空时给出可执行的诊断，而不是只报「0 个岗位」。
     anchors 是页面里 job_detail 链接的数量：有链接却没卡片 = 选择器失配；
     连链接都没有 = 不在岗位列表页或未登录。
     pathname 可选：带上它就能区分「在聊天页误点扫描」和「选择器挂了」——
     这两种情况要改的地方完全不同，不能给同一句话。 */
  var LIST_PATH = /^\/web\/geek\/jobs/;
  var PAGE_NAME = { chat: '聊天页', detail: '岗位详情页', home: '首页', recruit: '招聘管理页', other: '非列表页' };

  function pageKind(pathname) {
    var p = String(pathname || '');
    if (LIST_PATH.test(p)) return 'jobs';
    if (/^\/web\/geek\/chat/.test(p)) return 'chat';
    if (/^\/job_detail\//.test(p)) return 'detail';
    if (/^\/web\/geek\/recruit/.test(p)) return 'recruit';
    if (p === '' || p === '/') return 'home';
    return 'other';
  }

  /* ---------------------------------------------------------------- 换一批（拉新岗位） */

  /* 列表底部「继续翻」的控件文本。BOSS 不同版本叫法不同，判定依据只有文本，
     因为类名每次改版都在变，而「加载更多」这四个字很少变。
     控件消失本身就意味着「这个搜索到底了」，所以找不到也算一种有效信号。 */
  var MORE_WORDS = ['加载更多', '查看更多', '更多职位', '更多岗位', '点击加载', '展开更多', '查看剩余'];

  function matchMoreText(s) {
    var t = clean(s || '');
    /* 超过 12 字的一定是段落/标题块，不可能是翻页控件。
       不设这个上限，正文里出现「查看更多」也会被当成按钮点下去。 */
    if (!t || t.length > 12) return '';
    for (var i = 0; i < MORE_WORDS.length; i++) {
      if (t.indexOf(MORE_WORDS[i]) >= 0) return MORE_WORDS[i];
    }
    return '';
  }

  /* 排序页签：「推荐」换到「最新发布」就是另一批岗位 */
  var LATEST_WORDS = ['最新发布', '最新'];

  function matchLatestText(s) {
    var t = clean(s || '');
    if (!t || t.length > 6) return '';
    for (var i = 0; i < LATEST_WORDS.length; i++) {
      if (t.indexOf(LATEST_WORDS[i]) === 0) return LATEST_WORDS[i];
    }
    return '';
  }

  /* 翻不到新岗位时给的不是安慰，而是三条真能改变结果的操作。
     写死在这里而不是散在 UI 里，是为了让它能被测试盯住。 */
  var REFRESH_TIPS = [
    '换关键词：EMC → 电磁兼容 / 硬件测试 / 可靠性 / 安规，各搜一遍',
    '换城市：宁波 / 杭州 / 苏州 分别搜，别一次塞多个城市',
    '点列表上方的「最新发布」，新岗位通常排在前面'
  ];

  /* ---------------------------------------------------------------- 到底判定与换条件 */

  /* BOSS 到最后一页会在列表底部挂一句提示。看到它就别再滚了——
     无限滚动的页面滚到底不会报错，只会安静地什么都不发生，
     用户和脚本都容易误以为是「点失败了」。 */
  var END_WORDS = ['没有更多了', '没有更多岗位', '已加载全部', '已经到底', '到底了'];

  function matchEndText(s) {
    var t = clean(s || '');
    if (!t || t.length > 12) return '';
    for (var i = 0; i < END_WORDS.length; i++) {
      if (t.indexOf(END_WORDS[i]) >= 0) return END_WORDS[i];
    }
    return '';
  }

  /* 城市名 → BOSS 自己的城市码。只收录能确认的常见城市；查不到就返回空，
     调用方据此不提供「换城市」——宁可少一个按钮，也不要拼出无效 URL 把人送进空列表。 */
  var CITY_CODE = {
    '北京': '101010100', '上海': '101020100', '广州': '101280100', '深圳': '101280600',
    '杭州': '101210100', '宁波': '101210400', '南京': '101190100', '苏州': '101190400',
    '无锡': '101190200', '常州': '101190300', '合肥': '101220100', '武汉': '101200100',
    '成都': '101270100', '西安': '101110100', '东莞': '101281600', '嘉兴': '101210300'
  };

  function cityCode(name) {
    var k = clean(name);
    if (!k) return '';
    if (CITY_CODE[k]) return CITY_CODE[k];
    var hit = '';
    Object.keys(CITY_CODE).forEach(function (c) {
      if (!hit && k.indexOf(c) >= 0) hit = CITY_CODE[c];   // 允许「杭州市」「苏州工业园区」这类写法
    });
    return hit;
  }

  function cityNameOfCode(code) {
    var c = clean(code);
    var out = '';
    if (!c) return '';
    Object.keys(CITY_CODE).forEach(function (k) {
      if (!out && CITY_CODE[k] === c) out = k;
    });
    return out;
  }

  /* 画像城市里能换成城市码的那些（去重、保持顺序） */
  function usableCities(profile) {
    var out = [];
    ((profile && profile.target_cities) || []).forEach(function (c) {
      var name = clean(c);
      if (name && cityCode(name) && out.indexOf(name) < 0) out.push(name);
    });
    return out;
  }

  function currentCityName(profile, href) {
    var code = '';
    try { code = new URL(String(href)).searchParams.get('city') || ''; } catch (e) { return ''; }
    var name = cityNameOfCode(code);
    if (!name) return '';
    var list = usableCities(profile);
    for (var i = 0; i < list.length; i++) {
      if (cityCode(list[i]) === code) return list[i];
    }
    return name;
  }

  /* 循环取下一个。current 命中列表（精确或包含）就取它的下一个，
     没命中（比如现在搜的是画像之外的词）就从第一个开始。 */
  function nextInCycle(list, current) {
    var arr = [];
    (list || []).forEach(function (x) {
      var v = clean(x);
      if (v && arr.indexOf(v) < 0) arr.push(v);
    });
    if (!arr.length) return '';
    var key = clean(current).toLowerCase();
    var idx = -1, i;
    for (i = 0; i < arr.length; i++) {
      if (arr[i].toLowerCase() === key) { idx = i; break; }
    }
    if (idx < 0 && key) {
      for (i = 0; i < arr.length; i++) {
        var w = arr[i].toLowerCase();
        if (key.indexOf(w) >= 0 || w.indexOf(key) >= 0) { idx = i; break; }
      }
    }
    return arr[(idx + 1) % arr.length];
  }

  /* 能当搜索词用的词：偏好词优先，再补标题核心词 */
  function searchWords(profile) {
    var arr = [];
    ((profile && profile.prefer) || []).concat((profile && profile.title_core) || [])
      .forEach(function (w) {
        var v = clean(w);
        if (v && v.length <= 12 && arr.indexOf(v) < 0) arr.push(v);
      });
    return arr;
  }

  function currentQuery(href) {
    try { return clean(new URL(String(href)).searchParams.get('query') || ''); } catch (e) { return ''; }
  }

  /* 保留现有筛选条件（经验/学历/规模/城市），只换搜索词或城市，并从第一页重新开始。
     这是「换一批」唯一确定有效的方式：BOSS 没有换一批按钮，改条件才有新岗位。 */
  function buildSearchUrl(href, patch) {
    var u;
    try { u = new URL(String(href)); } catch (e) { return ''; }
    if (!/(^|\.)zhipin\.com$/.test(u.hostname)) return '';
    if (!patch) return '';
    if (patch.query) u.searchParams.set('query', patch.query);
    if (patch.city) {
      var code = cityCode(patch.city);
      if (!code) return '';
      u.searchParams.set('city', code);
    }
    u.searchParams.delete('page');
    u.searchParams.delete('securityId');
    return u.toString();
  }

  function scanDiagnosis(cards, anchors, anomaly, pathname) {
    if (anomaly && anomaly.length) {
      return { level: 'err', msg: '当前是安全校验页（' + anomaly.join('、') + '），请先手动完成验证再扫描' };
    }
    if (cards > 0) return null;

    var kind = pathname == null ? 'jobs' : pageKind(pathname);
    if (kind !== 'jobs') {
      return {
        level: 'warn',
        msg: '当前在' + (PAGE_NAME[kind] || '非列表页') + '（' + String(pathname || '') +
          '），不是岗位列表页 —— 打开 /web/geek/jobs 搜索岗位后再扫描'
      };
    }
    if (anchors > 0) {
      return {
        level: 'warn',
        msg: '页面有 ' + anchors + ' 个岗位链接，但没解析出卡片 —— 列表结构变了，改 src/extract.js 的 SEL 表'
      };
    }
    return {
      level: 'warn',
      msg: '没找到岗位链接：确认在 BOSS 岗位列表页（/web/geek/jobs）、已登录、列表已加载出来'
    };
  }

  /* ---------------------------------------------------------------- 扫描报告 */

  /* 把一次扫描的结果摊成可直接粘贴的纯文本。
     目的不是好看，是「人能看到判定依据、也能把整段贴回给开发定位误判」——
     所以每条都带分数、结论和理由，理由里保留命中词原文。 */
  var VERDICT_ORDER = { approve: 0, review: 1, reject: 2 };
  var VERDICT_CN = { approve: '推荐', review: '待看', reject: '跳过' };

  /* 入参既接受原始卡片（decision 嵌套），也接受已摊平的报告行 */
  function reportRowLine(n, job) {
    var d = job.decision || job;
    var bits = [job.title || '(无标题)'];
    if (job.area) bits.push(job.area);
    if (job.salary) bits.push(job.salary);
    if (job.company) bits.push(job.company);
    var reasons = (d.reasons || []).join('；');
    return [
      String(n) + '. ' + String(d.score == null ? '-' : d.score).padStart(3, ' ') +
      ' ' + (VERDICT_CN[d.verdict] || d.verdict || '?') + '  ' + bits.join(' | '),
      reasons ? '     ↳ ' + reasons : ''
    ].filter(Boolean).join('\n');
  }

  /* 判定依据分布：「跳过」的理由如果全是同一句，说明不是岗位的问题，
     是词表或搜索词的问题。这一行就是让人一眼看出该调哪边。 */
  function reasonTally(rows) {
    var m = {};
    rows.forEach(function (r) {
      (r.reasons || []).forEach(function (s) {
        var k = String(s).split('：')[0];
        if (k) m[k] = (m[k] || 0) + 1;
      });
    });
    return Object.keys(m).map(function (k) { return { k: k, n: m[k] }; })
      .sort(function (a, b) { return b.n - a.n; });
  }

  function profileLines(p, cfgRejects) {
    if (!p) return [];
    var lines = [];
    var cities = (p.target_cities || []).filter(Boolean);
    if (cities.length) lines.push('城市 ' + cities.join('、'));
    if (Number(p.min_salary_k) > 0) lines.push('薪资下限 ' + p.min_salary_k + 'K');
    if (Number(p.activity_max_idle_days) > 0) lines.push('HR 活跃门槛 ' + p.activity_max_idle_days + ' 天');

    var cores = (p.title_core || []).filter(Boolean);
    /* 标题核心词为空时也要显式写出来：它是挡住「标题级误判」的唯一手段，
       空着和「没配」在报告里必须长得不一样，否则看报告的人无从判断。 */
    lines.push('标题核心 ' + (cores.length ? cores.join('、') : '（未填）'));

    var pairs = [
      ['偏好', p.prefer],
      ['回避', p.avoid],
      ['排除', (p.reject_keywords || []).concat(cfgRejects || [])]
    ];
    pairs.forEach(function (it) {
      var seen = {};
      var list = (it[1] || []).filter(Boolean).filter(function (w) {
        if (seen[w]) return false;
        seen[w] = 1;
        return true;
      });
      if (list.length) lines.push(it[0] + ' ' + list.join('、'));
    });
    return lines;
  }

  function buildScanReport(cards, meta) {
    meta = meta || {};
    var rows = (cards || []).filter(Boolean).map(function (c) {
      var d = c.decision || {};
      return {
        id: c.id || '',
        title: c.title || '',
        company: c.company || '',
        salary: c.salary || '',
        area: c.area || '',
        tags: c.tags || [],
        score: d.score == null ? null : d.score,
        verdict: d.verdict || '',
        reasons: d.reasons || [],
        salarySuspect: !!c.salarySuspect
      };
    });

    var count = { approve: 0, review: 0, reject: 0 };
    rows.forEach(function (r) { if (count[r.verdict] != null) count[r.verdict]++; });

    var sorted = rows.slice().sort(function (a, b) {
      var ra = VERDICT_ORDER[a.verdict] == null ? 3 : VERDICT_ORDER[a.verdict];
      var rb = VERDICT_ORDER[b.verdict] == null ? 3 : VERDICT_ORDER[b.verdict];
      if (ra !== rb) return ra - rb;
      return (b.score || 0) - (a.score || 0);
    });

    var lines = [];
    lines.push('# boss-scout 扫描报告');
    if (meta.time) lines.push('时间 ' + meta.time);
    if (meta.url) lines.push('页面 ' + meta.url);

    var prof = profileLines(meta.profile, meta.rejectKeywords);
    if (prof.length) {
      lines.push('');
      lines.push('## 本次画像');
      prof.forEach(function (l) { lines.push(l); });
    }

    lines.push('');
    lines.push('卡片 ' + rows.length + '｜推荐 ' + count.approve + '｜待看 ' + count.review + '｜跳过 ' + count.reject);

    var tally = reasonTally(rows);
    if (tally.length) {
      lines.push('依据 ' + tally.slice(0, 5).map(function (t) { return t.k + ' ×' + t.n; }).join('、'));
    }

    /* 标题核心词是挡住标题级误判的唯一手段。空的就该在报告里喊出来，
       而不是让 30 分的「口腔医助」静静躺在跳过列表里。 */
    if (meta.profile && !(meta.profile.title_core || []).filter(Boolean).length) {
      lines.push('提示 标题核心词为空，标题级误判挡不住 —— 去设置页「求职画像 → 标题核心词」补上');
    }

    var groups = [
      ['approve', '推荐'],
      ['review', '待看'],
      ['reject', '跳过']
    ];
    var n = 0;
    groups.forEach(function (g) {
      var bucket = sorted.filter(function (r) { return r.verdict === g[0]; });
      if (!bucket.length) return;
      lines.push('');
      lines.push('## ' + g[1] + ' (' + bucket.length + ')');
      bucket.forEach(function (r) { lines.push(reportRowLine(++n, r)); });
    });

    var unknown = sorted.filter(function (r) { return VERDICT_ORDER[r.verdict] == null; });
    if (unknown.length) {
      lines.push('');
      lines.push('## 未打分 (' + unknown.length + ')');
      unknown.forEach(function (r) { lines.push(reportRowLine(++n, r)); });
    }

    return {
      text: lines.join('\n'),
      counts: count,
      total: rows.length,
      tally: tally,
      rows: rows
    };
  }

  return {
    DEFAULTS: DEFAULTS,
    PROFILE_TEMPLATE: PROFILE_TEMPLATE,
    PUA_START: PUA_START,
    PUA_END: PUA_END,
    clean: clean,
    deepMerge: deepMerge,
    rand: rand,
    randInt: randInt,
    hitSpans: hitSpans,
    splitHits: splitHits,
    roleTokens: roleTokens,
    hasPua: hasPua,
    decrypt: decrypt,
    salarySuspect: salarySuspect,
    parseSalary: parseSalary,
    activityOf: activityOf,
    staleActivity: staleActivity,
    evaluate: evaluate,
    makeGreeting: makeGreeting,
    txKey: txKey,
    doneIndex: doneIndex,
    isDone: isDone,
    classifyPopupText: classifyPopupText,
    scanDiagnosis: scanDiagnosis,
    pageKind: pageKind,
    matchMoreText: matchMoreText,
    matchLatestText: matchLatestText,
    matchEndText: matchEndText,
    cityCode: cityCode,
    cityNameOfCode: cityNameOfCode,
    usableCities: usableCities,
    currentCityName: currentCityName,
    currentQuery: currentQuery,
    nextInCycle: nextInCycle,
    searchWords: searchWords,
    buildSearchUrl: buildSearchUrl,
    REFRESH_TIPS: REFRESH_TIPS,
    pathOf: pathOf,
    buildScanReport: buildScanReport,
    anomalyFromLocation: anomalyFromLocation
  };
});
