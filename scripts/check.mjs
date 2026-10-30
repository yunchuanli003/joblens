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

if (fail.length) {
  console.log(`\n✗ ${fail.length} 项未通过`);
  process.exit(1);
}
console.log('\n✓ 自检通过');
