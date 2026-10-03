/**
 * sticker_box 诊断日志分析器
 *   node read-sticker-log.mjs [日志路径]
 *
 * 把 debug.log 里的关键事件提取成结论：
 *   - 插件是否加载 / 工具栏按钮是否注入
 *   - 右键菜单是否命中、候选来源是什么
 *   - 表情面板是否被识别（EMOJI-PANEL-FOUND）
 *   - 所有 DOM-SNAPSHOT 里的候选签名按出现次数排序，用于校准选择器
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULT = path.join(process.env.LITELOADERQQNT_PROFILE || "", "data", "sticker_box", "debug.log");
const file = process.argv[2] || process.env.STICKER_BOX_LOG || DEFAULT;

if (!file || !fs.existsSync(file)) {
    console.log(`日志不存在: ${file || "(未指定)"}`);
    console.log("");
    console.log("用法: node read-log.mjs [日志路径]");
    console.log("  日志默认在  <LITELOADERQQNT_PROFILE>/data/sticker_box/debug.log");
    console.log("  也可以用环境变量 STICKER_BOX_LOG 指定，或在插件设置页点「打开日志」。");
    console.log("");
    console.log("日志不存在通常意味着插件还没被加载过（QQ 没重启，或 main.js 加载失败）。");
    process.exit(0);
}

const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
const lines = raw.split(/\r?\n/).filter(Boolean);
console.log(`日志: ${file}`);
console.log(`共 ${lines.length} 行，${(raw.length / 1024).toFixed(1)} KB\n`);

// 分类顺序很重要：先判专项，最后才落到宽泛的 [renderer]
const buckets = {
    BOOT: [],
    LOAD: [],
    RENDERER: [],
    INJECT: [],
    CTX: [],
    SAVE: [],
    PANEL_FOUND: [],
    SNAPSHOT: [],
    OTHER: []
};

const PATTERNS = [
    ["BOOT", /\[BOOT\]/],
    ["PANEL_FOUND", /EMOJI-PANEL-FOUND/],
    ["SNAPSHOT", /DOM-SNAPSHOT|EMOJI-SCAN|VUE-SCAN/],
    ["CTX", /右键菜单/],
    ["SAVE", /入库|收到入库请求|全部候选来源都失败/],
    ["INJECT", /工具栏按钮已注入|监视已启动|诊断采集已启动/],
    ["LOAD", /插件加载|库目录:|LiteLoader:|Electron:/],
    ["RENDERER", /\[renderer\]/]
];

for (const line of lines) {
    const hit = PATTERNS.find(([, re]) => re.test(line));
    (hit ? buckets[hit[0]] : buckets.OTHER).push(line);
}

const section = (title, arr, limit = 14) => {
    console.log(`===== ${title} (${arr.length}) =====`);
    if (!arr.length) console.log("  (无)");
    else for (const l of arr.slice(-limit)) console.log("  " + l.replace(/^\[[^\]]+\]\s*/, ""));
    console.log();
};

section("启动痕迹 BOOT", buckets.BOOT, 3);
section("主进程加载", buckets.LOAD, 8);
section("注入情况", buckets.INJECT, 6);
section("右键菜单", buckets.CTX, 10);
section("入库", buckets.SAVE, 14);
section("渲染进程其它消息", buckets.RENDERER, 25);

console.log("===== 表情面板识别 =====");
if (!buckets.PANEL_FOUND.length) {
    console.log("  ✗ 没有 EMOJI-PANEL-FOUND —— 自动识别未命中，用下面的候选聚合校准\n");
} else {
    for (const l of buckets.PANEL_FOUND) {
        const m = /EMOJI-PANEL-FOUND\s*(\{.*)$/.exec(l);
        if (!m) {
            console.log("  " + l);
            continue;
        }
        try {
            const o = JSON.parse(m[1]);
            // 日志里用的是 describeEl 的 sig 结构；两种形状都兼容，避免又打印出 undefined
            const name = o.sig || `${o.tag || "?"}.${o.cls || ""}${o.id ? "#" + o.id : ""}`;
            const kids = o.kids || o.children || [];
            console.log(`  ✓ 命中: ${name}   ${o.w}x${o.h}   imgs=${o.imgs}`);
            if (o.anchor) {
                console.log(`     相对输入区: inputTop=${o.anchor.inputTop} inputH=${o.anchor.inputH} 间隙=${o.anchor.gap}px`);
            }
            if (kids.length) console.log(`     子元素: ${kids.join("  |  ")}`);
        } catch (e) {
            console.log("  " + l);
        }
    }
    console.log();
}

// ---- 快照聚合 ----
const sigCount = new Map();
const sigInfo = new Map();
const feed = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const c of arr) {
        if (!c || !c.sig) continue;
        sigCount.set(c.sig, (sigCount.get(c.sig) || 0) + 1);
        if (!sigInfo.has(c.sig) || (c.imgs || 0) > (sigInfo.get(c.sig).imgs || 0)) sigInfo.set(c.sig, c);
    }
};

for (const l of buckets.SNAPSHOT) {
    if (l.includes("DOM-SNAPSHOT-HISTORY")) {
        const m = /DOM-SNAPSHOT-HISTORY[^(]*\([^)]*\)\s*(\[.*)$/.exec(l);
        if (m) {
            try {
                feed(JSON.parse(m[1]));
            } catch (e) {
                /* ignore */
            }
        }
        continue;
    }
    const m = /DOM-SNAPSHOT(?:\([^)]*\))?\s*(\[.*)$/.exec(l);
    if (m) {
        try {
            feed(JSON.parse(m[1]));
        } catch (e) {
            /* ignore */
        }
    }
}

console.log("===== 浮层候选聚合（按出现次数，imgs 越多越可能是表情面板） =====");
if (!sigCount.size) {
    console.log("  (无候选记录)");
} else {
    for (const [sig, n] of [...sigCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
        const info = sigInfo.get(sig);
        console.log(`  x${String(n).padStart(3)}  imgs=${String(info.imgs).padStart(3)}  ${String(info.w) + "x" + info.h}  ${sig}`);
        if (info.kids?.length) console.log(`          子元素: ${info.kids.join(" | ")}`);
    }
}

section("未分类", buckets.OTHER, 15);
