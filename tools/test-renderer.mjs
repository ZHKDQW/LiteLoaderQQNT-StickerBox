/**
 * sticker_box 渲染进程测试台
 *   node test-sticker-renderer.mjs
 *
 * 思路：用 jsdom 造一个「像 QQ」的 DOM，把真实的 renderer.js 放进去执行
 * （只把 `export ` 关键字剥掉，其余逻辑一行不改），从而验证：
 *   1. 模块加载、样式注入、工具栏按钮注入
 *   2. 右键菜单：捕获目标 -> 注入条目 -> 点击 -> 调用 saveCandidates（含 appimg:// 原始属性）
 *   3. 表情面板：几何识别 -> 注入入口 -> 点击打开库面板
 *   4. 库面板：列表渲染 -> 点击表情 -> fetch(local:///) -> 向编辑器派发 paste
 *   5. 设置页渲染与按钮绑定
 *
 * jsdom 不实现的（布局、elementFromPoint、DataTransfer/ClipboardEvent）在这里补桩。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const RENDERER = path.join(HERE, "..", "renderer.js");
// 只是个假的插件目录：用来构造 local:// 链接，不需要真实存在
const PLUGIN_DIR = "C:\\LiteLoaderQQNT\\plugins\\sticker_box";

let pass = 0;
let fail = 0;
const ok = (m) => {
    pass++;
    console.log("  \u2713 " + m);
};
const bad = (m) => {
    fail++;
    console.log("  \u2717 " + m);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 造 DOM

const HTML = `<!doctype html><html><head></head><body>
<div id="app">
  <div class="chat-input-area">
    <div class="chat-func-bar">
      <div class="func-bar"></div>
      <div class="func-bar">
        <div class="bar-icon"><i class="q-icon"></i></div>
        <div class="bar-icon"><i class="q-icon"></i></div>
      </div>
    </div>
    <div class="ck ck-content ck-editor__editable" contenteditable="true"></div>
  </div>
  <div class="chat-msg-area__vlist ml-list list">
    <div class="message"><img class="image-content" src="appimg://C%3A%2Fpics%2F%E8%A1%A8%E6%83%85%231.png"></div>
  </div>
</div>
</body></html>`;

const dom = new JSDOM(HTML, { runScripts: "outside-only", pretendToBeVisual: true, url: "https://ti.qq.com/" });
const { window } = dom;
const doc = window.document;

// ---- 布局桩：jsdom 没有布局，用注册表伪造 rect ----
const rects = new Map();
const setRect = (el, x, y, w, h) => rects.set(el, { x, y, w, h });window.Element.prototype.getBoundingClientRect = function () {
    const r = rects.get(this) || { x: 0, y: 0, w: 0, h: 0 };
    return {
        x: r.x,
        y: r.y,
        left: r.x,
        top: r.y,
        width: r.w,
        height: r.h,
        right: r.x + r.w,
        bottom: r.y + r.h,
        toJSON() {}
    };
};
Object.defineProperty(window.Element.prototype, "offsetWidth", { get() { return (rects.get(this) || { w: 0 }).w; } });
Object.defineProperty(window.Element.prototype, "offsetHeight", { get() { return (rects.get(this) || { h: 0 }).h; } });
Object.defineProperty(window.HTMLElement.prototype, "offsetParent", { get() { return rects.has(this) ? this.parentElement : null; } });

// 统计布局查询次数：用来给「热路径里不许有 getBoundingClientRect」立规矩
let rectCalls = 0;
const origGetRect = window.Element.prototype.getBoundingClientRect;
window.Element.prototype.getBoundingClientRect = function (...a) {
    rectCalls++;
    return origGetRect.apply(this, a);
};

// 统计 MutationObserver 的创建次数：这个插件现在一个都不该创建
// （常驻观察器是之前把 QQ 拖死的原因之一）
let moCount = 0;
const OrigMO = window.MutationObserver;
window.MutationObserver = function (...args) {
    moCount++;
    return new OrigMO(...args);
};
window.MutationObserver.prototype = OrigMO.prototype;

window.document.elementFromPoint = (x, y) => {
    // 真实浏览器返回「最上层」元素；这里用「面积最小的命中元素」近似（越深层的元素通常越小）。
    // 必须跳过已从 DOM 移除的元素 —— 否则被移除的弹窗还会被命中，真实浏览器不会这样。
    let hit = null;
    let bestArea = Infinity;
    for (const [el, r] of rects) {
        if (!el.isConnected) continue;
        if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
            const area = r.w * r.h;
            if (area <= bestArea) {
                bestArea = area;
                hit = el;
            }
        }
    }
    return hit;
};

// ---- 事件/API 桩 ----
const dispatchedPastes = [];
const fetchCalls = [];
const logLines = [];

class DTShim {
    constructor() {
        this.items = { add: (f) => this.items._files.push(f), _files: [] };
        this.files = this.items._files;
    }
}
class ClipboardEventShim extends window.Event {
    constructor(type, init = {}) {
        super(type, init);
        this.clipboardData = init.clipboardData || null;
    }
}
class DragEventShim extends window.Event {
    constructor(type, init = {}) {
        super(type, init);
        this.dataTransfer = init.dataTransfer || null;
    }
}
// jsdom 没有这几样，rasterizeToPng 要用
window.createImageBitmap = async () => ({ width: 8, height: 8, close: () => {} });
window.HTMLCanvasElement.prototype.getContext = function () {
    return { drawImage: () => {} };
};
window.HTMLCanvasElement.prototype.toBlob = function (cb) {
    cb(new window.Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }));
};
window.DataTransfer = DTShim;
window.ClipboardEvent = ClipboardEventShim;
window.DragEvent = DragEventShim;
window.fetch = async (url) => {
    fetchCalls.push(String(url));
    return {
        ok: true,
        text: async () => "/* fake css */".repeat(20),
        blob: async () => new window.Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" })
    };
};

