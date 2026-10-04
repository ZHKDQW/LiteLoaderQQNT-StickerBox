/**
 * sticker_box 主进程逻辑测试台
 *   node test-sticker-main.mjs
 *
 * 在 Node 里 mock 掉 electron，跑真实的 main.js，验证：
 *   1. 模块能被加载（顶层没有访问不到的 API）
 *   2. appimg:// 来源 -> 复制入库
 *   3. 内容去重
 *   4. local:/// URL 往返（含中文、空格、# 等特殊字符）
 *   5. bytes 直传入库（blob: 那条路）
 *   6. 文件名清洗、扩展名嗅探
 *   7. list / rename / remove
 *   8. 目录穿越防护
 */
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import { createRequire } from "node:module";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const require = createRequire(import.meta.url);

const SANDBOX = path.join(HERE, "sandbox");
const DATA = path.join(SANDBOX, "data");
const PROFILE = path.join(SANDBOX, "profile");
const SRC = path.join(SANDBOX, "src");
const PLUGIN_MAIN = path.join(HERE, "..", "main.js");

// 干净的沙箱
fs.rmSync(SANDBOX, { recursive: true, force: true });
for (const d of [DATA, PROFILE, SRC]) fs.mkdirSync(d, { recursive: true });

// ---- 注入 electron mock ----
const MOCK = path.join(HERE, "mock-electron.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === "electron") return MOCK;
    return origResolve.call(this, request, ...rest);
};

// ---- 注入 LiteLoader 全局 ----
globalThis.LiteLoader = {
    path: {
        root: path.join(SANDBOX, "LLroot"),
        profile: PROFILE,
        data: DATA,
        plugins: path.join(PROFILE, "plugins")
    },
    versions: { liteloader: "1.4.1", qqnt: "9.9.25-42941", electron: "test", node: process.versions.node, chrome: "test" },
    os: { platform: "win32" }
};

// ---- 加载真实 main.js ----
const mainExports = require(PLUGIN_MAIN);
const { handlers } = require(MOCK).__handlers ? require(MOCK) : globalThis.__mock;
const H = globalThis.__mock.handlers;
const senderMock = globalThis.__mock.sender;
const CH = (m) => `LiteLoader.sticker_box.${m}`;
// 传一个带 sender 的假事件对象 —— main.js 现在优先用 event.sender（Electron 官方做法）
const call = (m, ...args) => H.get(CH(m))({ sender: globalThis.__mock.sender }, ...args);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 断言工具 ----
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
const eq = (a, b, m) => (a === b ? ok(`${m}  (= ${JSON.stringify(a)})`) : bad(`${m}  期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`));

// 1x1 PNG
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
);
const PNG2 = Buffer.concat([PNG, Buffer.from([0, 0, 0, 0])]); // 内容不同的“另一张图”

function writeSrc(name, buf) {
    const p = path.join(SRC, name);
    fs.writeFileSync(p, buf);
    return p;
}

console.log("== 1) main.js 加载 ==");
Object.keys(mainExports || {}).length >= 0 ? ok("模块加载成功，导出 " + Object.keys(mainExports || {}).length + " 个键") : bad("导出异常");
eq(H.size, 21, "注册了 21 个 ipc handler");

console.log("\n== 2) 初始配置 ==");
const cfg0 = await call("getConfig");
eq(cfg0.dedupe, true, "默认开启去重");
cfg0.libraryPathResolved.includes("sticker_box") ? ok("默认库目录在插件数据目录下: " + cfg0.libraryPathResolved) : bad("默认库目录异常: " + cfg0.libraryPathResolved);

console.log("\n== 3) appimg:// 本地文件 -> 入库 ==");
const f1 = writeSrc("测试 表情#1.png", PNG);
const r1 = await call("saveCandidates", { candidates: ["appimg://" + encodeURIComponent(f1.replace(/\\/g, "/"))] });
r1.ok ? ok("入库成功: " + r1.name) : bad("入库失败: " + r1.error);
/^测试 表情#1\.png$/.test(r1.name || "") ? ok("中文/空格/# 文件名被正确保留") : bad("文件名被改坏: " + r1.name);

console.log("\n== 4) 内容去重 ==");
const r2 = await call("saveCandidates", { candidates: ["appimg://" + encodeURIComponent(f1.replace(/\\/g, "/"))] });
r2.ok && r2.duplicated ? ok("重复内容被识别，未产生新文件") : bad("去重失效: " + JSON.stringify(r2));

