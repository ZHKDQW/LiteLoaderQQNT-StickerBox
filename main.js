/**
 * 本地表情包库 - 主进程
 *
 * 职责：
 *  - 管理本地表情库目录（默认 <profile>/data/sticker_box/stickers）
 *  - 把右键菜单抓到的表情/图片落盘（appimg:// 本地路径直接复制，http(s) 走 net.fetch 下载）
 *  - 从文件/文件夹批量导入
 *  - 给渲染进程提供列表 / 删除 / 重命名
 *  - 写诊断日志（QQNT 没有 DevTools，日志是唯一排查手段）
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { shell, dialog, ipcMain, net, app, clipboard, nativeImage, webContents, BrowserWindow } = require("electron");

const SLUG = "sticker_box";
const CH = (method) => `LiteLoader.${SLUG}.${method}`;

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".apng", ".avif", ".ico"];

/**
 * 解析数据目录。
 * LiteLoader 的全局是通过 Error.stack 做白名单校验的，万一拿不到就会抛错，
 * 那样整个模块会静默死掉、一行日志都留不下（QQNT 又没有 DevTools）。
 * 所以这里做兜底：退回插件目录附近的 data/ 目录。
 */
function resolvePluginRoot() {
    try {
        const data = globalThis.LiteLoader?.path?.data;
        if (data) return path.join(data, SLUG);
    } catch (e) {
        /* 落到下面的兜底 */
    }
    // <profile>/plugins/sticker_box -> <profile>/data/sticker_box
    return path.join(__dirname, "..", "..", "data", SLUG);
}

const pluginRoot = resolvePluginRoot();
const configPath = path.join(pluginRoot, "config.json");
const metaPath = path.join(pluginRoot, "meta.json");
const logPath = path.join(pluginRoot, "debug.log");

/** 最早的启动痕迹：能写出这行，就说明 main.js 至少被加载了 */
try {
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.appendFileSync(
        logPath,
        `[${new Date().toISOString()}] [BOOT] main.js 开始加载; pluginRoot=${pluginRoot}; stackCheck=${(() => {
            try {
                return String(!!globalThis.LiteLoader);
            } catch (e) {
                return "throw:" + e.message;
            }
        })()}\n`,
        "utf8"
    );
} catch (e) {
    /* 连这都失败就只能认了 */
}

const defaultConfig = {
    /** 自定义库目录，空字符串表示用默认的 <profile>/data/sticker_box/stickers */
    libraryPath: "",
    /** 是否记录诊断日志 */
    debugLog: true,
    /** 入库时按内容去重 */
    dedupe: true,
    /** 点击表情后是否自动关闭面板 */
    closeAfterInsert: false,
    /** 是否在 QQ 表情面板里注入「本地表情库」入口 */
    panelEntry: true,
    /**
     * 窗口从最小化恢复后，自动尝试「唤活」界面。
     *
     * Chromium 在 Windows 上有个已知问题：恢复后界面看着正常但点不动
     * （QQNT / VS Code / Chrome / Edge 都有报告，见 microsoft/vscode#167556）。
     * 这里做的只是强制重绘 + 聚焦，无害；治不了根，但可能省掉一次任务管理器。
     */
    wakeOnRestore: true
};

let config = { ...defaultConfig };
let meta = { version: 1, items: {} };

// ---------------------------------------------------------------- 基础设施

function ensureDirs() {
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.mkdirSync(libraryPath(), { recursive: true });
}

function libraryPath() {
    return config.libraryPath && config.libraryPath.trim()
        ? path.resolve(config.libraryPath)
        : path.join(pluginRoot, "stickers");
}

let lastRotationCheck = 0;

/**
 * 日志安全阀。
 *
 * 【为什么必须有】踩过一次：右键大表情时，QQ 用 data: URI 内联整张图片，
 * 我们的候选列表把它原样 JSON.stringify 进日志 —— **单行 386,862 字符**，
 * debug.log.old 只有 3 行却有 1.13 MB。而日志是主进程 appendFileSync 同步写的，
 * 每写一次就阻塞一次主线程（托盘菜单都会跟着没反应）。
 *
 * 所以：任何值进日志前都必须截断，整行也要有硬上限。
 */
const LOG_MAX_VALUE = 300;
const LOG_MAX_LINE = 8000;

function clipValue(v) {
    let s;
    if (typeof v === "string") s = v;
    else if (v instanceof Error) s = v.stack || String(v);
    else {
        try {
            s = JSON.stringify(v);
        } catch (e) {
            s = String(v);
        }
    }
    if (typeof s !== "string") s = String(s);
    if (s.length <= LOG_MAX_VALUE) return s;
    const tag = /^data:/i.test(s) ? "data URI" : "长内容";
    return `${s.slice(0, LOG_MAX_VALUE)}…[${tag}已截断，原长 ${s.length} 字符]`;
}