// 编辑器上挂监听，验证 paste 真的发出去了，并抓出 File 上有没有挂真实磁盘路径
const pastedFileInfo = [];
setTimeout(() => {
    const ed = doc.querySelector(".ck-editor__editable");
    if (ed) {
        ed.addEventListener("paste", (e) => {
            dispatchedPastes.push(e);
            const f = e.clipboardData && e.clipboardData.files && e.clipboardData.files[0];
            pastedFileInfo.push(f ? { name: f.name, size: f.size, path: f.path } : null);
        });
        ed.addEventListener("drop", (e) => dispatchedPastes.push(e));
    }
}, 0);

// ---- 插件 API 桩 ----
const apiCalls = [];
const LIB = [
    { name: "表情A.png", size: 1024, mtime: 1, addedAt: 3, url: "local:///C:/lib/%E8%A1%A8%E6%83%85A.png", filePath: "C:\\lib\\表情A.png" },
    { name: "表情B.gif", size: 2048, mtime: 1, addedAt: 2, url: "local:///C:/lib/%E8%A1%A8%E6%83%85B.gif", filePath: "C:\\lib\\表情B.gif" },
    { name: "表情C.webp", size: 512, mtime: 1, addedAt: 1, url: "local:///C:/lib/%E8%A1%A8%E6%83%85C.webp", filePath: "C:\\lib\\表情C.webp" }
];
const mk = (name, impl) => {
    window.sticker_box[name] = (...args) => {
        apiCalls.push({ name, args });
        return Promise.resolve(impl ? impl(...args) : undefined);
    };
};
window.sticker_box = {};
mk("getConfig", () => ({ libraryPathResolved: "C:\\lib", closeAfterInsert: false, panelEntry: true, dedupe: true }));
mk("setConfig", (p) => ({ libraryPathResolved: "C:\\lib", closeAfterInsert: false, panelEntry: true, ...p }));
mk("list", () => LIB);
mk("stats", () => ({ count: LIB.length, bytes: 3584, libraryPath: "C:\\lib" }));
mk("log", (m) => {
    logLines.push(String(m));
});
mk("saveCandidates", () => ({ ok: true, name: "存入的.png" }));
mk("importFolder", () => ({ ok: true, added: 5, duplicated: 1, failed: [] }));
mk("importFiles", () => ({ ok: true, added: 1, duplicated: 0, failed: [] }));
mk("remove", () => ({ ok: true, removed: 1 }));
mk("rename", () => ({ ok: true, name: "新名字.png" }));
mk("readFile", (name) => ({
    ok: true,
    name,
    type: "image/png",
    size: 4,
    buffer: new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer
}));
let pasteFileUnsupported = false;
mk("pasteFile", (name) =>
    pasteFileUnsupported ? { ok: false, unsupported: true, error: "该格式无法放进图片剪贴板" } : { ok: true, size: { width: 32, height: 32, bytes: 4 } }
);
mk("pastePng", () => ({ ok: true, size: { width: 32, height: 32, bytes: 4 } }));
mk("startDrag", () => ({ ok: true }));
mk("chooseLibrary", () => ({ ok: true, libraryPath: "D:\\newlib" }));
mk("openLibrary", () => ({ ok: true }));
mk("reveal", () => ({ ok: true }));
mk("clearLibrary", () => ({ ok: true, removed: 3 }));
mk("openLog", () => ({ ok: true }));
mk("openPath", () => ({ ok: true }));