console.log("\n== 5) 同名不同内容 -> 自动加序号 ==");
const r3 = await call("saveCandidates", { bytes: { name: "测试 表情#1.png", buffer: PNG2.buffer.slice(PNG2.byteOffset, PNG2.byteOffset + PNG2.byteLength) } });
r3.ok && !r3.duplicated ? ok("新内容入库为: " + r3.name) : bad("失败: " + JSON.stringify(r3));
r3.name !== r1.name ? ok("未覆盖同名文件") : bad("重名冲突未处理");

console.log("\n== 6) list + local:/// URL 往返 ==");
const items = await call("list", "");
eq(items.length, 2, "列出 2 项");
let roundTripAllOk = true;
for (const it of items) {
    // 复刻 LiteLoader 的 local:// 协议处理器逻辑
    const { host, pathname } = new URL(decodeURI(it.url));
    const filepath = path.normalize(pathname.slice(1));
    const fileUrl = `file://${host}/${filepath}`;
    let back = "";
    try {
        back = require("node:url").fileURLToPath(fileUrl);
    } catch (e) {
        back = "ERR:" + e.message;
    }
    const expected = path.join(DATA, "sticker_box", "stickers", it.name);
    const good = path.resolve(back) === path.resolve(expected);
    if (!good) {
        roundTripAllOk = false;
        console.log(`      往返失败: ${it.name}\n        url=${it.url}\n        fileUrl=${fileUrl}\n        back=${back}\n        期望=${expected}`);
    }
}
roundTripAllOk ? ok("所有 URL 经 local:// 协议处理器往返后都指回正确文件（含中文/空格/#）") : bad("URL 往返有问题，见上方明细");
items.every((i) => i.url.startsWith("local:///")) ? ok("URL 使用了 local:/// 绝对路径形式") : bad("URL 形式异常");

console.log("\n== 7) 扩展名嗅探（无扩展名来源） ==");
const f2 = writeSrc("noext_blob", PNG);
const r4 = await call("saveCandidates", { candidates: ["file:///" + f2.replace(/\\/g, "/")] });
r4.ok && /\.png$/.test(r4.name) ? ok("按文件头识别为 png: " + r4.name) : bad("嗅探失败: " + JSON.stringify(r4));

console.log("\n== 8) 从文件夹导入 ==");
writeSrc("导入A.png", Buffer.concat([PNG, Buffer.from([1])]));
writeSrc("导入B.gif", Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(20)]));
writeSrc("不是图片.txt", Buffer.from("hello"));
globalThis.__mock.openDialogResult = { canceled: false, filePaths: [SRC] };
const imp = await call("importFolder");
eq(imp.ok, true, "导入调用成功");
eq(imp.added, 2, "新增 2 张（.txt 被过滤）");
imp.failed.length === 0 ? ok("没有失败项") : bad("有失败项: " + JSON.stringify(imp.failed));

console.log("\n== 9) net.fetch 下载远程图 ==");
globalThis.__mock.netFetchImpl = async (url) => ({
    ok: true,
    status: 200,
    headers: { get: () => "image/png" },
    arrayBuffer: async () => PNG2.buffer.slice(PNG2.byteOffset, PNG2.byteOffset + PNG2.byteLength)
});
const r5 = await call("saveCandidates", { candidates: ["https://example.com/a/b/远程.png"] });
r5.ok ? ok("远程入库成功: " + r5.name) : bad("远程入库失败: " + r5.error);
globalThis.__mock.netFetchImpl = null;

console.log("\n== 9b) 缩略图 -> 原图 自动替换（真实运行日志里发现的问题） ==");
const emojiDir = path.join(SRC, "emoji");
const thumbDir = path.join(emojiDir, "Thumb");
fs.mkdirSync(thumbDir, { recursive: true });
const smallGif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(20, 3)]);
const bigGif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(2000, 1)]);
const smallPng = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(20, 4)]);
const bigPng = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(3000, 2)]);
fs.writeFileSync(path.join(thumbDir, "abc_720.gif"), smallGif);
fs.writeFileSync(path.join(emojiDir, "abc.gif"), bigGif);

