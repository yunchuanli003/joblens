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

/* 名字只该有一处真源：package.json 的 name。改名时最容易漏的是「对外露脸」的那几处
   —— 扩展管理页、工具栏、zip 名、CI 产物名；漏了不会报错，只会在商店或 Release 里
   露出两个名字。这里逐处比对，改回旧名会当场失败。 */
console.log('== 命名 ==');
const brand = pkg.name;
const readText = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

if (!brand) bad('package.json 缺少 name');

const mName = String(manifest.name || '');
if (mName.startsWith(brand)) ok('扩展名 ' + mName);
else bad(`manifest.name「${mName}」未以包名 ${brand} 开头`);

const dTitle = manifest.action?.default_title || '';
if (dTitle.includes(brand)) ok('工具栏标题 ' + dTitle);
else bad(`manifest.action.default_title「${dTitle}」不含包名`);

const h1 = (readmeText.match(/^#\s+(.+)$/m) || [])[1] || '';
if (h1.includes(brand)) ok('README 标题 ' + h1);
else bad(`README 一级标题「${h1}」不含包名`);

const zipRef = `${brand}-${manifest.version}.zip`;
if (readmeText.includes(zipRef)) ok('README 提到的产物名 ' + zipRef);
else bad(`README 未提到产物名 ${zipRef}（改了包名或版本？）`);

const buildSrc = readText('scripts/build.mjs');
if (/\$\{pkg\.name\}-\$\{manifest\.version\}\.zip/.test(buildSrc)) ok('打包名由 package.json 派生');
else bad('scripts/build.mjs 的 zip 名没有从 pkg.name 派生，改名时会漏');

let ciSrc = '';
try { ciSrc = readText('.github/workflows/ci.yml'); } catch (e) { ciSrc = ''; }
if (ciSrc.includes(`${brand}-unpacked`)) ok('CI 产物 ' + brand + '-unpacked');
else bad(`CI artifact 名未随包名更新（应为 ${brand}-unpacked）`);

const licHead = readText('LICENSE').split('\n').slice(0, 5).join('\n');
if (licHead.includes(brand)) ok('LICENSE 版权人含 ' + brand);
else bad('LICENSE 版权人未随包名更新');

const uiSpots = [
  ['src/content.js', `<b>${brand}</b>`, '悬浮面板标题'],
  ['src/popup.html', `<title>${brand}`, 'popup 标题'],
  ['src/options.html', `<title>${brand}`, '设置页标题']
];
for (const [file, needle, label] of uiSpots) {
  if (readText(file).includes(needle)) ok(label);
  else bad(`${file} 里的${label}未使用包名 ${brand}`);
}

if (fail.length) {
  console.log(`\n✗ ${fail.length} 项未通过`);
  process.exit(1);
}
console.log('\n✓ 自检通过');