window.LiteLoader = {
    plugins: { sticker_box: { path: { plugin: PLUGIN_DIR }, manifest: { version: "0.1.0" } } },
    versions: { liteloader: "1.4.1", qqnt: "9.9.25-42941" },
    api: { openExternal: () => {}, config: { get: async () => ({}), set: async () => ({}) } }
};

// ---------------------------------------------------------------- 执行真实的 renderer.js

const src = fs.readFileSync(RENDERER, "utf8");
const stripped = src.replace(/^export\s+/gm, "");
const wrapped =
    stripped +
    "\n;globalThis.__hooks = {" +
    " onSettingWindowCreated: typeof onSettingWindowCreated !== 'undefined' ? onSettingWindowCreated : null," +
    " onVueComponentMount: typeof onVueComponentMount !== 'undefined' ? onVueComponentMount : null };\n";

console.log("== 1) 模块加载 ==");
// 给工具栏一个真实的 rect —— 入口要靠它对位，jsdom 默认全是 0
setRect(doc.querySelector(".chat-func-bar"), 100, 620, 700, 32);
setRect(doc.querySelector(".chat-input-area"), 100, 620, 700, 160);
let loadErr = null;
try {
    vm.runInContext(wrapped, dom.getInternalVMContext());
    ok("renderer.js 在 DOM 中执行成功，未抛异常");
} catch (e) {
    loadErr = e;
    bad("renderer.js 执行抛出异常: " + e.message + "\n" + String(e.stack).split("\n").slice(0, 5).join("\n"));
}
if (loadErr) {
    console.log("\n--- 插件日志 ---\n" + logLines.join("\n"));
    process.exit(1);
}

await sleep(50);
const hooks = window.__hooks;
hooks.onSettingWindowCreated ? ok("导出 onSettingWindowCreated") : bad("缺少 onSettingWindowCreated");
hooks.onVueComponentMount === null ? ok("刻意不导出 onVueComponentMount（QQ 最热路径零开销）") : bad("不该导出 onVueComponentMount");

doc.head.querySelector('link[rel="stylesheet"]') ? ok("样式表已注入 head") : bad("样式表未注入");

console.log("\n== 2) 工具栏入口（必须是原生位置，跟着工具栏一起悬停/折叠） ==");
await sleep(400);
const barBtn = doc.querySelector(".sb-bar-icon");
if (barBtn) {
    ok("工具栏星标已插入");
    const row = barBtn.closest(".func-bar");
    const bars = [...doc.querySelectorAll(".chat-func-bar .func-bar")];
    row && row.querySelector(".bar-icon")
        ? ok("星标落在「图标所在的那一行」（不是空的那行 .func-bar）")
        : bad("星标插进了没有图标的 .func-bar 行 —— 会飘在图标行上方，就是用户截图里那颗");
    bars[0] && !bars[0].querySelector(".sb-bar-icon")
        ? ok("空的那行 .func-bar 没被塞星标")
        : bad("星标被塞进了空行");
    row && row.lastElementChild === barBtn ? ok("星标在最右边（排在最后一个图标右侧）") : bad("星标不在行尾");
    barBtn.querySelector("svg") ? ok("带上了图标") : bad("缺图标");
    barBtn.title ? ok("有悬停提示: " + barBtn.title.slice(0, 20) + "…") : bad("缺悬停提示");
} else bad("工具栏星标没有插入");

console.log("\n== 3) 右键菜单：存入本地 ==");
const img = doc.querySelector(".image-content");
setRect(img, 200, 300, 120, 120);
setRect(doc.querySelector(".ml-list"), 0, 0, 900, 700);