const toAppimg = (p) => "appimg://" + encodeURIComponent(p.replace(/\\/g, "/"));
const rThumb = await call("saveCandidates", { candidates: [toAppimg(path.join(thumbDir, "abc_720.gif"))] });
rThumb.ok ? ok("入库成功: " + rThumb.name) : bad("入库失败: " + rThumb.error);
rThumb.name === "abc.gif" ? ok("存下来的是原图 abc.gif，不是缩略图 abc_720.gif") : bad("存的是 " + rThumb.name);
const savedP = path.join(DATA, "sticker_box", "stickers", rThumb.name);
fs.existsSync(savedP) && fs.statSync(savedP).size === bigGif.length
    ? ok(`字节数 ${bigGif.length} = 原图大小（缩略图只有 ${smallGif.length}）`)
    : bad("字节数不对: " + (fs.existsSync(savedP) ? fs.statSync(savedP).size : "文件不存在"));

fs.writeFileSync(path.join(emojiDir, "def_720.png"), smallPng);
fs.writeFileSync(path.join(emojiDir, "def.png"), bigPng);
const rSame = await call("saveCandidates", { candidates: [toAppimg(path.join(emojiDir, "def_720.png"))] });
rSame.name === "def.png" ? ok("同目录下也能按 _720 后缀找到原图") : bad("同目录替换失败: " + rSame.name);

const lonelyDir = path.join(SRC, "lonely");
fs.mkdirSync(lonelyDir, { recursive: true });
fs.writeFileSync(path.join(lonelyDir, "only_720.gif"), smallGif);
const rOnly = await call("saveCandidates", { candidates: [toAppimg(path.join(lonelyDir, "only_720.gif"))] });
rOnly.ok && rOnly.name === "only_720.gif"
    ? ok("找不到原图时正常保存缩略图（不报错、不误取别的文件）")
    : bad("退化为缩略图时出错: " + JSON.stringify(rOnly));

// 真实目录结构：Thumb/xxx_720.gif 的原图在「兄弟目录」Ori/xxx.gif
const bigGif3 = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(4000, 5)]);
const recvDir = path.join(SRC, "recv", "2026-10");
fs.mkdirSync(path.join(recvDir, "Thumb"), { recursive: true });
fs.mkdirSync(path.join(recvDir, "ThumbTemp"), { recursive: true });
fs.mkdirSync(path.join(recvDir, "Ori"), { recursive: true });
fs.mkdirSync(path.join(recvDir, "OriTemp"), { recursive: true });
fs.writeFileSync(path.join(recvDir, "Thumb", "aaa_720.gif"), smallGif);
fs.writeFileSync(path.join(recvDir, "Ori", "aaa.gif"), bigGif3);
const rOri = await call("saveCandidates", { candidates: [toAppimg(path.join(recvDir, "Thumb", "aaa_720.gif"))] });
rOri.name === "aaa.gif" ? ok("Thumb/aaa_720.gif -> 兄弟目录 Ori/aaa.gif（QQ 的真实结构）") : bad("Ori 规则失败: " + rOri.name);

// ThumbTemp 是下载中的临时目录，同样应映射到 OriTemp（用不同内容，避免被去重干扰）
const bigGif4 = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(5000, 6)]);
fs.writeFileSync(path.join(recvDir, "ThumbTemp", "bbb_720.gif"), smallGif);
fs.writeFileSync(path.join(recvDir, "OriTemp", "bbb.gif"), bigGif4);
const rTemp = await call("saveCandidates", { candidates: [toAppimg(path.join(recvDir, "ThumbTemp", "bbb_720.gif"))] });
rTemp.name === "bbb.gif" ? ok("ThumbTemp -> 兄弟目录 OriTemp 也生效") : bad("ThumbTemp 规则失败: " + rTemp.name);

console.log("\n== 10) 重命名 / 删除 ==");
const ren = await call("rename", { oldName: r1.name, newName: "改名后" });
ren.ok ? ok("重命名: " + r1.name + " -> " + ren.name) : bad("重命名失败: " + ren.error);
const del = await call("remove", [ren.name]);
eq(del.removed, 1, "删除 1 个文件");

