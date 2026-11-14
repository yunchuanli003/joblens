"""生成扩展图标（纯标准库，无 Pillow 依赖）。"""
import zlib
import struct
import math
import os


def chunk(tag, data):
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)


def write_png(path, w, h, rgba_rows):
    raw = b''
    for row in rgba_rows:
        raw += b'\x00' + b''.join(bytes(p) for p in row)
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def make(size, ss=4):
    S = size * ss
    c1 = (37, 99, 235)
    c2 = (29, 58, 138)
    r = S * 0.23
    cx = cy = S / 2

    rows = []
    for py in range(S):
        row = []
        for px in range(S):
            dx = max(r - px, px - (S - r), 0)
            dy = max(r - py, py - (S - r), 0)
            if math.hypot(dx, dy) > r:
                row.append((0, 0, 0, 0))
                continue
            base = lerp(c1, c2, py / S)
            d = math.hypot(px - cx, py - cy) / S
            if abs(d - 0.335) < 0.030:
                base = (255, 255, 255)
            elif abs(d - 0.225) < 0.030:
                base = (147, 197, 253)
            elif d < 0.085:
                base = (255, 255, 255)
            row.append((base[0], base[1], base[2], 255))
        rows.append(row)

    out = []
    for y in range(size):
        row = []
        for x in range(size):
            acc = [0, 0, 0, 0]
            for j in range(ss):
                for i in range(ss):
                    p = rows[y * ss + j][x * ss + i]
                    for k in range(4):
                        acc[k] += p[k]
            n = ss * ss
            row.append(tuple(v // n for v in acc))
        out.append(row)
    return out


if __name__ == '__main__':
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons')
    os.makedirs(out_dir, exist_ok=True)
    for sz in (16, 48, 128):
        p = os.path.join(out_dir, f'icon{sz}.png')
        write_png(p, sz, sz, make(sz))
        print(f'{p}  {os.path.getsize(p)} bytes')