// 模拟右键：mousedown(button=2) 记录 elementFromPoint 目标
img.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 2, clientX: 210, clientY: 310 }));
const hitEl = doc.elementFromPoint(210, 310);
hitEl === img ? ok("elementFromPoint 命中的是图片本身（真实浏览器行为）") : bad("elementFromPoint 命中 " + (hitEl && hitEl.className) + "，不是图片");
// 模拟 QQ 弹出自己的菜单
const menu = doc.createElement("div");
menu.className = "q-context-menu";
setRect(menu, 220, 320, 180, 260);
menu.innerHTML = `<a class="q-context-menu-item q-context-menu-item--normal" role="menuitem">
    <div class="q-context-menu-item__icon q-context-menu-item__head"><svg class="q-icon"></svg></div>
    <span class="q-context-menu-item__text">复制</span></a>`;
doc.body.appendChild(menu);
img.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, button: 2, clientX: 210, clientY: 310 }));
await sleep(300);

const injected = doc.querySelector("#sb-save-menu");
if (injected) {
    ok("菜单里注入了 #sb-save-menu");
    const txt = injected.querySelector(".q-context-menu-item__text")?.textContent;
    txt === "存入本地表情库" ? ok("条目文案正确: " + txt) : bad("条目文案不对: " + txt);
    injected.querySelector("svg") ? ok("条目带上了图标 svg") : bad("条目没有图标");

    injected.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(150);
    const sc = apiCalls.filter((c) => c.name === "saveCandidates").pop();
    if (sc) {
        const cands = sc.args[0].candidates || [];
        ok("点击后调用了 saveCandidates，候选 " + cands.length + " 个");
        cands.some((c) => c.startsWith("appimg://")) ? ok("候选里包含 appimg:// 原始属性（关键：本地路径的来源）") : bad("候选里没有 appimg://，实际: " + JSON.stringify(cands));
        cands.some((c) => /^appimg:\/\/C%3A/.test(c)) ? ok("百分比编码未被破坏") : bad("appimg 编码被破坏");
    } else bad("点击后没有调用 saveCandidates");
} else {
    bad("菜单里没有注入条目");
    console.log("      菜单现有内容: " + menu.innerHTML.slice(0, 200));
}

console.log("\n== 3b) 大表情（data: URI）不会被原样写进日志 ==");
try {
    // QQ 的「大表情」/收藏表情是内联 base64。0.1.0 会把整条 data: URI
    // 写进日志 —— 单行 386,862 字符，主进程同步写盘时卡住（托盘都会没反应）。
    const bigDataUri = "data:image/png;base64," + "A".repeat(200000);
    const holder = doc.createElement("div");
    holder.className = "msg-content-container message";
    holder.innerHTML = `<img class="marketface" src="${bigDataUri}">`;
    setRect(holder, 150, 200, 300, 200);
    doc.body.appendChild(holder);

    const mark = logLines.length;
    // 让菜单强制重建：先移除再右键
    menu.remove();
    const menu2 = doc.createElement("div");
    menu2.className = "q-context-menu";
    menu2.innerHTML = `<a class="q-context-menu-item"><span class="q-context-menu-item__text">复制</span></a>`;
    setRect(menu2, 500, 400, 160, 120); // 菜单要"可见"（>20x20），但别盖住点击点，否则 elementFromPoint 会命中菜单而不是图片
    doc.body.appendChild(menu2);

    const img2 = holder.querySelector("img");
    setRect(img2, 150, 200, 200, 200); // elementFromPoint 要能命中它
    // 按真实流程来：QQ 里是「右键 mousedown → contextmenu」。
    // 只发 contextmenu 的话，插件会沿用上一次残留的 ctxTarget（contextmenu 处理器
    // 只在 ctxTarget 为空时才更新），测出来就不是这张图了。
    img2.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 2, clientX: 200, clientY: 260 }));
    img2.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, button: 2, clientX: 200, clientY: 260 }));
    await sleep(300);

    const produced = logLines.slice(mark);
    produced.length ? ok(`右键大表情产生了 ${produced.length} 行日志`) : bad("右键大表情没有产生日志（用例无效）");
    const longest = produced.reduce((a, b) => (a.length > b.length ? a : b), "");
    longest.length < 2000
        ? ok(`最长一行只有 ${longest.length} 字符（不再把 200KB 的 base64 写进日志）`)
        : bad(`日志行长达 ${longest.length} 字符，data: URI 又漏出来了`);
    produced.some((l) => l.includes("data-uri(")) ? ok("data: URI 被压成了摘要，形如 data-uri(image/png,195KB)") : (bad("没有看到 data-uri 摘要"), console.log("      [调试] 实际日志: " + produced.join(" || ").slice(0, 400)));
    !produced.some((l) => l.includes("AAAAA")) ? ok("日志里不含 base64 正文") : bad("日志里仍然带着 base64 正文");
    holder.remove();
    menu2.remove();
} catch (e) {
    bad("3b 抛异常: " + e.message);
}