console.log("\n== 11) readFile：填入输入框的 IPC 兜底通道 ==");
const itemsNow = await call("list", "");
const target = itemsNow[0];
const rf = await call("readFile", target.name);
if (rf.ok) {
    ok("读回 " + rf.name + "，" + rf.size + " 字节, mime=" + rf.type);
    const back = Buffer.from(rf.buffer);
    back.length === target.size ? ok("字节数与文件一致") : bad("字节数不符: " + back.length + " vs " + target.size);
    const disk = fs.readFileSync(path.join(DATA, "sticker_box", "stickers", target.name));
    back.equals(disk) ? ok("读回的字节与磁盘文件逐字节一致（Buffer 切片正确）") : bad("字节与磁盘文件不一致");
} else {
    bad("readFile 失败: " + rf.error);
}
const rfTraversal = await call("readFile", "../../../Windows/System32/drivers/etc/hosts");
rfTraversal.ok ? bad("目录穿越没有被拦住！") : ok("目录穿越被拒绝: " + rfTraversal.error);
const rfMissing = await call("readFile", "根本不存在的文件.png");
rfMissing.ok ? bad("读取不存在的文件竟然成功了") : ok("不存在的文件返回失败");
const rfEmpty = await call("readFile", "");
rfEmpty.ok ? bad("空文件名竟然成功了") : ok("空文件名被拒绝");

console.log("\n== 11b) pasteFile：真实粘贴通道 ==");
const anyItem = (await call("list", ""))[0];
const pr = await call("pasteFile", anyItem.name);
pr.ok ? ok("pasteFile 成功，图片尺寸 " + JSON.stringify(pr.size)) : bad("pasteFile 失败: " + pr.error);
(globalThis.__mock.calls.paste || 0) > 0 ? ok("确实调用了 webContents.paste()（真实粘贴）") : bad("没有触发真实粘贴");
globalThis.__mock.clipboardImages.length > 0 ? ok("图片已写入系统剪贴板") : bad("没有写剪贴板");

globalThis.__mock.nativeImageEmpty = true;
const pr2 = await call("pasteFile", anyItem.name);
pr2.ok === false && pr2.unsupported === true
    ? ok("GIF/WebP 等 nativeImage 解不了的格式返回 unsupported，不误报成功")
    : bad("格式不支持时返回不对: " + JSON.stringify(pr2));
globalThis.__mock.nativeImageEmpty = false;

const pr3 = await call("pasteFile", "../../../x.gif");
pr3.ok ? bad("pasteFile 目录穿越没拦住！") : ok("pasteFile 目录穿越被拒绝");
const pr4 = await call("pasteFile", "不存在的.gif");
pr4.ok ? bad("读取不存在的文件竟然成功") : ok("不存在的文件返回失败");

globalThis.__mock.sender = null;
globalThis.__mock.hasFocusedWebContents = false;
const pr5 = await call("pasteFile", anyItem.name);
pr5.ok === false && /焦点窗口/.test(pr5.error || "") ? ok("sender 与焦点窗口都拿不到时如实报错") : bad("无窗口时返回不对: " + JSON.stringify(pr5));
globalThis.__mock.sender = senderMock;
globalThis.__mock.hasFocusedWebContents = true;

