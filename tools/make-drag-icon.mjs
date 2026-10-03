/**
 * 生成 assets/drag-icon.png —— 拖拽时用的兜底图标
 *
 * 为什么需要它：webContents.startDrag() 要求图标**非空**，而 Electron 的 nativeImage
 * 只能解码 PNG/JPEG。拖 GIF/WebP 时 createFromBuffer 会返回空图，
 * 结果 startDrag 完全不生效（表现为"动图根本拖不动"）。
 * 所以必须准备一个永远可用的图标文件。
 *
 * 手写 PNG 编码：签名 + IHDR + IDAT(zlib) + IEND，每块带 CRC32。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const OUT = path.join(HERE, "..", "sticker_box", "assets", "drag-icon.png");

const SIZE = 48;

// ---- CRC32 ----
const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();
function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
}

// ---- 画图 ----
// 圆角方块 + 白色五角星，中心 (SIZE/2, SIZE/2)
const cx = SIZE / 2;
const cy = SIZE / 2;
const r = SIZE / 2 - 2;

function inRoundedSquare(x, y) {
    const half = r;
    const corner = 10;
    const dx = Math.abs(x - cx);
    const dy = Math.abs(y - cy);
    if (dx <= half - corner || dy <= half - corner) return dx <= half && dy <= half;
    const ox = dx - (half - corner);
    const oy = dy - (half - corner);
    return ox * ox + oy * oy <= corner * corner;
}

// 五角星多边形（外半径 R，内半径 r*0.42），射线法判断点是否在内
const STAR_R = SIZE * 0.32;
const STAR_R2 = STAR_R * 0.45;
const starPts = [];
for (let i = 0; i < 10; i++) {
    const ang = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 === 0 ? STAR_R : STAR_R2;
    starPts.push([cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad]);
}
function inStar(x, y) {
    let inside = false;
    for (let i = 0, j = starPts.length - 1; i < starPts.length; j = i++) {
        const [xi, yi] = starPts[i];
        const [xj, yj] = starPts[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
for (let y = 0; y < SIZE; y++) {
    const rowStart = y * (1 + SIZE * 4);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < SIZE; x++) {
        const o = rowStart + 1 + x * 4;
        const px = x + 0.5;
        const py = y + 0.5;
        if (inStar(px, py)) {
            raw[o] = 255;
            raw[o + 1] = 255;
            raw[o + 2] = 255;
            raw[o + 3] = 255;
        } else if (inRoundedSquare(px, py)) {
            raw[o] = 0x3b;
            raw[o + 1] = 0x82;
            raw[o + 2] = 0xf6;
            raw[o + 3] = 235;
        } else {
            raw[o + 3] = 0; // 全透明
        }
    }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
]);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, png);
console.log(`已生成 ${OUT}  ${png.length} 字节  ${SIZE}x${SIZE}`);
console.log("base64: " + png.toString("base64"));