console.log("\n== 4) 表情面板入口已按要求移除 ==");
try {
    // 塞一个和 QQ 表情面板一模一样的结构进去 —— 插件也绝不该往里插任何东西
    const shell = doc.createElement("div");
    shell.className = "sticker-panel-ref expression-panel-inner";
    shell.innerHTML = `
      <div class="sticker-panel">
        <div class="q-scroll-view"><div class="sticker-container"></div></div>
        <div>
          <div class="sticker-panel__pages">${'<img src="s.png">'.repeat(30)}</div>
          <div class="sticker-panel__divide"></div>
          <div class="tabs sticker-panel__bar vue-component"><div class="tab">A</div></div>
        </div>
      </div>`;
    setRect(shell.querySelector(".sticker-panel"), 150, 380, 450, 337);
    setRect(shell.querySelector(".sticker-panel__bar"), 150, 680, 448, 36);
    doc.body.appendChild(shell);
    await sleep(1500);

    !doc.getElementById("sb-emoji-entry") ? ok("没有生成面板内入口（用户要求删掉，顺带消除了「图标黏住」问题）") : bad("仍然生成了面板内入口");
    !doc.getElementById("sb-layer") ? ok("没有创建浮层容器 #sb-layer") : bad("仍然创建了浮层容器");
    !shell.querySelector("[id^='sb-']") ? ok("表情面板结构里没有插件节点") : bad("表情面板里被插入了插件节点");
    !logLines.some((l) => l.includes("EMOJI-PANEL-FOUND")) ? ok("没有面板识别日志（整套机制已删除）") : bad("仍有面板识别日志");
    shell.remove();
} catch (e) {
    bad("第 4 节抛异常: " + e.message);
}

console.log("\n== 4b) 不再导出 Vue 钩子（QQ 最热路径上零开销） ==");
hooks.onVueComponentMount === null
    ? ok("没有导出 onVueComponentMount —— LiteLoader 的 exports[name]?.() 会直接跳过")
    : bad("仍然导出了 onVueComponentMount，它会在每个组件挂载时被调用");