function log(...args) {
    if (!config.debugLog) return;
    try {
        fs.mkdirSync(pluginRoot, { recursive: true });
        // 轮转检查原本每行都要 existsSync + statSync（两次系统调用），
        // 日志一多就是在主进程同步做无用功。改成最多 5 秒查一次。
        const now = Date.now();
        if (now - lastRotationCheck > 5000) {
            lastRotationCheck = now;
            try {
                if (fs.existsSync(logPath) && fs.statSync(logPath).size > 512 * 1024) {
                    fs.renameSync(logPath, logPath + ".old");
                }
            } catch (e) {
                /* ignore */
            }
        }
        let line = `[${new Date().toISOString()}] ${args.map(clipValue).join(" ")}\n`;
        if (line.length > LOG_MAX_LINE) {
            line = `${line.slice(0, LOG_MAX_LINE)}…[整行超长已截断，原长 ${line.length} 字符]\n`;
        }
        fs.appendFileSync(logPath, line, "utf8");
    } catch (e) {
        /* 日志失败不能影响主流程 */
    }
}

// ============================================================ 主进程看门狗
//
// 「QQ 无法交互、托盘也点不掉、只能任务管理器」= 主进程事件循环被卡住。
// 光靠复现猜不出来，所以这里直接测：一个每 500ms 跑一次的定时器，
// 如果实际间隔明显超出预期，说明中间有东西阻塞了事件循环 —— 阻塞一结束
// 这条日志就会落盘，把「什么时候、卡了多久」钉死。
//
// 同时每 30 秒记一次内存，用来判断是不是内存涨到拖垮了它。

const WATCHDOG_INTERVAL = 500;
const WD_REPORT_GAP = 10000; // 两条报告至少隔 10 秒（渲染进程那边曾一晚刷出 808 条）
const WD_SLEEP_HINT = 20000; // 这个量级更像系统休眠
let watchdogTimer = null;
let watchdogLast = 0;
let watchdogWorst = 0;
let watchdogCount = 0;
let watchdogLastReportAt = 0;
let watchdogSuppressed = 0;

function startWatchdog() {
    if (watchdogTimer) return;
    watchdogLast = Date.now();
    watchdogTimer = setInterval(() => {
        const now = Date.now();
        const drift = now - watchdogLast - WATCHDOG_INTERVAL;
        watchdogLast = now;
        if (drift > 250) {
            watchdogCount++;
            if (drift > watchdogWorst) watchdogWorst = drift;

            // 退避：只记第一条，期间的一律合并计数
            if (now - watchdogLastReportAt < WD_REPORT_GAP) {
                watchdogSuppressed++;
                return;
            }
            const extra = watchdogSuppressed ? `，期间另有 ${watchdogSuppressed} 次未记录` : "";
            const hint = drift > WD_SLEEP_HINT ? "（更像系统休眠/挂起，不是阻塞）" : "";
            watchdogSuppressed = 0;
            watchdogLastReportAt = now;
            const mem = process.memoryUsage();
            log(
                `[看门狗] 主进程事件循环被阻塞 ${drift}ms（累计 ${watchdogCount} 次，最久 ${watchdogWorst}ms）` +
                    ` 内存 rss=${Math.round(mem.rss / 1048576)}MB heap=${Math.round(mem.heapUsed / 1048576)}MB${extra}${hint}`
            );
        }
    }, WATCHDOG_INTERVAL);
    // 定时器不能拖住 QQ 退出
    if (watchdogTimer.unref) watchdogTimer.unref();

    // 低频内存快照：内存缓慢泄漏用上面的 drift 是看不出来的
    const memTimer = setInterval(() => {
        const mem = process.memoryUsage();
        log(`[看门狗] 内存 rss=${Math.round(mem.rss / 1048576)}MB heap=${Math.round(mem.heapUsed / 1048576)}MB`);
    }, 30000);
    if (memTimer.unref) memTimer.unref();

    log(`主进程看门狗已启动（每 ${WATCHDOG_INTERVAL}ms 检测一次事件循环阻塞）`);
}

function loadJson(file, fallback) {
    try {
        if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
        log("读取失败", file, String(e));
    }
    return fallback;
}

function saveJson(file, data) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
    } catch (e) {
        log("写入失败", file, String(e));
    }
}

function loadConfig() {
    config = { ...defaultConfig, ...loadJson(configPath, {}) };
    meta = loadJson(metaPath, { version: 1, items: {} });
    if (!meta.items) meta.items = {};
}

/** 绝对路径 -> local:/// 协议 URL（LiteLoader 支持任意绝对路径） */
function toLocalUrl(filePath) {
    const p = path.resolve(filePath).replace(/\\/g, "/");
    const parts = p.split("/");
    return "local:///" + parts.map((s, i) => (i === 0 ? s : encodeURIComponent(s))).join("/");
}

/** 去掉 Windows 文件名非法字符 */
function sanitizeName(name, fallback = "sticker") {
    let base = String(name || "").replace(/\.[^.]*$/, "");
    base = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "").trim();
    if (!base) base = fallback;
    return base.slice(0, 80);
}

/** 按文件头猜图片扩展名 */
function sniffExt(buf) {
    if (!buf || buf.length < 12) return "";
    const b = buf;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return ".png";
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ".jpg";
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return ".gif";
    if (b[0] === 0x42 && b[1] === 0x4d) return ".bmp";
    if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return ".webp";
    const head = b.toString("utf8", 0, 200).trim().toLowerCase();
    if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return ".svg";
    return "";
}

function extOf(p) {
    const e = path.extname(String(p || "")).toLowerCase();
    return IMAGE_EXTS.includes(e) ? e : "";
}

