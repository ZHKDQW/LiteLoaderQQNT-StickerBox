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
    panelEntry: true
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

// ============================================================ 文件剪贴板（走 Shell 的 copy 动词）
//
// 【为什么非要这么绕】QQ 只有把图片当成**文件**才走原文件上传，动画才保得住。三条硬门槛：
//   1. Electron 写不了 CF_HDROP —— clipboard.writeBuffer("CF_HDROP", buf) 里的名字会被
//      RegisterClipboardFormat 注册成一个**同名的自定义格式**（实测 49902，而预定义的是 15）。
//   2. 光有 CF_HDROP 也不够 —— Set-Clipboard -LiteralPath 只写 5 种格式，而资源管理器
//      Ctrl+C 会写 13 种（多出 FileGroupDescriptorW、Preferred DropEffect、Shell IDList
//      Array 等）。QQ 只认后者，自己拼这些格式又太复杂。
//   3. ★最关键★ InvokeVerb('copy') 用的是 **OLE 延迟渲染**：真正的格式由**源进程按需渲染**。
//      所以执行完就退出的进程等于白干 —— 实测退出后剪贴板只剩 DataObject 空壳（2 种格式）。
//      **必须让那个进程活着**，QQ 才能取到数据。
//
// 所以这里的做法：起一个 PowerShell 做 InvokeVerb，然后让它 Sleep 一小时持有剪贴板。
// 同一个文件重复点击时直接复用（0 延迟）；换文件才重启（约 1.5 秒）。

const CLIP_READY = path.join(app.getPath("temp"), "sb-clip-ready.txt");
const CLIP_VBS_PATH = path.join(app.getPath("temp"), "sb-clip-hold.vbs");

// 【必须纯 ASCII】用 fs.writeFileSync(..., "ascii") 写含中文的内容会出事：
// Node 的 ascii 编码把每个 >127 的字节截断成 7 位，中文的 UTF-8 三字节被切碎后，
// 有的碎片正好是 \n —— 注释行被劈成两半，cscript 直接报语法错误。
// 所以这里的注释一律写英文，并且下面有一道断言把关。
const CLIP_VBS_SOURCE = [
    "Option Explicit",
    "Dim ws, sh, it, fso, f, dir, name, ready, i",
    'Set ws = CreateObject("WScript.Shell")',
    'dir   = ws.Environment("Process")("SB_DIR")',
    'name  = ws.Environment("Process")("SB_NAME")',
    'ready = ws.Environment("Process")("SB_READY")',
    'Set sh = CreateObject("Shell.Application")',
    "Set it = sh.Namespace(dir).ParseName(name)",
    "If it Is Nothing Then",
    '  WScript.Echo "__SB_CLIP_NOTFOUND__"',
    "  WScript.Quit 3",
    "End If",
    'it.InvokeVerb "copy"',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    "Set f = fso.CreateTextFile(ready, True)",
    'f.WriteLine "ready"',
    "f.Close",
    "' Hold the clipboard open: OLE delayed rendering needs this process alive.",
    "' NOTE: WScript.Sleep takes a 16-bit integer (max 32767). Passing 60000",
    "'       overflows silently, the call gets skipped, and the process exits.",
    "For i = 1 To 60",
    "  WScript.Sleep 1000",
    "Next"
].join("\r\n");

// 把关：一旦有人往这里加了非 ASCII 字符，立刻在日志里喊出来
if (/[^\x00-\x7F]/.test(CLIP_VBS_SOURCE)) {
    // 这里不能用 log()（它依赖 config，而这段在模块顶层执行，config 还没准备好）
    console.error("[sticker_box] 剪贴板脚本含非 ASCII 字符，会被写坏！");
}

let clipVbsPath = null;

function ensureClipVbs() {
    // 【每次加载都重写】不要"存在就复用"：上一版曾经把含中文的脚本用 ascii 编码写坏，
    // 如果复用那份坏文件，用户重启一百次也还是坏的。文件才几百字节，重写成本可以忽略。
    try {
        fs.writeFileSync(CLIP_VBS_PATH, CLIP_VBS_SOURCE, "ascii");
        clipVbsPath = CLIP_VBS_PATH;
        return clipVbsPath;
    } catch (e) {
        log("写剪贴板脚本失败: " + String(e));
        return null;
    }
}

let clipHolder = null; // 持有剪贴板的子进程（用完就收，绝不留常驻）
let clipReadyPath = null; // 当前剪贴板里准备好的是哪个文件
let clipIdleTimer = null; // 预填后闲置回收的定时器