console.log("\n== 5) 库面板渲染与填入输入框 ==");
// 面板现在只能由工具栏星标打开（表情栏入口已删除）
doc.querySelector(".sb-bar-icon")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(400);
const sbPanel = doc.querySelector(".sb-panel");
if (sbPanel) {
    const items = sbPanel.querySelectorAll(".sb-item");
    items.length === LIB.length ? ok(`渲染了 ${items.length} 个表情格子`) : bad(`格子数不对: ${items.length}，期望 ${LIB.length}`);
    const count = sbPanel.querySelector(".sb-count")?.textContent || "";
    count.includes("3") ? ok("统计显示正确: " + count) : bad("统计文本异常: " + count);

    items[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(600);
    const pf = apiCalls.filter((c) => c.name === "pasteFile").pop();
    pf ? ok("点击表情调用 pasteFile（写系统剪贴板 + 真实粘贴）") : bad("没有调用 pasteFile");
    pf && pf.args[0] === LIB[0].name ? ok("传的是正确的文件名: " + pf.args[0]) : bad("文件名不对: " + (pf && pf.args[0]));
    dispatchedPastes.length === 0
        ? ok("没有派发合成 paste —— 那条路会让 QQ 把用户剪贴板里的东西粘进来，已删除")
        : bad("仍在派发合成 paste（会把用户剪贴板内容粘进输入框）");
    items[0].querySelector("img").draggable === false ? ok("缩略图 <img> 关闭了原生拖拽（避免 QQ 报「拖入空文件」）") : bad("缩略图 <img> 仍可原生拖拽");
    items[0].draggable === true ? ok("格子本身可拖拽（用来走原生文件拖放）") : bad("格子不可拖拽");

    // 拖拽 = 走 Electron 原生拖文件，动图靠这条保留动画
    const beforeDrag = apiCalls.filter((c) => c.name === "startDrag").length;
    const dt = new window.DataTransfer();
    const dEvt = new DragEventShim("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt });
    items[0].dispatchEvent(dEvt);
    await sleep(150);
    dEvt.defaultPrevented
        ? ok("dragstart 里调用了 preventDefault ← 不这么做浏览器自己的 HTML5 拖拽会顶掉原生拖拽，QQ 只会收到文件名")
        : bad("dragstart 没有 preventDefault —— 这正是之前「只填进文件名」的原因");
    apiCalls.filter((c) => c.name === "startDrag").length > beforeDrag
        ? ok("dragstart 触发了 api.startDrag（原生文件拖放）")
        : bad("dragstart 没有触发 startDrag");
    const dg = apiCalls.filter((c) => c.name === "startDrag").pop();
    dg && dg.args[0] === LIB[0].name ? ok("拖拽传的是正确文件: " + dg.args[0]) : bad("拖拽文件名不对: " + (dg && dg.args[0]));
} else bad("没有库面板，跳过渲染测试");

console.log("\n== 6) 设置页 ==");
const view = doc.createElement("div");
try {
    await hooks.onSettingWindowCreated(view);
    await sleep(50);
    view.querySelector("setting-section") ? ok("设置页渲染出 setting-section") : bad("设置页没有 setting-section");
    view.querySelector("#sb-impf") && view.querySelector("#sb-impd") ? ok("有导入文件/导入文件夹按钮") : bad("缺少导入按钮");
    view.querySelector("#sb-panel-entry") ? ok("有「工具栏星标」开关") : bad("缺少开关");
    view.querySelector("#sb-selftest") ? ok("有运行自检按钮") : bad("缺少自检按钮");
    !view.querySelector("#sb-snapshot") ? ok("已移除「导出 DOM 快照」（面板识别机制删了，它也没用了）") : bad("快照按钮还在");

    const impBtn = view.querySelector("#sb-impd");
    impBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(120);
    apiCalls.some((c) => c.name === "importFolder") ? ok("点导入按钮调用了 importFolder") : bad("导入按钮没有绑定生效");

    const stBtn = view.querySelector("#sb-selftest");
    const logBefore = logLines.length;
    stBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(250);
    const produced = logLines.slice(logBefore);
    produced.length >= 10 ? ok(`自检产出了 ${produced.length} 行报告`) : bad(`自检输出不足: ${produced.length} 行`);
    logLines.some((l) => l.includes("local:// fetch 测试: ok=true")) ? ok("自检实测了 local:// 协议且成功") : bad("自检里的 local:// 测试没成功");
    logLines.some((l) => l.includes("SELF-TEST END")) ? ok("自检正常收尾") : bad("自检没有收尾标记");
    produced.some((l) => l.includes("window.sticker_box: 20 个方法")) ? ok("自检确认 20 个 API 方法都在") : bad("自检没确认到 API（方法数应为 20）");
} catch (e) {
    bad("设置页执行抛异常: " + e.message);
}

console.log("\n== 7) 不再导出 Vue 钩子 ==");
hooks.onVueComponentMount === null
    ? ok("onVueComponentMount 未导出（LiteLoader 的 exports[name]?.() 会直接跳过）")
    : bad("仍然导出了 onVueComponentMount");

console.log("\n== 8) 面板内的右键单项菜单 ==");
const gridItem = doc.querySelector(".sb-item");
if (gridItem) {
    gridItem.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, clientX: 50, clientY: 50 }));
    await sleep(80);
    const im = doc.querySelector(".sb-itemmenu");
    im ? ok("单项右键菜单弹出，含 " + im.querySelectorAll("button").length + " 项") : bad("单项右键菜单没弹出");
}

console.log("\n== 10) GIF/WebP 降级：canvas 转静态 PNG 后走 pastePng ==");
pasteFileUnsupported = true;
const beforeRead = apiCalls.filter((c) => c.name === "readFile").length;
const beforePng = apiCalls.filter((c) => c.name === "pastePng").length;
const cell2 = doc.querySelector(".sb-item");
cell2.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(900);
apiCalls.filter((c) => c.name === "readFile").length > beforeRead
    ? ok("降级时用 readFile 取字节（避免 canvas 被 local:// 图片污染）")
    : bad("没有通过 readFile 取字节");
apiCalls.filter((c) => c.name === "pastePng").length > beforePng ? ok("转成 PNG 后走 pastePng 通道") : bad("没有调用 pastePng");
logLines.some((l) => l.includes("改用 canvas 转静态 PNG")) ? ok("日志记录了降级动作") : bad("日志没记录降级");
pasteFileUnsupported = false;