// ---------------------------------------------------------------- 入库

/**
 * 把一段 buffer 落盘到表情库
 * @returns {{ok:boolean, name?:string, duplicated?:boolean, error?:string}}
 */
function saveBuffer(buf, desiredName, source) {
    try {
        if (!buf || !buf.length) return { ok: false, error: "内容为空" };

        const hash = crypto.createHash("sha1").update(buf).digest("hex");

        if (config.dedupe) {
            for (const [name, info] of Object.entries(meta.items)) {
                if (info && info.hash === hash && fs.existsSync(path.join(libraryPath(), name))) {
                    return { ok: true, name, duplicated: true };
                }
            }
        }

        let ext = extOf(desiredName) || sniffExt(buf) || ".png";
        if (sniffExt(buf) === ".svg") ext = ".svg";

        const base = sanitizeName(desiredName, "sticker_" + hash.slice(0, 8));
        let fileName = base + ext;
        let i = 1;
        // 加上限：理论上前缀一直递增总能找到空位，但没有边界就不是"能结束"而是"看起来能结束"
    let dedupeGuard = 0;
    while (fs.existsSync(path.join(libraryPath(), fileName))) {
        if (++dedupeGuard > 5000) throw new Error("同名文件过多，放弃自动重命名: " + fileName);
            // 同名但内容不同（去重已排除同内容）-> 加序号
            fileName = `${base} (${++i})${ext}`;
            if (i > 999) {
                fileName = `${base}_${hash.slice(0, 8)}${ext}`;
                break;
            }
        }

        fs.writeFileSync(path.join(libraryPath(), fileName), buf);
        meta.items[fileName] = { hash, addedAt: Date.now(), source: source || "unknown" };
        saveJson(metaPath, meta);
        log("入库成功", fileName, buf.length + "B", "来源:", source || "unknown");
        return { ok: true, name: fileName };
    } catch (e) {
        log("入库失败", String(e));
        return { ok: false, error: String(e) };
    }
}

/** 把各种来源字符串解析成本地文件路径（返回 null 表示不是本地文件） */
function sourceToLocalPath(src) {
    if (!src || typeof src !== "string") return null;
    let s = src.trim();

    if (s.toLowerCase().startsWith("appimg://")) {
        s = s.slice("appimg://".length);
        try {
            s = decodeURIComponent(s);
        } catch (e) {
            /* 保持原样 */
        }
        s = s.replace(/^\/+/, "");
        // appimg://C:/xxx 或 appimg:///C:/xxx
        if (/^[a-zA-Z]:/.test(s)) return path.normalize(s);
        if (/^[a-zA-Z]\//.test(s)) return path.normalize(s[0] + ":" + s.slice(1));
        return path.normalize(s);
    }

    if (s.toLowerCase().startsWith("file://")) {
        try {
            return require("url").fileURLToPath(s);
        } catch (e) {
            return null;
        }
    }

    if (s.toLowerCase().startsWith("local://")) {
        try {
            const u = new URL(decodeURI(s));
            const rel = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
            if (u.host === "root") return path.join(globalThis.LiteLoader?.path?.root ?? path.join(__dirname, "..", ".."), rel);
            if (u.host === "profile") return path.join(globalThis.LiteLoader?.path?.profile ?? path.join(__dirname, "..", ".."), rel);
            return path.normalize(rel);
        } catch (e) {
            return null;
        }
    }

    // 裸的绝对路径
    if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith("\\\\")) return path.normalize(s);

    return null;
}

const EXT_BY_MIME = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/svg+xml": ".svg",
    "image/avif": ".avif"
};

/** 单个来源 -> {buf, name} */
/**
 * QQ 消息里图片的 src 经常指向缩略图，直接存下来会是一张糊图。
 * 实测的真实目录结构（Emoji/emoji-recv/<月>/ 与 Pic/<月>/ 都一样）：
 *
 *   Ori/04640b9d….jpg          1,696,973 B   ← 原图
 *   Thumb/04640b9d…_720.jpg       30,727 B   ← 缩略图
 *   ThumbTemp/、OriTemp/        是下载中的临时目录
 *
 * 所以规则是：Thumb/xxx_720.gif -> Ori/xxx.gif
 * 依次尝试：兄弟 Ori 目录、同目录去后缀、上级目录，且只在候选确实更大时才采用。
 */
function preferOriginal(p) {
    try {
        const dir = path.dirname(p);
        const base = path.basename(p);
        const ext = path.extname(base);
        const stem = base.slice(0, base.length - ext.length);
        const stripped = stem.replace(/_(?:\d{1,4})$/, "");
        const dirName = path.basename(dir);
        const parent = path.dirname(dir);

        const candidates = [];
        // 1) 兄弟原图目录：Thumb -> Ori，ThumbTemp -> OriTemp
        const oriName = dirName.replace(/^Thumb/i, "Ori");
        if (oriName !== dirName) {
            const oriDir = path.join(parent, oriName);
            if (stripped !== stem) candidates.push(path.join(oriDir, stripped + ext));
            candidates.push(path.join(oriDir, base));
        }
        // 2) 同目录去掉尺寸后缀
        if (stripped !== stem) candidates.push(path.join(dir, stripped + ext));
        // 3) 上级目录
        candidates.push(path.join(parent, base));
        if (stripped !== stem) candidates.push(path.join(parent, stripped + ext));

        const size = (f) => {
            try {
                return fs.statSync(f).size;
            } catch (e) {
                return -1;
            }
        };
        const cur = size(p);
        for (const c of candidates) {
            if (c === p) continue;
            const s = size(c);
            if (s > 0 && s > cur) return c;
        }
    } catch (e) {
        /* 取不到原图就用原来的 */
    }
    return p;
}