function killClipHolder() {
    if (clipHolder) {
        const pid = clipHolder.pid;
        // ★★★ 必须先清空剪贴板，再杀进程 ★★★
        //
        // InvokeVerb('copy') 用的是 OLE **延迟渲染**：剪贴板里存的不是数据本身，
        // 而是"待会儿按需渲染"的承诺，由这个持有进程负责兑现。
        //
        // 直接 child.kill()（= TerminateProcess 强杀）时进程没机会清理，
        // 剪贴板里就留下一个**悬空的 OLE 引用** —— 数据源已经死了。
        // 之后任何程序去**读**它（注意：不只是枚举格式）都会挂住，
        // 包括 QQ 自己的剪贴板监听。症状就是：填入成功，一发送 QQ 就无法交互、
        // 托盘也关不掉，只能任务管理器。
        //
        // clipboard.clear() 也是一次"写剪贴板"，会把那个悬空引用顶掉，
        // 所以顺序必须是先 clear 再 kill。
        try {
            clipboard.clear();
        } catch (e) {
            log("清空剪贴板失败（仍然回收进程）: " + String(e));
        }
        try {
            if (clipHolder.exitCode === null) clipHolder.kill();
        } catch (e) {
            /* ignore */
        }
        log(`剪贴板持有进程 pid=${pid} 已回收（先清了剪贴板，避免留下悬空引用）`);
    }
    clipHolder = null;
    clipReadyPath = null;
}

/** 让一个进程把 filePath 放进剪贴板；数据取走后立刻回收它 */
function holdFileInClipboard(filePath, timeoutMs = 9000) {
    return new Promise((resolve) => {
        // 上一版这里是"同一个文件就复用"，但日志显示复用从来没命中过，
        // 每次点击都新建一个 PowerShell（约 80MB）堆在那里 —— 用户实测就是
        // 这样把系统拖垮的（QQ 无法交互、托盘没反应）。现在改成用完就收。
        killClipHolder();
        try {
            fs.unlinkSync(CLIP_READY);
        } catch (e) {
            /* 没有就算了 */
        }

        let proc;
        let out = "";
        let err = "";
        const t0 = Date.now();
        try {
            // 用 cscript 而不是 PowerShell：实测就绪快 26%（859ms vs 1161ms —— 后者要加载
            // 整个 .NET 运行时），对系统的扰动也更小。路径仍然走环境变量。
            const vbs = ensureClipVbs();
            if (!vbs) return resolve(false);
            proc = spawn(
                "cscript.exe",
                ["//nologo", vbs],
                {
                    windowsHide: true,
                    stdio: ["ignore", "pipe", "pipe"],
                    env: {
                        ...process.env,
                        SB_DIR: path.dirname(filePath),
                        SB_NAME: path.basename(filePath),
                        SB_READY: CLIP_READY
                    }
                }
            );
        } catch (e) {
            log("剪贴板持有进程启动失败: " + String(e));
            return resolve(false);
        }
        clipHolder = proc;
        proc.stdout.on("data", (d) => (out += String(d)));
        proc.stderr.on("data", (d) => (err += String(d)));
        proc.on("error", (e) => log("剪贴板持有进程错误: " + String(e)));

        const tick = () => {
            if (fs.existsSync(CLIP_READY)) {
                // 再给 OLE 一点时间把格式挂上去
                setTimeout(() => {
                    log(`剪贴板已就绪（${Date.now() - t0}ms，pid=${proc.pid}）`);
                    resolve(true);
                }, 120);
                return;
            }
            if (proc.exitCode !== null) {
                log(`剪贴板持有进程提前退出 code=${proc.exitCode} out=${JSON.stringify(out.slice(0, 120))} err=${JSON.stringify(err.slice(0, 300))}`);
                return resolve(false);
            }
            if (Date.now() - t0 > timeoutMs) {
                log(`剪贴板就绪超时 ${timeoutMs}ms  out=${JSON.stringify(out.slice(0, 120))} err=${JSON.stringify(err.slice(0, 300))}`);
                try {
                    proc.kill();
                } catch (e) {
                    /* ignore */
                }
                return resolve(false);
            }
            setTimeout(tick, 80);
        };
        tick();
    });
}

// 串行队列：剪贴板是全局资源，并发会互相覆盖。
//
// 【注意】不是"忙就直接失败"。上一版写成 `if (clipBusy) return false`，
// 结果悬停预填还在跑的时候点击就会立刻失败 —— 用户看到的就是"回退到静态首帧"，
// 而且日志里只有 8ms 就返回了，根本没试。现在改成**排队**，前一个做完接着做。
let clipQueue = Promise.resolve();

