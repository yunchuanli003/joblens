#!/usr/bin/env node
/* 生成 examples/ 里的示例报告：node scripts/sample.mjs
 *
 * 为什么用脚本跑、而不是把结果直接写进仓库：
 *   手写的示例报告会在下一次改规则时和 src/core.js 的真实输出分家，而读它的人
 *   没有任何依据判断哪一边是对的。所以这里真跑一遍 evaluate() 和 buildScanReport()。
 *
 * 确定性：不读系统时间、不用随机数，页面时间取自 jobs.sample.json。
 *   否则 `--check` 会因为时间戳漂移天天误报，那样的检查最后一定会被关掉。
 *
 * 加 --check 时不写盘，只重新生成一遍逐字节比对，供 CI 使用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EX = path.join(ROOT, 'examples');
const require = createRequire(import.meta.url);

/* core.js 是 UMD：在扩展里挂 window.BossCore，在 Node 里走 module.exports。
   扩展开发和测试用的是同一份文件，这里也不例外。 */
const Core = require(path.join(ROOT, 'src/core.js'));

const CHECK = process.argv.includes('--check');

const readJson = (name) => JSON.parse(fs.readFileSync(path.join(EX, name), 'utf8'));
/* 下划线开头的是给人看的说明，不进入输出，避免干扰阅读报告的人 */
const dropNotes = (obj) => Object.fromEntries(
  Object.entries(obj).filter(([k]) => !k.startsWith('_'))
);

const profile = dropNotes(readJson('profile.sample.json'));
const bundle = readJson('jobs.sample.json');

/* 直接用 DEFAULTS，不在示例里复制一份阈值：复制出来的那份迟早会和真源不一致，
   而且会让「示例为什么是 62 分」多出一个要单独维护的解释。 */
const scoring = Core.DEFAULTS.scoring;

const cards = bundle.jobs.map((job) => {
  const decision = Core.evaluate(job, profile, scoring);
  return { job, decision };
});

const rep = Core.buildScanReport(
  cards.map((c) => Object.assign({}, c.job, { decision: c.decision })),
  {
    url: bundle.page.url,
    time: bundle.page.captured_at,
    profile,
    rejectKeywords: scoring.reject_keywords
  }
);

/* 键顺序在这里是显式写死的：JSON.stringify 保留插入顺序，
   这样重新生成不会因为字段顺序变化产生假 diff。 */
const json = {
  _note: '由 scripts/sample.mjs 真实调用 src/core.js 生成，请勿手改；改完跑 npm run sample',
  source: {
    profile: 'examples/profile.sample.json',
    jobs: 'examples/jobs.sample.json',
    page: bundle.page
  },
  thresholds: {
    approve: scoring.approve_threshold,
    review: scoring.review_threshold
  },
  counts: rep.counts,
  total: rep.total,
  cards: cards.map(({ job, decision }) => ({
    id: job.id,
    title: job.title,
    company: job.company,
    area: job.area,
    salary: job.salary,
    activity: job.activity || '',
    tags: job.tags || [],
    text: job.text || '',
    decision: {
      verdict: decision.verdict,
      score: decision.score,
      reasons: decision.reasons
    }
  }))
};

const outputs = [
  ['report.sample.md', rep.text + '\n'],
  ['report.sample.json', JSON.stringify(json, null, 2) + '\n']
];

if (CHECK) {
  let drift = 0;
  for (const [name, body] of outputs) {
    const p = path.join(EX, name);
    const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    if (cur === body) {
      console.log('  ✓ examples/' + name + ' 与规则当前输出一致');
    } else {
      drift++;
      console.log('  ✗ examples/' + name + ' 与规则当前输出不一致（跑 npm run sample 重新生成）');
    }
  }
  if (drift) process.exit(1);
  console.log('✓ 示例数据与规则一致（' + rep.total + ' 个岗位）');
} else {
  fs.mkdirSync(EX, { recursive: true });
  for (const [name, body] of outputs) {
    fs.writeFileSync(path.join(EX, name), body);
  }
  console.log('已生成 examples/：');
  outputs.forEach(([name]) => console.log('  examples/' + name));
  console.log(
    '\n卡片 ' + rep.total +
    '｜推荐 ' + rep.counts.approve +
    '｜待看 ' + rep.counts.review +
    '｜跳过 ' + rep.counts.reject
  );
  cards
    .slice()
    .sort((a, b) => b.decision.score - a.decision.score)
    .forEach(({ job, decision }) => {
      console.log(
        '  ' + String(decision.score).padStart(3, ' ') + '  ' +
        decision.verdict.padEnd(7, ' ') + '  ' +
        job.title + ' — ' + job.company + '（' + job.area + '）'
      );
    });
}