async function fetchSource(src) {
    // data: URI —— QQ 的「大表情」/收藏表情经常是内联 base64，没有本地文件可复制。
    // 直接解码存盘，否则这类表情右键根本存不进库。
    if (/^data:/i.test(src)) {
        const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i.exec(src);
        if (!m) throw new Error("无法解析的 data URI");
        const mime = String(m[1] || "image/png").toLowerCase();
        const isB64 = !!m[2];
        const payload = m[3] || "";
        const buf = isB64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
        if (!buf.length) throw new Error("data URI 内容为空");
        const ext = mime.includes("gif")
            ? ".gif"
            : mime.includes("webp")
              ? ".webp"
              : mime.includes("jpeg") || mime.includes("jpg")
                ? ".jpg"
                : mime.includes("png")
                  ? ".png"
                  : "";
        log(`data: URI 已解码：${mime} ${isB64 ? "base64" : "明文"} ${buf.length}B`);
        return { buf, name: "marketface" + ext };
    }

    let local = sourceToLocalPath(src);
    if (local) {
        if (!fs.existsSync(local)) throw new Error("本地文件不存在: " + local);
        const better = preferOriginal(local);
        if (better !== local) {
            log("改用原图替代缩略图", path.basename(local), "->", path.basename(better),
                `(${fs.statSync(local).size}B -> ${fs.statSync(better).size}B)`);
            local = better;
        }
        return { buf: await fs.promises.readFile(local), name: path.basename(local) };
    }

    const s = String(src).trim();

    const dataMatch = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(s);
    if (dataMatch) {
        const mime = dataMatch[1] || "image/png";
        const buf = dataMatch[2]
            ? Buffer.from(dataMatch[3], "base64")
            : Buffer.from(decodeURIComponent(dataMatch[3]), "utf8");
        return { buf, name: "data" + (EXT_BY_MIME[mime] || ".png") };
    }

    if (/^https?:\/\//i.test(s)) {
        // 加超时：原先能无限挂着，那个 IPC 就永远不返回（渲染进程一直等）
        const ac = new AbortController();
        const fetchTimer = setTimeout(() => ac.abort(), 15000);
        let res;
        try {
            res = await net.fetch(s, { credentials: "include", signal: ac.signal });
        } finally {
            clearTimeout(fetchTimer);
        }
        if (!res.ok) throw new Error("HTTP " + res.status);
        const ab = await res.arrayBuffer();
        const mime = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        let guess = "";
        try {
            guess = path.basename(new URL(s).pathname);
        } catch (e) {
            /* ignore */
        }
        return { buf: Buffer.from(ab), name: guess || "remote" + (EXT_BY_MIME[mime] || ".png") };
    }

    throw new Error("不支持的来源: " + s.slice(0, 80));
}

/**
 * 渲染进程抓到的候选来源依次尝试，第一个成功的入库
 * payload: { candidates: string[], bytes?: {name, buffer}, context?: object }
 */
async function saveCandidates(payload) {
    const candidates = Array.isArray(payload?.candidates) ? payload.candidates.filter(Boolean) : [];
    log("收到入库请求", { candidates: candidates.slice(0, 6), context: payload?.context || null });

    // 1) 渲染进程已经转好的字节（blob: 之类）
    if (payload?.bytes?.buffer) {
        const r = saveBuffer(
            Buffer.from(payload.bytes.buffer),
            payload.bytes.name || "sticker",
            payload.bytes.source || "renderer-bytes"
        );
        if (r.ok) return r;
    }

    // 2) 逐个候选来源
    const errors = [];
    for (const src of candidates) {
        try {
            const { buf, name } = await fetchSource(src);
            const r = saveBuffer(buf, name, src.slice(0, 40));
            if (r.ok) return r;
            errors.push(r.error);
        } catch (e) {
            errors.push(String(e.message || e));
        }
    }

    log("全部候选来源都失败", errors);
    return {
        ok: false,
        error: errors.length ? errors.join(" | ") : "没有可用的图片来源（已记录诊断日志）"
    };
}

// ---------------------------------------------------------------- 列表 / 维护

/**
 * 按**文件内容**判断真实类型，不看扩展名。
 *
 * 【为什么必须这样】QQ 缓存给的文件名完全不可信 —— 实测用户库里 8 个文件有 4 个
 * 扩展名与内容不符：
 *   31d92247...jpg  →  内容是 GIF89a（真动图，却被当静态图填成首帧）
 *   19313953...jpg  →  内容是 PNG
 *   a0b3e0ae...jpeg →  内容是 PNG
 *   f10f395b...png  →  内容是 JPEG
 * 这些名字来自 `appimg://.../Ori/<hash>_0.jpg`，QQ 只管存不管后缀。
 * 光看扩展名判断动图，用户新加的动图就永远走不到「按文件填入」那条路。
 */
