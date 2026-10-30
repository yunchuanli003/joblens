/* 提交前自检：node scripts/check.mjs
 *
 * 三件最容易在「改完能跑」之后悄悄坏掉的事：
 *   1. 语法错误（扩展加载失败，但测试只跑 tests 覆盖到的文件）
 *   2. manifest 指向的文件不存在（加载时直接报「无法加载扩展」）
 *   3. 版本号三处不一致（manifest / package.json / 打包名）
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = [];
const ok = (msg) => console.log('  ✓ ' + msg);
const bad = (msg) => { fail.push(msg); console.log('  ✗ ' + msg); };

const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

console.log('== 语法 ==');
const srcDir = path.join(ROOT, 'src');
for (const name of fs.readdirSync(srcDir).filter((n) => n.endsWith('.js')).sort()) {
  try {
    execFileSync(process.execPath, ['--check', path.join(srcDir, name)], { stdio: 'pipe' });
    ok('src/' + name);
  } catch (e) {
    bad('src/' + name + ' 语法错误\n' + String(e.stderr || e.message));
  }
}

console.log('== manifest ==');
const manifest = readJson('manifest.json');
manifest.content_scripts?.forEach((cs) => {
  (cs.js || []).forEach((p) => {
    if (fs.existsSync(path.join(ROOT, p))) ok(p);
    else bad('manifest 引用了不存在的文件：' + p);
  });
});
['background.service_worker', 'action.default_popup', 'options_page'].forEach((key) => {
  const p = key.split('.').reduce((o, k) => (o ? o[k] : undefined), manifest);
  if (!p) return;
  if (fs.existsSync(path.join(ROOT, p))) ok(p);
  else bad('manifest.' + key + ' 指向的文件不存在：' + p);
});
(manifest.permissions || []).forEach((p) => {
  if (['storage', 'tabs', 'scripting'].includes(p)) ok('权限 ' + p);
  else bad('多出来的权限：' + p + '（每加一个都要在 README 里说明用途）');
});

console.log('== 版本 ==');
const pkg = readJson('package.json');
if (manifest.version === pkg.version) ok('manifest 与 package.json 同为 ' + manifest.version);
else bad(`版本不一致：manifest ${manifest.version} / package.json ${pkg.version}`);

/* lock 的 version 不会随 package.json 自动改，最容易在发版时漏掉 */
const lock = readJson('package-lock.json');
const lockRoot = lock.packages?.['']?.version || lock.version;
if (lock.version === pkg.version && lockRoot === pkg.version) ok('package-lock.json 同步 ' + pkg.version);
else bad(`package-lock.json 版本落后：${lock.version} / ${lockRoot}，应为 ${pkg.version}`);

console.log('== 文档 ==');
if (pkg.license === 'MIT' && fs.existsSync(path.join(ROOT, 'LICENSE'))) ok('LICENSE（MIT）');
else bad('LICENSE 缺失或 package.json 的 license 不是 MIT');

/* 文档经常被挪来挪去，链接比内容更容易先坏。只查相对路径的 .md / 目录，
   http(s) 链接不联网校验（自检必须是离线的）。 */
const docs = ['README.md', 'CHANGELOG.md', 'docs/USAGE.md', 'docs/ARCHITECTURE.md', 'docs/DESIGN.md'];
let links = 0;
for (const doc of docs) {
  const full = path.join(ROOT, doc);
  if (!fs.existsSync(full)) { bad('缺少文档：' + doc); continue; }
  const text = fs.readFileSync(full, 'utf8');
  const re = /\]\(([^)\s]+\.(?:md|json|js|mjs)|[^)\s]+\/)\)/g;
  let m;
  while ((m = re.exec(text))) {
    const href = m[1];
    if (/^(https?:|mailto:|#)/.test(href)) continue;
    links++;
    const target = path.resolve(path.dirname(full), href.replace(/[?#].*$/, ''));
    if (!fs.existsSync(target)) bad(`${doc} 里的链接指向不存在的路径：${href}`);
  }
}
ok(`相对链接 ${links} 条全部可达`);

/* 徽章是这个仓库唯一会被外部看到、又没人负责同步的地方：
   版本号对不上 manifest 就是明摆着的疏漏；测试数没法在这里重跑（flow 要两分钟），
   所以只做「声明了没」的提醒，改动测试后请手动同步。 */
const readmeText = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const badgeVer = (readmeText.match(/version-(\d+\.\d+\.\d+)-/) || [])[1];
if (!badgeVer) bad('README 徽章缺少 version-x.y.z');
else if (badgeVer !== manifest.version) bad(`README 徽章版本 ${badgeVer} 与 manifest ${manifest.version} 不一致`);
else ok('README 徽章版本 ' + badgeVer);

const declared = (readmeText.match(/tests-(\d+)%20passed/) || [])[1];
if (!declared) bad('README 徽章缺少 tests-N passed');
else ok(`README 声明测试数 ${declared}（改了测试记得同步徽章与 CHANGELOG）`);

if (fail.length) {
  console.log(`\n✗ ${fail.length} 项未通过`);
  process.exit(1);
}
console.log('\n✓ 自检通过');