// pastePng：GIF 走 canvas 转静态 PNG 后从这条通道进来
const beforePaste = globalThis.__mock.calls.paste || 0;
const pp = await call("pastePng", "x.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer);
pp.ok ? ok("pastePng 成功，尺寸 " + JSON.stringify(pp.size)) : bad("pastePng 失败: " + pp.error);
(globalThis.__mock.calls.paste || 0) > beforePaste ? ok("pastePng 也触发了真实粘贴") : bad("pastePng 没有触发粘贴");
const pp2 = await call("pastePng", "x.png", new ArrayBuffer(0));
pp2.ok ? bad("空字节竟然成功了") : ok("空字节被拒绝: " + pp2.error);

console.log("\n== 11c) startDrag：原生拖拽（动图靠它保留动画） ==");
const drag = await call("startDrag", anyItem.name);
drag.ok ? ok("startDrag 成功发起原生拖拽") : bad("startDrag 失败: " + drag.error);
(globalThis.__mock.calls.startDrag || 0) > 0 ? ok("确实调用了 webContents.startDrag()") : bad("没有发起拖拽");
const dragItem = globalThis.__mock.calls.lastDragItem || {};
dragItem.file && dragItem.file.endsWith(anyItem.name) ? ok("拖拽带的是真实文件路径: " + dragItem.file) : bad("拖拽的文件路径不对: " + JSON.stringify(dragItem.file));
dragItem.icon ? ok("带上了拖拽图标（GIF 解不了时用空图标）") : bad("缺少拖拽图标");
const dragBad = await call("startDrag", "../../x.gif");
dragBad.ok ? bad("startDrag 目录穿越没拦住！") : ok("startDrag 目录穿越被拒绝");

console.log("\n== 12) 目录穿越防护 ==");
const evil = await call("remove", ["../../../重要文件.txt", "..\\..\\x.txt"]);
eq(evil.removed, 0, "穿越路径被拒绝");
const stats = await call("stats");
Number.isInteger(stats.count) ? ok("stats 正常: " + stats.count + " 张, " + stats.bytes + " 字节") : bad("stats 异常");

console.log("\n== 13) 不支持的来源不会崩 ==");
const r6 = await call("saveCandidates", { candidates: ["weird://whatever", "javascript:alert(1)", ""] });
eq(r6.ok, false, "无可用来源时返回失败而不是抛异常");
typeof r6.error === "string" && r6.error.length ? ok("带上了错误说明: " + r6.error.slice(0, 60)) : bad("缺少错误说明");

console.log("\n== 14) 库目录切换 ==");
const newLib = path.join(SANDBOX, "外部库");
fs.mkdirSync(newLib, { recursive: true });
globalThis.__mock.openDialogResult = { canceled: false, filePaths: [newLib] };
const ch = await call("chooseLibrary");
ch.ok && path.resolve(ch.libraryPath) === path.resolve(newLib) ? ok("切到外部库: " + ch.libraryPath) : bad("切换失败: " + JSON.stringify(ch));
await call("setConfig", { libraryPath: "" }); // 还原

console.log("\n== 15) 日志文件已生成 ==");
const logFile = path.join(DATA, "sticker_box", "debug.log");
if (fs.existsSync(logFile)) {
    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
    ok("debug.log 有 " + lines.length + " 行");
    lines.slice(0, 3).forEach((l) => console.log("      " + l.slice(0, 140)));
} else bad("debug.log 没生成");

console.log("\n== 16) 日志安全阀（0.1.1 修的 bug：右键大表情写出过 386KB 单行） ==");
{
    const sizeBefore = fs.statSync(logFile).size;

    // 模拟 QQ 把整张图片内联成 data: URI —— 当初就是它被原样写进了日志
    const huge = "data:image/png;base64," + "A".repeat(400000);
    await call("log", "超长内容测试 " + huge);
    await sleep(150);

    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
    const last = lines[lines.length - 1];

    last.length < 2000
        ? ok(`400KB 的内容被截断成 ${last.length} 字符的日志行（旧版会写出 386,862 字符）`)
        : bad(`日志行仍然有 ${last.length} 字符，截断没生效`);
    /已截断/.test(last) ? ok("截断处有明确标注和原始长度") : bad("截断没有标注");

    // data: URI 本身要能认出来（要单独传，前面拼了别的内容就匹配不到 ^data:）
    await call("log", huge);
    await sleep(150);
    const uriLine = fs.readFileSync(logFile, "utf8").trim().split("\n").pop();
    /data URI/.test(uriLine) ? ok("认得这是 data URI 并特别标注") : bad("没识别出 data URI: " + uriLine.slice(0, 120));

    const grew = fs.statSync(logFile).size - sizeBefore;
    grew < 4000 ? ok(`本次日志只增长 ${grew} 字节（旧版会涨 386KB）`) : bad(`日志增长了 ${grew} 字节，还是太多`);

    // 整行上限：多个超长参数拼起来也不能突破
    await call("log", huge, huge, huge);
    await sleep(150);
    const after = fs.readFileSync(logFile, "utf8").trim().split("\n").pop();
    after.length <= 8100 ? ok(`整行上限生效（${after.length} 字符）`) : bad(`整行上限失效: ${after.length} 字符`);
}

console.log("\n== 17) data: URI 能存进库（QQ 大表情没有本地文件可复制） ==");
{
    const png = fs.readFileSync(path.join(HERE, "..", "assets", "drag-icon.png"));
    const dataUri = "data:image/png;base64," + png.toString("base64");

    const res = await call("saveCandidates", { candidates: [dataUri], context: {} });
    res && res.ok ? ok("data: URI 解码后成功入库") : bad("data: URI 存不进去: " + JSON.stringify(res));

    const listed = await call("list", "");
    const items = Array.isArray(listed) ? listed : [];
    const hit = items.find((i) => /marketface/.test(i.name));
    if (hit) {
        const got = await call("readFile", hit.name);
        const buf = Buffer.from(got.buffer);
        buf.length === png.length ? ok(`入库文件大小一致（${buf.length} 字节）`) : bad(`大小不一致: ${buf.length} vs ${png.length}`);
        buf.equals(png) ? ok("字节内容与原图完全一致（base64 解码正确）") : bad("字节内容不一致");
    } else {
        bad("没找到入库的 marketface 文件，现有: " + items.map((i) => i.name).join(","));
    }

    const badUri = await call("saveCandidates", { candidates: ["data:image/png;base64,!!!!"], context: {} });
    badUri && typeof badUri === "object" ? ok("非法 data: URI 被安全处理，没有抛异常") : bad("非法 data: URI 处理异常");
}

console.log("\n== 18) 看门狗与计时（为下一次定位卡死准备） ==");
{
    const mainSrc = fs.readFileSync(PLUGIN_MAIN, "utf8");
    /startWatchdog\(\);/.test(mainSrc) ? ok("main.js 启动了主进程看门狗") : bad("main.js 没有看门狗");
    /事件循环被阻塞/.test(mainSrc) ? ok("看门狗会记录阻塞时长与内存") : bad("看门狗没有记录阻塞");
    /\[慢\] IPC/.test(mainSrc) ? ok("IPC handler 有慢调用计时") : bad("IPC handler 没有计时");
    /startDrag: 开始/.test(mainSrc) && /startDrag: 结束/.test(mainSrc)
        ? ok("startDrag 有前后标记（能查出它是否卡住不返回）")
        : bad("startDrag 缺少前后标记");

    const rendererSrc = fs.readFileSync(path.join(HERE, "..", "renderer.js"), "utf8");
    /主线程被阻塞/.test(rendererSrc) ? ok("renderer.js 里也有看门狗") : bad("renderer.js 没有看门狗");
    /summarizeSource/.test(rendererSrc) ? ok("候选地址在送进日志前会被压成摘要") : bad("候选地址没有摘要化");
}


console.log("\n== 19) 按内容识别动图（QQ 缓存的文件名后缀不可信） ==");
{
    // 用户库里实测 8 个文件有 4 个扩展名与内容不符，其中就有真身是 GIF89a 却叫 .jpg 的
    const gifBytes = Buffer.concat([
        Buffer.from("GIF89a", "ascii"),
        Buffer.from([0xf0, 0x01, 0xf0, 0x01, 0xf7, 0x00]),
        Buffer.alloc(400, 0x41)
    ]);
    const libDir = (await call("stats")).libraryPath;
    fs.mkdirSync(libDir, { recursive: true });

    const disguised = "disguised-as-jpg.jpg";
    fs.writeFileSync(path.join(libDir, disguised), gifBytes);

    const list1 = await call("list", "");
    const hit = list1.find((i) => i.name === disguised);
    if (!hit) {
        bad("列表里没有刚写进去的文件");
    } else {
        hit.kind === "gif" ? ok(`扩展名 .jpg 但内容识别为 ${hit.kind}（看的是 magic bytes）`) : bad(`识别错了：kind=${hit.kind}，期望 gif`);
        hit.animated === true ? ok("animated=true —— 会走「按文件填入」，动画能保留") : bad("animated 不是 true，动图还是会被当静态图");
    }

    // 反向验证：别把所有东西都判成动图
    const pngBytes = fs.readFileSync(path.join(HERE, "..", "assets", "drag-icon.png"));
    fs.writeFileSync(path.join(libDir, "real-static.jpg"), pngBytes);
    const list2 = await call("list", "");
    const hit2 = list2.find((i) => i.name === "real-static.jpg");
    hit2 && hit2.kind === "png" && hit2.animated === false
        ? ok("真静态图（PNG 内容 + .jpg 名）判为 png / 非动图")
        : bad(`静态图判错了：${JSON.stringify(hit2 && { kind: hit2.kind, animated: hit2.animated })}`);

    // 扩展名正确的情况也要照常工作
    const realGif = "real-anim.gif";
    fs.writeFileSync(path.join(libDir, realGif), gifBytes);
    const list3 = await call("list", "");
    const hit3 = list3.find((i) => i.name === realGif);
    hit3 && hit3.kind === "gif" && hit3.animated === true ? ok("扩展名正确时也正常识别") : bad("正常情况反而识别失败");
}


console.log(`\n================ 结果: ${pass} 通过 / ${fail} 失败 ================`);
process.exit(fail ? 1 : 0);