function sniffKind(file) {
    try {
        const fd = fs.openSync(file, "r");
        // 读 4KB：APNG 的 acTL 块可能不在最开头，多读一点才稳
        const head = Buffer.alloc(4096);
        const n = fs.readSync(fd, head, 0, 4096, 0);
        fs.closeSync(fd);
        const b = head.subarray(0, n);
        if (b.length < 12) return "unknown";
        if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "gif";
        if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
            // APNG 是 PNG 容器里多一个 acTL 块（QQ 的系统表情就是 apng 伪装成 .png）
            return b.includes(Buffer.from("acTL", "ascii")) ? "apng" : "png";
        }
        if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
        if (b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") {
            return "webp";
        }
        return "unknown";
    } catch (e) {
        return "unknown";
    }
}

/** 这个类型能不能动？webp 有可能是静态的，但按动图处理没坏处（走文件上传而已） */
function kindIsAnimated(kind) {
    return kind === "gif" || kind === "apng" || kind === "webp";
}

function listItems(query) {
    const dir = libraryPath();
    let names = [];
    try {
        names = fs.readdirSync(dir).filter((n) => IMAGE_EXTS.includes(path.extname(n).toLowerCase()));
    } catch (e) {
        log("读取库目录失败", String(e));
        return [];
    }

    const q = String(query || "").trim().toLowerCase();
    const items = [];
    for (const name of names) {
        if (q && !name.toLowerCase().includes(q)) continue;
        const full = path.join(dir, name);
        let st;
        try {
            st = fs.statSync(full);
        } catch (e) {
            continue;
        }
        // 真实类型按内容判断，不看扩展名（QQ 给的缓存文件名后缀经常是错的）
        const kind = sniffKind(full);
        items.push({
            name,
            size: st.size,
            mtime: st.mtimeMs,
            addedAt: meta.items?.[name]?.addedAt || st.mtimeMs,
            url: toLocalUrl(full),
            // 绝对路径要给渲染进程：合成 File 时得带上它（Electron 的 File.path），
            // 否则 QQ 的粘贴处理读不到文件内容，会当成「空文件」丢掉
            filePath: full,
            // ★ 渲染进程靠这两个字段决定走「按文件填入」还是「静态首帧」
            kind,
            animated: kindIsAnimated(kind)
        });
    }
    items.sort((a, b) => b.addedAt - a.addedAt);
    log("列表", items.length + " 项", "库:", dir);
    return items;
}

function removeItems(names) {
    let removed = 0;
    for (const name of Array.isArray(names) ? names : []) {
        if (path.basename(name) !== name) continue; // 防目录穿越
        const p = path.join(libraryPath(), name);
        try {
            if (fs.existsSync(p)) {
                fs.unlinkSync(p);
                removed++;
            }
            delete meta.items[name];
        } catch (e) {
            log("删除失败", name, String(e));
        }
    }
    saveJson(metaPath, meta);
    return { ok: true, removed };
}

