/* 打包脚本：node scripts/build.mjs
 *
 * 只做一件事：把扩展本体复制进 dist/unpacked/。
 * 产出一个只含必需文件的干净目录（不含 README、docs、tests），
 * 可直接「加载已解压的扩展程序」，也可整目录上传商店。
 *
 * 为什么不产出 zip：
 *   扩展没有编译步骤，仓库根目录本身就是可加载的扩展——
 *   Chrome 只读 manifest.json 和它引用的文件，README 和 docs 不会被加载。
 *   再打一个 zip 只是多出第二份副本，还得保证它和源码同步，
 *   而它唯一的作用（给不装 Node 的人下载）已经被「克隆仓库」覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

/* 只复制这些，测试/文档/依赖都不进产物 */
const INCLUDE = ['manifest.json', 'icons', 'src'];

function walk(dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, base, out);
    else out.push({ full, rel: path.relative(base, full).split(path.sep).join('/') });
  }
  return out;
}

function collect() {
  const files = [];
  for (const entry of INCLUDE) {
    const target = path.join(ROOT, entry);
    if (!fs.existsSync(target)) throw new Error('缺少 ' + entry);
    const st = fs.statSync(target);
    if (st.isDirectory()) files.push(...walk(target, ROOT));
    else files.push({ full: target, rel: entry });
  }
  return files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

/* ---------------------------------------------------------------- main */

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const files = collect();

fs.rmSync(DIST, { recursive: true, force: true });

for (const f of files) {
  const dest = path.join(DIST, 'unpacked', f.rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(f.full, dest);
}

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
const total = files.reduce((s, f) => s + fs.statSync(f.full).size, 0);
console.log(`版本 ${manifest.version}`);
console.log(`文件 ${files.length} 个，源 ${kb(total)}`);
console.log('产出 dist/unpacked/（可直接加载）');