function clipboardCopyFile(filePath, timeoutMs = 9000) {
    const run = () => holdFileInClipboard(filePath, timeoutMs);
    const p = clipQueue.then(run, run);
    clipQueue = p.then(
        () => {},
        () => {}
    );
    return p;
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
     * ★ 动图一键装填：用真正的 CF_HDROP ★
     *
     * 【为什么必须借外部进程】
     * Windows 上"剪贴板里有一个文件"就是 CF_HDROP 格式。Electron 写不了它：
     * clipboard.writeBuffer("CF_HDROP", buf) 里的名字会被 RegisterClipboardFormat
     * 注册成一个**同名的自定义格式**（实测返回 49902，而预定义的 CF_HDROP 是 15，
     * 字符串名字不会被映射到预定义常量）。
     *
     * 同理，Chromium 在剪贴板里读到 CF_HDROP 时对外报的是 text/uri-list ——
     * 那是它的内部别名，跟我们自己写一个叫 "text/uri-list" 的格式完全是两回事。
     * （这一条是实测踩出来的：自己写 text/uri-list，QQ 毫无反应。）
     *
     * 但**光有 CF_HDROP 也不够**：实测 Set-Clipboard -LiteralPath 只写 5 种格式，
     * 而资源管理器 Ctrl+C 会写 12 种（多出 FileGroupDescriptorW、Preferred DropEffect、
     * Shell IDList Array 等），QQ 只认后者。所以这里走 `InvokeVerb('copy')`，
     * 让 Shell 自己把完整格式集写进去。
     */
    handle("pasteFileAsDrop", async (e, name) => {
        try {
            const n = String(name || "");
            if (path.basename(n) !== n) return { ok: false, error: "非法文件名" };
            const p = path.join(libraryPath(), n);
            if (!fs.existsSync(p)) return { ok: false, error: "文件不存在: " + n };

            // 悬停时已经准备好了就直接粘贴 —— 这就是"感觉 0 延迟"的来源。
            // 每次准备都必然要起一个进程（Electron 自己写不了 CF_HDROP），
            // 所以唯一能把体感延迟压下去的办法就是提前准备。
            const t0 = Date.now();
            let usedCache = false;
            if (clipReadyPath === p && clipHolder && clipHolder.exitCode === null) {
                usedCache = true;
                clearTimeout(clipIdleTimer);
            } else {
                const wrote = await clipboardCopyFile(p);
                if (!wrote) return { ok: false, error: "剪贴板助手不可用（见日志）" };
                clipReadyPath = p;
            }
            const prepareMs = Date.now() - t0;
            if (usedCache) log(`pasteFileAsDrop: 悬停预填命中，0 等待（${n}）`);

            const wc = resolveTargetWebContents(e);
            if (!wc) return { ok: false, error: "找不到窗口" };
            wc.paste();
            log(`pasteFileAsDrop: ${n} 已粘贴（准备耗时 ${prepareMs}ms${usedCache ? "，来自预填" : ""}）`);
            // QQ 读剪贴板是异步的，给它 3 秒再回收。
            //
            // 【只回收"自己这一代"】上一版是无条件 killClipHolder()，结果这个定时器到点时
            // 如果用户已经悬停到下一个动图、预填了新进程，就会把**新的**那个杀掉 ——
            // 日志里"剪贴板已就绪"之后 1.4 秒就出现"已回收"，就是这么来的。
            const myGeneration = clipHolder;
            setTimeout(() => {
                if (clipHolder === myGeneration) {
                    killClipHolder();
                    clipReadyPath = null;
                }
            }, 3000);
            return { ok: true, prepareMs, fromCache: usedCache };
        } catch (err) {
            log("pasteFileAsDrop 失败: " + String(err));
            return { ok: false, error: String((err && err.message) || err) };
        }
    });


    /**
     * 悬停预填：鼠标停在动图上时提前把剪贴板准备好，点下去就不用等那 859ms。
     *
     * 每次准备都必须起一个进程（Electron 写不了 CF_HDROP），所以这是唯一能把
     * 体感延迟压到接近 0 的办法。预填后 15 秒没用上就回收，不白占着。
     */
    handle("prepareDrop", async (e, name) => {
        try {
            const n = String(name || "");
            if (path.basename(n) !== n) return { ok: false, error: "非法文件名" };
            const p = path.join(libraryPath(), n);
            if (!fs.existsSync(p)) return { ok: false, error: "文件不存在: " + n };
            if (clipReadyPath === p && clipHolder && clipHolder.exitCode === null) {
                return { ok: true, cached: true };
            }
            const ok = await clipboardCopyFile(p);
            if (ok) {
                clipReadyPath = p;
                clearTimeout(clipIdleTimer);
                const myGeneration = clipHolder;
                clipIdleTimer = setTimeout(() => {
                    if (clipHolder !== myGeneration) return; // 已经换过一代了，别动新的
                    log("预填超时未使用，回收持有进程");
                    killClipHolder();
                    clipReadyPath = null;
                }, 15000);
            }
            return { ok, cached: false };
        } catch (err) {
            return { ok: false, error: String((err && err.message) || err) };
        }
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

    // 退出时把持有剪贴板的子进程收掉，别留孤儿
    try {
        app.on("will-quit", () => killClipHolder());
    } catch (e) {
        /* ignore */
    }
}

onLoad();

module.exports = {};
