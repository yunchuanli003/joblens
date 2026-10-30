/* 打包脚本：node scripts/build.mjs
 *
 * 只做两件事，不引入构建工具链（扩展本身没有编译步骤，加 webpack 只是负担）：
 *   1. dist/            可直接「加载已解压的扩展程序」的目录
 *   2. dist/*.zip       可直接拖进 chrome://extensions 或上传商店的压缩包
 *
 * zip 是手写的（store/deflate + central directory），避免为了打个包再装一个依赖。
 */
import { deflateRawSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

/* 只打这些，测试/文档/依赖都不进包 */
const INCLUDE = ['manifest.json', 'icons', 'src'];

/* ---------------------------------------------------------------- CRC32 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ---------------------------------------------------------------- 收集文件 */

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

/* ---------------------------------------------------------------- zip */

/* 固定时间戳：同样的源码要打出字节一致的包，方便 diff / 校验 */
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const raw = fs.readFileSync(e.full);
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const name = Buffer.from(e.rel, 'utf8');
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);        // version made by
    central.writeUInt16LE(20, 6);        // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);        // extra
    central.writeUInt16LE(0, 32);        // comment
    central.writeUInt16LE(0, 34);        // disk
    central.writeUInt16LE(0, 36);        // internal attrs
    central.writeUInt32LE(0, 38);        // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/* ---------------------------------------------------------------- main */

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const files = collect();

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

for (const f of files) {
  const dest = path.join(DIST, 'unpacked', f.rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(f.full, dest);
}

const zipName = `boss-scout-${manifest.version}.zip`;
fs.writeFileSync(path.join(DIST, zipName), zip(files));

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
const total = files.reduce((s, f) => s + fs.statSync(f.full).size, 0);
console.log(`版本 ${manifest.version}`);
console.log(`文件 ${files.length} 个，源 ${kb(total)}`);
console.log(`产出 dist/unpacked/ 与 dist/${zipName}`);