console.log("\n== 11) 关掉开关会摘掉工具栏星标 ==");
const swPanel = view.querySelector("#sb-panel-entry");
const hadToolbar = !!doc.querySelector(".sb-bar-icon");
hadToolbar ? ok("测试前星标在位（用例有效）") : bad("测试前星标就不在，用例无效");
swPanel.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(400);
!doc.querySelector(".sb-bar-icon") ? ok("关掉开关后星标被摘掉（安全阀真的管用）") : bad("关掉开关星标还在");
logLines.some((l) => l.includes("已按设置移除工具栏星标")) ? ok("日志记录了移除动作") : bad("日志没记录移除");

console.log("\n== 12) 性能与稳定性回归守卫（对应 QQ 卡死/崩溃的根因） ==");
// 12a: 早期版本导出 onVueComponentMount 并在里面取 rect / 数图片，
//      这个钩子在 QQ 里每条消息、每个头像都会触发，是导致渲染进程崩溃重载的元凶之一。
try {
    hooks.onVueComponentMount === null
        ? ok("没有导出 Vue 钩子，QQ 最热的路径上零开销")
        : bad("仍在导出 onVueComponentMount");
} catch (e) {
    bad("12a 抛异常: " + e.message);
}

// 12b: 插件现在一个 MutationObserver 都不该创建
//      （早期那个常驻观察器对每个新增节点做全子树展开，切聊天直接把渲染进程拖死）
try {
    moCount === 0
        ? ok("整个生命周期内创建了 0 个 MutationObserver（改成 1.2 秒轮询）")
        : bad(`创建了 ${moCount} 个 MutationObserver，常驻观察器是之前拖死 QQ 的原因之一`);
} catch (e) {
    bad("12b 抛异常: " + e.message);
}

// 12c: 除了工具栏星标这一个**有意的例外**，其它插件元素都不能出现在 QQ 容器内部。
//
// 工具栏星标必须插进 .func-bar 才能跟着 QQ 的悬停/折叠样式（浮层方案对不齐）。
// 除此之外：Vue patch 遇到未知子节点可能抛错，组件渲染失败
// -> 渲染进程崩溃重载 -> 脚本重跑又插一次，会形成死循环。
try {
    const QQ_CONTAINERS = [
        ".chat-input-area",
        ".ck-editor__editable",
        ".ml-list",
        ".chat-msg-area__vlist",
        ".sticker-panel",
        ".sticker-panel__bar",
        ".sticker-panel__pages",
        ".expression-panel"
    ];
    const leaks = [];
    for (const el of doc.querySelectorAll(".sb-panel, .sb-panel *, .sb-toast, .sb-itemmenu")) {
        for (const sel of QQ_CONTAINERS) {
            if (el.closest(sel)) {
                leaks.push((el.id || el.className) + " 在 " + sel + " 内");
                break;
            }
        }
    }
    leaks.length === 0
        ? ok("除工具栏星标外，没有插件元素出现在 QQ 容器内部")
        : bad("有插件元素被插进了 QQ 的 DOM: " + leaks.slice(0, 4).join("; "));
    doc.querySelector(".sb-bar-icon")?.closest(".func-bar")
        ? ok("工具栏星标在 .func-bar 内（有意为之，为了对齐原生布局）")
        : ok("工具栏星标当前不在 .func-bar 内（可能被开关摘掉了）");
} catch (e) {
    bad("12c 抛异常: " + e.message);
}

// 12d: 全局不变式 —— 整个测试期间产生的所有日志行都不许超长。
//      这条比单点用例更强：以后任何地方不小心把大对象写进日志，这里都会红。
try {
    const worst = logLines.reduce((a, b) => (a.length > b.length ? a : b), "");
    const over = logLines.filter((l) => l.length > 2000);
    over.length === 0
        ? ok(`全部 ${logLines.length} 行日志都不超长（最长 ${worst.length} 字符）`)
        : bad(`${over.length} 行日志超过 2000 字符，最长 ${worst.length} 字符`);
} catch (e) {
    bad("12d 抛异常: " + e.message);
}

console.log(`\n================ 结果: ${pass} 通过 / ${fail} 失败 ================`);
if (fail) {
    console.log("\n--- 插件日志（最后 30 行） ---");
    console.log(logLines.slice(-30).map((l) => "  " + l).join("\n"));
}
process.exit(fail ? 1 : 0);