function renameItem({ oldName, newName }) {
    try {
        if (path.basename(oldName) !== oldName) return { ok: false, error: "非法文件名" };
        const ext = extOf(oldName) || path.extname(oldName) || ".png";
        const target = sanitizeName(newName, "sticker") + ext;
        if (target === oldName) return { ok: true, name: oldName };
        if (fs.existsSync(path.join(libraryPath(), target))) return { ok: false, error: "已存在同名文件" };

        fs.renameSync(path.join(libraryPath(), oldName), path.join(libraryPath(), target));
        if (meta.items[oldName]) {
            meta.items[target] = meta.items[oldName];
            delete meta.items[oldName];
            saveJson(metaPath, meta);
        }
        return { ok: true, name: target };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}

/** 把一组本地文件复制进库 */
function importPaths(paths) {
    let added = 0;
    let duplicated = 0;
    const failed = [];
    for (const p of paths) {
        try {
            if (!fs.statSync(p).isFile()) continue;
            if (!extOf(p) && !sniffExt(fs.readFileSync(p).subarray(0, 32))) continue;
            const r = saveBuffer(fs.readFileSync(p), path.basename(p), "import:" + p);
            if (r.ok && r.duplicated) duplicated++;
            else if (r.ok) added++;
            else failed.push(path.basename(p) + ": " + r.error);
        } catch (e) {
            failed.push(path.basename(p) + ": " + String(e));
        }
    }
    return { ok: true, added, duplicated, failed };
}

// ---------------------------------------------------------------- IPC

/**
 * 找出该操作哪个 webContents。
 * 优先用发消息的那个（Electron 官方拖拽/粘贴示例都是 event.sender），
 * 因为操作期间焦点可能已经变了；拿不到再退回「当前焦点窗口」。
 */
function resolveTargetWebContents(e) {
    try {
        if (e && e.sender && !(typeof e.sender.isDestroyed === "function" && e.sender.isDestroyed())) {
            return e.sender;
        }
    } catch (err) {
        /* 落到下面的兜底 */
    }
    return webContents.getFocusedWebContents() || BrowserWindow.getFocusedWindow()?.webContents || null;
}

/**
 * 拖拽图标。
 *
 * 【关键】webContents.startDrag() 的图标**必须非空**，否则整个拖拽不生效 ——
 * 表现就是"这个文件根本拖不动"。而 Electron 的 nativeImage 只认 PNG/JPEG，
 * 拖 GIF/WebP 时 createFromBuffer 会返回空图。所以解不出来时一定要退回一个
 * 永远可用的内置图标（assets/drag-icon.png，插件自带）。
 */
const DRAG_ICON_PATH = path.join(__dirname, "assets", "drag-icon.png");
// 最后一道保险：即使图标文件丢了，也用内联 PNG 顶上（48x48 圆角方块 + 白星）
const DRAG_ICON_DATA_URL =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAuUlEQVR42u2aSwqAMAxEey9v53Xdu42brgSxNb9JnQF3Bd/DNtDE1pgC2fbzyHjKgqtFUMA/iaDCD0uUFkCHf5UoLVAF/lHC4yXSQ4EMAbmFAhRQwHtIUGAW3lrCRUAGkyIgwXH5Aijwqi2EAK8+A9nwJoc4E960CkWDu5TRaHgKUIACrEJjAjNroAQs1qYJRF01TQQ0IFoJMwGLSxBsY6t8a5ECq3ao1x1wcEbGSeWi8+L//mrABOQCQ7KVTdxOEWcAAAAASUVORK5CYII=";

function makeDragIcon(p) {
    // 1) 能解出图就直接用（PNG/JPEG）
    try {
        const st = fs.statSync(p);
        if (st.size <= 4 * 1024 * 1024) {
            const img = nativeImage.createFromBuffer(fs.readFileSync(p));
            if (!img.isEmpty()) return { icon: img, from: "原图" };
        }
    } catch (e) {
        /* 落到兜底 */
    }
    // 2) 内置图标文件
    try {
        const img = nativeImage.createFromPath(DRAG_ICON_PATH);
        if (!img.isEmpty()) return { icon: img, from: "内置图标文件" };
    } catch (e) {
        /* 落到兜底 */
    }
    // 3) 内联 PNG
    return { icon: nativeImage.createFromDataURL(DRAG_ICON_DATA_URL), from: "内联 PNG" };
}

function registerIpc() {
    /**
     * 统一包一层计时。
     * 主进程里任何超过 150ms 的处理都会留下证据 —— 「QQ 无法交互」这类问题
     * 靠猜是猜不出来的，必须让慢的那一步自己现形。
     */
    const handle = (method, fn) => {
        ipcMain.handle(CH(method), async (e, ...args) => {
            const t0 = Date.now();
            try {
                return await fn(e, ...args);
            } catch (err) {
                log(`IPC ${method} 异常: ${String(err)}`);
                throw err;
            } finally {
                const dt = Date.now() - t0;
                if (dt > 150) log(`[慢] IPC ${method} 耗时 ${dt}ms`);
            }
        });
    };

    handle("getConfig", () => ({ ...config, libraryPathResolved: libraryPath() }));

    handle("setConfig", (e, patch) => {
        config = { ...config, ...(patch || {}) };
        saveJson(configPath, config);
        ensureDirs();
        log("配置已更新", config);
        return { ...config, libraryPathResolved: libraryPath() };
    });

    handle("list", (e, query) => listItems(query));
    handle("stats", () => {
        const items = listItems("");
        return {
            count: items.length,
            bytes: items.reduce((s, i) => s + i.size, 0),
            libraryPath: libraryPath()
        };
    });

    handle("remove", (e, names) => removeItems(names));
    handle("rename", (e, payload) => renameItem(payload || {}));

    /**
     * 兜底插入方案：把图片写进系统剪贴板，然后让页面执行一次「真实粘贴」。
     * 合成 paste 事件在 QQ 里可能被忽略，这条走的是 Chromium 原生粘贴通路。
     * 注意：nativeImage 只认 PNG/JPEG，GIF/WebP 会返回空图，这里如实上报。
     */
    handle("pasteFile", async (e, name) => {
        try {
            const n = String(name || "");
            if (path.basename(n) !== n) return { ok: false, error: "非法文件名" };
            const p = path.join(libraryPath(), n);
            if (!fs.existsSync(p)) return { ok: false, error: "文件不存在: " + n };

            const img = nativeImage.createFromBuffer(fs.readFileSync(p));
            if (img.isEmpty()) {
                log("pasteFile: nativeImage 无法解码该格式（多半是 GIF/WebP），剪贴板方案不可用:", n);
                return { ok: false, unsupported: true, error: "该格式无法放进图片剪贴板" };
            }

            // 计时：剪贴板是全局资源，被别的程序占着时 writeImage 会阻塞主线程，
            // 而主线程一卡，QQ 的托盘菜单都会没反应 —— 所以这里必须留下耗时证据。
            const t0 = Date.now();
            clipboard.writeImage(img);
            const t1 = Date.now();
            const wc = resolveTargetWebContents(e);
            if (!wc) return { ok: false, error: "找不到焦点窗口，无法粘贴" };
            wc.paste();
            const t2 = Date.now();
            log(`pasteFile: 已写入剪贴板并触发真实粘贴 ${n} ${JSON.stringify(img.getSize())} 耗时 clipboard=${t1 - t0}ms paste=${t2 - t1}ms`);
            if (t1 - t0 > 300) log("pasteFile 警告：剪贴板写入耗时过长，可能有别的程序占用剪贴板");
            return { ok: true, size: img.getSize(), timing: { clipboard: t1 - t0, paste: t2 - t1 } };
        } catch (err) {
            log("pasteFile 失败", String(err));
            return { ok: false, error: String(err) };
        }
    });

    /**
     * 原生拖拽：把库里的真实文件交给 Chromium 发起一次真正的文件拖放。
     * 用户在面板里把表情拖到输入框，QQ 收到的是货真价实的文件拖放
     * （和从资源管理器拖文件完全一样），所以 **动图能保住动画**，
     * 也不占用系统剪贴板、不需要任何合成事件。
     */
    handle("startDrag", (e, name) => {
        try {
            const n = String(name || "");
            if (path.basename(n) !== n) return { ok: false, error: "非法文件名" };
            const p = path.join(libraryPath(), n);
            if (!fs.existsSync(p)) return { ok: false, error: "文件不存在: " + n };

            // 用发消息的那个 webContents，而不是「当前焦点窗口」。
            // Electron 官方拖出文件的例子就是 event.sender.startDrag(...)：
            // 拖拽期间焦点可能已经变了，用 event.sender 才是可靠的。
            const wc = resolveTargetWebContents(e);
            if (!wc) return { ok: false, error: "找不到可拖拽的窗口" };

            // 拖拽图标必须非空，否则 startDrag 整个不生效（GIF/WebP 就会"拖不动"）
            const { icon, from } = makeDragIcon(p);
            if (!icon || icon.isEmpty()) {
                log("startDrag: 图标仍然为空，拖拽可能不生效", n);
            }

            // startDrag 在 Windows 上会跑一个嵌套消息循环，直到拖放结束才返回。
            // 前后各记一笔：只看到「开始」没有「结束」= 它卡住了。
            const dragT0 = Date.now();
            log("startDrag: 开始（等待拖放结束）", n);
            wc.startDrag({ file: p, icon });
            log(`startDrag: 结束，阻塞了 ${Date.now() - dragT0}ms`);
            log(`startDrag: 已发起原生拖拽 ${n}（图标来源: ${from}）`);
            return { ok: true, iconFrom: from };
        } catch (err) {
            log("startDrag 失败", String(err));
            return { ok: false, error: String(err) };
        }
    });


    /**
     * 最小化恢复后「唤活」窗口。
     *
     * 【背景】Chromium 在 Windows 上有个存在多年的已知问题：窗口从最小化等状态恢复后，
     * 界面看起来完全正常，但**点哪里都没反应**（鼠标没冻结，最大化/最小化本身也正常）。
     * 这不是本插件引起的 —— QQNT、VS Code、Chrome、Edge 都有人报告同样症状
     * （见 microsoft/vscode#167556），根因指向 Chromium 的 GPU 渲染管线。
     * 也正因为卡在那一层，我的看门狗测不到它：主进程事件循环只记录了 253ms，一切"正常"。
     *
     * 社区 workaround 是在输入框里右键 → 粘贴任意字符，本质是**给窗口一个输入事件**
     * 把它从假死中唤醒。这里在窗口恢复可见时自动做一次等价操作：强制重绘 + 聚焦。
     * 治不了根，但可能省掉一次任务管理器。
     */
    handle("wakeWindow", (e) => {
        const wc = resolveTargetWebContents(e);
        if (!wc) return { ok: false, error: "找不到窗口" };
        const done = [];
        try {
            wc.invalidate(); // 强制重绘，最接近"唤醒渲染管线"的无害操作
            done.push("invalidate");
        } catch (err) {
            log("wakeWindow: invalidate 失败 " + String(err));
        }
        try {
            wc.focus();
            done.push("focus");
        } catch (err) {
            log("wakeWindow: focus 失败 " + String(err));
        }
        log("wakeWindow: 窗口恢复可见，已尝试唤醒（" + done.join("+") + "）");
        return { ok: done.length > 0, done };
    });

    /**
     * 把渲染进程转好的 PNG 字节写进剪贴板并触发真实粘贴。
     * GIF/WebP 无法走 pasteFile（nativeImage 解不了），渲染进程会用 canvas 取首帧转 PNG
     * 后从这里进来。
     */
    handle("pastePng", async (e, name, buffer) => {
        try {
            const buf = Buffer.from(buffer || []);
            if (!buf.length) return { ok: false, error: "收到空字节" };
            const img = nativeImage.createFromBuffer(buf);
            if (img.isEmpty()) return { ok: false, error: "PNG 解码失败" };

            const t0 = Date.now();
            clipboard.writeImage(img);
            const t1 = Date.now();
            const wc = resolveTargetWebContents(e);
            if (!wc) return { ok: false, error: "找不到焦点窗口，无法粘贴" };
            wc.paste();
            log(`pastePng: 已写入剪贴板并触发真实粘贴 ${String(name || "")} ${buf.length}B 耗时 clipboard=${t1 - t0}ms`);
            return { ok: true, size: img.getSize() };
        } catch (err) {
            log("pastePng 失败", String(err));
            return { ok: false, error: String(err) };
        }
    });

    /**
     * 把库里的某个文件读成字节交给渲染进程。
     * 这是「填入输入框」的兜底通道：首选 local:// 协议 fetch，
     * 万一该协议在渲染进程里不可用，就用这条路把图交过去。
     */
    handle("readFile", (e, name) => {
        try {
            const n = String(name || "");
            if (path.basename(n) !== n) return { ok: false, error: "非法文件名" };
            const p = path.join(libraryPath(), n);
            if (!fs.existsSync(p)) return { ok: false, error: "文件不存在: " + n };
            const buf = fs.readFileSync(p);
            const ext = (extOf(n) || sniffExt(buf) || ".png").slice(1);
            const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "svg" ? "image/svg+xml" : "image/" + ext;
            return {
                ok: true,
                name: n,
                type: mime,
                size: buf.length,
                // 必须按 byteOffset/byteLength 切，Node 的 Buffer 可能是共享内存池里的视图
                buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
            };
        } catch (err) {
            log("readFile 失败", String(err));
            return { ok: false, error: String(err) };
        }
    });

    handle("saveCandidates", async (e, payload) => {
        ensureDirs();
        return await saveCandidates(payload || {});
    });

    handle("importFiles", async () => {
        const r = await dialog.showOpenDialog({
            title: "选择要导入表情库的图片（可多选）",
            properties: ["openFile", "multiSelections", "dontAddToRecent"],
            filters: [{ name: "图片", extensions: IMAGE_EXTS.map((x) => x.slice(1)) }]
        });
        if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
        return importPaths(r.filePaths);
    });

    handle("importFolder", async () => {
        const r = await dialog.showOpenDialog({
            title: "选择要导入的文件夹（只扫描一层）",
            properties: ["openDirectory", "dontAddToRecent"]
        });
        if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
        const dir = r.filePaths[0];
        let files = [];
        try {
            files = fs
                .readdirSync(dir)
                .map((n) => path.join(dir, n))
                .filter((p) => {
                    try {
                        return fs.statSync(p).isFile() && IMAGE_EXTS.includes(path.extname(p).toLowerCase());
                    } catch (e) {
                        return false;
                    }
                });
        } catch (e) {
            return { ok: false, error: String(e) };
        }
        log("从文件夹导入", dir, files.length + " 个文件");
        return importPaths(files);
    });

    handle("chooseLibrary", async () => {
        const r = await dialog.showOpenDialog({
            title: "选择表情库目录",
            properties: ["openDirectory", "createDirectory", "dontAddToRecent"]
        });
        if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
        config.libraryPath = r.filePaths[0];
        saveJson(configPath, config);
        ensureDirs();
        log("库目录已切换", config.libraryPath);
        return { ok: true, libraryPath: libraryPath() };
    });

    handle("openLibrary", async () => {
        ensureDirs();
        const err = await shell.openPath(libraryPath());
        return err ? { ok: false, error: err } : { ok: true };
    });

    handle("reveal", (e, name) => {
        if (path.basename(String(name)) !== String(name)) return { ok: false };
        shell.showItemInFolder(path.join(libraryPath(), String(name)));
        return { ok: true };
    });

    handle("clearLibrary", async () => {
        const items = listItems("");
        if (!items.length) return { ok: true, removed: 0 };
        const r = await dialog.showMessageBox({
            type: "warning",
            title: "清空本地表情库",
            message: `确定要删除库里的 ${items.length} 个表情文件吗？`,
            detail: "文件将从磁盘删除，不进回收站。目录：" + libraryPath(),
            buttons: ["取消", "删除"],
            defaultId: 0,
            cancelId: 1,
            noLink: true
        });
        if (r.response !== 1) return { ok: false, canceled: true };
        let removed = 0;
        for (const it of items) {
            try {
                fs.unlinkSync(path.join(libraryPath(), it.name));
                removed++;
            } catch (e) {
                /* ignore */
            }
        }
        meta.items = {};
        saveJson(metaPath, meta);
        log("已清空库", removed + " 个文件");
        return { ok: true, removed };
    });

    handle("log", (e, message) => {
        log("[renderer]", message);
        return true;
    });

    handle("openLog", async () => {
        try {
            if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, "", "utf8");
            const err = await shell.openPath(logPath);
            return err ? { ok: false, error: err } : { ok: true, path: logPath };
        } catch (e) {
            return { ok: false, error: String(e) };
        }
    });

    handle("openPath", async (e, p) => {
        const err = await shell.openPath(String(p));
        return err ? { ok: false, error: err } : { ok: true };
    });
}

// ---------------------------------------------------------------- 启动

function onLoad() {
    loadConfig();
    ensureDirs();
    registerIpc();

    // 首次运行时把默认配置写出来，方便用户手改
    if (!fs.existsSync(configPath)) saveJson(configPath, config);
    if (!fs.existsSync(metaPath)) saveJson(metaPath, meta);

    log("=========== 插件加载 ===========");
    log("库目录:", libraryPath());
    try {
        const LL = globalThis.LiteLoader;
        log("LiteLoader:", LL?.versions?.liteloader, "QQNT:", LL?.versions?.qqnt);
        log("Electron:", LL?.versions?.electron, "Node:", LL?.versions?.node, "平台:", LL?.os?.platform);
    } catch (e) {
        log("读取 LiteLoader 版本信息失败: " + String(e));
    }

    startWatchdog();
}

onLoad();

module.exports = {};
