/**
 * 本地表情包库 - 渲染进程
 *
 * 功能：
 *  1. 在聊天工具栏（.chat-func-bar）注入「本地表情包库」按钮，点开库面板
 *  2. 面板里点某个表情 -> 直接填入输入框（模拟粘贴给 CKEditor 5）
 *  3. 聊天消息右键 -> 追加「存入本地表情库」
 *  4. 设置页：库目录 / 导入 / 清空 / 关闭后行为 / 诊断日志
 *  5. 诊断采集：把疑似表情面板的 DOM 与 Vue 组件名写进日志，供精确适配
 *
 * 依赖的选择器（来自 LiteLoaderQQNT 生态的既有实践）：
 *  - .chat-func-bar           聊天工具栏
 *  - .q-context-menu          QQ 原生右键菜单
 *  - .ck.ck-content.ck-editor__editable   CKEditor 5 输入框
 *  - appimg://                 QQ 图片的本地路径协议
 */

const SLUG = "sticker_box";

// 顶层一定要防御：如果 preload 或 LiteLoader.plugins 还没就绪就抛错，
// 整个模块会静默失败，连一行日志都留不下（而 QQNT 又没有 DevTools）。
const api = window[SLUG];
const PLUGIN_DIR = LiteLoader?.plugins?.[SLUG]?.path?.plugin || "";
const PLUGIN_URL = PLUGIN_DIR
    ? "local:///" +
      PLUGIN_DIR.replace(/\\/g, "/")
          .split("/")
          .map((s, i) => (i === 0 ? s : encodeURIComponent(s)))
          .join("/")
    : "";

/** 最后的兜底：连 api 都没有时，直接在界面上报错，至少用户看得见 */
function fatalBanner(text) {
    console.error("[sticker_box]", text);
    try {
        const el = document.createElement("div");
        el.textContent = "[本地表情包库] " + text;
        el.style.cssText =
            "position:fixed;left:12px;bottom:12px;z-index:99999;padding:8px 12px;border-radius:6px;" +
            "background:rgba(180,40,40,.92);color:#fff;font-size:12px;max-width:60vw;";
        (document.body || document.documentElement).appendChild(el);
    } catch (e) {
        /* 无能为力了 */
    }
}

if (!api) {
    fatalBanner("preload 没有暴露 window." + SLUG + "，请检查 preload.js 是否被 LiteLoader 加载");
}
if (!PLUGIN_DIR) {
    fatalBanner("拿不到插件目录（LiteLoader.plugins." + SLUG + " 为空）");
}

const ICON_SVG = `<svg class="q-icon" viewBox="0 0 24 24" width="18" height="18" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M12 2.6l2.72 5.51 6.08.89-4.4 4.29 1.04 6.05L12 16.49l-5.44 2.85 1.04-6.05-4.4-4.29 6.08-.89L12 2.6z"/></svg>`;
const DRAG_ICON_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M12 2.6l2.72 5.51 6.08.89-4.4 4.29 1.04 6.05L12 16.49l-5.44 2.85 1.04-6.05-4.4-4.29 6.08-.89L12 2.6z"/></svg>`;

let config = { libraryPathResolved: "", closeAfterInsert: false, panelEntry: true };
let library = [];
let panelEl = null;
let panelAnchor = null;
let toastEl = null;

/**
 * 日志安全阀（渲染进程侧）。
 *
 * 【踩过的坑】右键大表情时 QQ 用 data: URI 内联整张图片，候选列表被原样
 * JSON.stringify 后经 IPC 送给主进程落盘 —— 单行 386,862 字符，
 * 3 行日志就有 1.13 MB。既白占磁盘，又让主进程同步写盘时卡住（托盘都会没反应）。
 *
 * 所以在**送出去之前**就截断：既省 IPC 流量，也省主进程的内存和磁盘。
 */
const LOG_MAX_VALUE = 300;

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

const log = (...args) => {
    try {
        api.log(args.map(clipValue).join(" "));
    } catch (e) {
        /* ignore */
    }
};

/** 把候选地址压成一行摘要：data: URI 只记类型和长度，绝不整条打出来 */
function summarizeSource(u) {
    const s = String(u || "");
    if (/^data:/i.test(s)) {
        const m = /^data:([^;,]+)/i.exec(s);
        return `data-uri(${m ? m[1] : "?"},${Math.round(s.length / 1024)}KB)`;
    }
    if (s.length > 160) return `${s.slice(0, 160)}…[原长 ${s.length}]`;
    return s;
}

// ============================================================ 小工具

/**
 * 反复执行 fn：QQ 会在切聊天/重渲染时重建工具栏，
 * 只监听「出现一次」不够，必须周期性补注入。
 */
function poll(fn, interval = 300) {
    const tick = () => {
        try {
            fn();
        } catch (e) {
            log("轮询回调异常: " + String(e));
        }
    };
    tick();
    return setInterval(tick, interval);
}

function toast(message, isError = false) {
    if (!toastEl) {
        toastEl = document.createElement("div");
        toastEl.className = "sb-toast";
        document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.classList.toggle("sb-toast--error", !!isError);
    toastEl.classList.add("sb-toast--show");
    clearTimeout(toastEl.__timer);
    toastEl.__timer = setTimeout(() => toastEl.classList.remove("sb-toast--show"), isError ? 5000 : 2400);
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

// ============================================================ 注入样式

if (PLUGIN_URL) {
    const styleLink = document.createElement("link");
    styleLink.rel = "stylesheet";
    styleLink.href = PLUGIN_URL + "/style.css";
    document.head.appendChild(styleLink);
}

// ============================================================ 工具栏入口（原生位置）
//
// 这里**必须**插进 .func-bar，不能用固定浮层对位。原因：QQ 的工具栏不悬停时会折叠图标
// （CSS 规则大致是 `.chat-func-bar:not(:hover) .func-bar .bar-icon:not(:nth-child(1)) { display:none }`），
// 浮层跟不上这个折叠行为，所以看着"位置不对、很别扭"。
// 克隆一个真的 .bar-icon 插进去，才会跟随 QQ 自己那套显隐/悬停样式。
//
// 与早期会崩溃的版本的区别：
//   - 没有 MutationObserver（早期是「观察器 + 反复插入」互相放大）
//   - 现在由 1.2 秒一次的轮询驱动，并且有 5 秒冷却，插不进去也不追着抢
//   - 不做任何子树查询，成本可忽略

let toolbarEntry = null;
let lastBarInjectAt = 0;
let barInjectCount = 0;
let entryPollTimer = null;

function buildToolbarButton(template) {
    let btn;
    if (template) {
        btn = template.cloneNode(true);
        btn.removeAttribute("id");
        btn.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
        const iconHost = btn.querySelector(".q-icon") || btn.querySelector("i");
        if (iconHost) iconHost.innerHTML = ICON_SVG;
        else btn.insertAdjacentHTML("afterbegin", ICON_SVG);
        const tip = btn.querySelector(".q-tooltips__content");
        if (tip) tip.textContent = "本地表情包库";
    } else {
        btn = document.createElement("div");
        btn.className = "bar-icon";
        btn.innerHTML = `<i class="q-icon">${ICON_SVG}</i>`;
    }
    btn.classList.add("sb-bar-icon");
    btn.setAttribute("title", "本地表情包库（左键打开 / 右键打开库目录）");
    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        togglePanel(btn);
    });
    btn.addEventListener("contextmenu", (e) => {
        e.stopPropagation();
        e.preventDefault();
        api.openLibrary();
    });
    return btn;
}

/**
 * 找到「图标所在的那一行」。
 *
 * QQ 的工具栏里有**多个** .func-bar（momotalk 主题的 CSS 里就能看到
 * `.chat-func-bar .func-bar:nth-child(1)` / `:nth-child(2)`）。
 * 早期用 document.querySelector(".chat-func-bar .func-bar") 取到的是第一行，
 * 而图标其实在另一行里，结果星标被塞到了图标行上方 —— 用户截图里那颗"飘着的星"。
 *
 * 所以这里按「这一行里有没有 .bar-icon」来选，而不是按顺序取第一个。
 */
function findToolbarIconRow() {
    const bars = [...document.querySelectorAll(".chat-func-bar .func-bar")];
    const iconRows = bars.filter((b) => b.querySelector(".bar-icon"));
    if (iconRows.length) return iconRows[iconRows.length - 1];
    return (
        document.querySelector(".chat-func-bar")?.lastElementChild ||
        document.querySelector(".chat-func-bar") ||
        null
    );
}

function ensureToolbarEntry() {
    if (config.panelEntry === false) {
        if (toolbarEntry && toolbarEntry.isConnected) toolbarEntry.remove();
        toolbarEntry = null;
        return;
    }
    // 还在原位就不用管
    if (toolbarEntry && toolbarEntry.isConnected) return;

    const funcBar = findToolbarIconRow();
    if (!funcBar) {
        toolbarEntry = null;
        return;
    }

    // 冷却：Vue 重渲染会把我们克隆的节点清掉，不跟它抢，最多 5 秒补一次
    const now = Date.now();
    if (now - lastBarInjectAt < 5000) return;
    lastBarInjectAt = now;
    barInjectCount++;

    toolbarEntry = buildToolbarButton(funcBar.querySelector(".bar-icon"));
    funcBar.appendChild(toolbarEntry);
    log(`工具栏入口已插入（第 ${barInjectCount} 次，所在行 .bar-icon 数量=${funcBar.querySelectorAll(".bar-icon").length}）`);
}

// ============================================================ 表情库面板

function closePanel() {
    if (panelEl) {
        panelEl.remove();
        panelEl = null;
        panelAnchor = null;
    }
}

function positionPanel() {
    if (!panelEl || !panelAnchor) return;
    const r = panelAnchor.getBoundingClientRect();
    const w = panelEl.offsetWidth || 400;
    const h = panelEl.offsetHeight || 340;
    let left = r.left - 40;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = r.top - h - 12;
    if (top < 8) top = Math.min(window.innerHeight - h - 8, r.bottom + 12);
    panelEl.style.left = left + "px";
    panelEl.style.top = Math.max(8, top) + "px";
}

async function togglePanel(anchor) {
    if (panelEl) {
        if (panelEl.isConnected) {
            closePanel();
            return;
        }
        // 面板已被外部移除（例如 QQ 重渲染了 DOM），此时不能当成「已打开」，
        // 否则点一下只会清空状态、看起来像按钮失灵。重置后继续往下走去打开。
        panelEl = null;
        panelAnchor = null;
    }
    panelAnchor = anchor;
    panelEl = document.createElement("div");
    panelEl.className = "sb-panel";
    panelEl.innerHTML = `
        <div class="sb-head">
            <span class="sb-title">本地表情包库</span>
            <span class="sb-count">…</span>
            <span class="sb-spacer"></span>
            <button class="sb-btn" data-act="import-files" title="导入图片文件">导入文件</button>
            <button class="sb-btn" data-act="import-folder" title="导入一个文件夹里的图片">导入文件夹</button>
            <button class="sb-btn" data-act="open" title="在资源管理器中打开库目录">打开目录</button>
            <button class="sb-btn" data-act="refresh" title="刷新">刷新</button>
            <button class="sb-btn sb-btn--close" data-act="close" title="关闭">✕</button>
        </div>
        <div class="sb-search"><input type="text" placeholder="搜索文件名…" /></div>
        <div class="sb-grid"></div>
        <div class="sb-empty">
            表情库是空的。<br />
            右键聊天里的表情/图片 → <b>存入本地表情库</b>，或点上方「导入文件夹」。
        </div>
        <div class="sb-foot"></div>
    `;
    document.body.appendChild(panelEl);
    positionPanel();

    panelEl.addEventListener("click", async (e) => {
        const act = e.target.closest("[data-act]")?.dataset.act;
        if (!act) return;
        e.stopPropagation();
        if (act === "close") return closePanel();
        if (act === "open") return void (await api.openLibrary());
        if (act === "refresh") return void (await refreshPanel());
        if (act === "import-files" || act === "import-folder") {
            const res = act === "import-files" ? await api.importFiles() : await api.importFolder();
            if (res && res.ok) {
                toast(`导入完成：新增 ${res.added}，重复 ${res.duplicated}${res.failed?.length ? "，失败 " + res.failed.length : ""}`);
                await refreshPanel();
            } else if (res && !res.canceled) {
                toast("导入失败：" + (res.error || "未知错误"), true);
            }
        }
    });

    const input = panelEl.querySelector(".sb-search input");
    let searchTimer = null;
    input.addEventListener("input", () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(async () => {
            library = await api.list(input.value);
            renderGrid();
        }, 180);
    });

    await refreshPanel();
}

async function refreshPanel() {
    if (!panelEl) return;
    library = await api.list("");
    const stats = await api.stats();
    panelEl.querySelector(".sb-count").textContent = `${stats.count} 张 · ${formatSize(stats.bytes)}`;
    panelEl.querySelector(".sb-foot").textContent = stats.libraryPath;
    renderGrid();
}

function renderGrid() {
    if (!panelEl) return;
    const grid = panelEl.querySelector(".sb-grid");
    const empty = panelEl.querySelector(".sb-empty");
    grid.innerHTML = "";
    empty.style.display = library.length ? "none" : "block";

    const frag = document.createDocumentFragment();
    for (const item of library) {
        const cell = document.createElement("div");
        cell.className = "sb-item";
        cell.dataset.name = item.name;
        // 动图判定优先用主进程按**文件内容**算出来的 animated —— QQ 缓存给的文件名
        // 后缀经常是错的（实测真身是 GIF89a 却叫 xxx.jpg），只看扩展名会把动图当静态图。
        const isAnim = item.animated === true || /\.(gif|webp|apng|avif)$/i.test(item.name);
        cell.title = isAnim
            ? `${item.name}\n${formatSize(item.size)}\n左键填入输入框（动图会变成静态首帧）\n拖进输入框可以保留动画 · 右键更多操作`
            : `${item.name}\n${formatSize(item.size)}\n左键填入输入框 · 右键更多操作`;

        const img = document.createElement("img");
        img.loading = "lazy";
        img.decoding = "async";
        // 关掉 <img> 的原生拖拽：它拖出去只是个 URL，QQ 会当成「拖入空文件」报错。
        // 真正的拖拽由下面 cell 上的 dragstart 走 Electron 的原生拖文件流程。
        img.draggable = false;
        img.src = item.url;
        img.alt = item.name;
        cell.appendChild(img);

        if (isAnim) {
            const badge = document.createElement("span");
            badge.className = "sb-item__badge";
            badge.textContent = "GIF";
            cell.appendChild(badge);
            // 悬停时提示"可以拖"—— 动图只有走原生拖放才能保住动画
            cell.dataset.anim = "true";
        }

        cell.addEventListener("click", () => insertSticker(item));

        // 拖动 = 把真实文件交给 QQ（QQ 收到的是货真价实的文件拖放），
        // 动图能保住动画，也不占用剪贴板。
        //
        // 【必须 preventDefault】Electron 拖出文件的官方写法就是「先 preventDefault，再 startDrag」。
        // 不 preventDefault 的话，浏览器自己的 HTML5 拖拽会照常进行，QQ 收到的是拖拽数据里的
        // 文本；早期版本还额外 setData("text/plain", 文件名)，结果就是只填进去一个文件名。
        cell.draggable = true;
        cell.addEventListener("dragstart", (e) => {
            e.preventDefault();
            e.stopPropagation();
            log("请求原生拖拽: " + item.name);
            api.startDrag(item.name).then((r) => {
                if (r && !r.ok) {
                    log("原生拖拽失败: " + JSON.stringify(r));
                    toast("拖拽失败：" + (r.error || "未知错误"), true);
                }
            });
        });

        cell.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            showItemMenu(e.clientX, e.clientY, item);
        });
        frag.appendChild(cell);
    }
    grid.appendChild(frag);
    positionPanel();
}

// -------- 单项操作菜单

function showItemMenu(x, y, item) {
    document.querySelectorAll(".sb-itemmenu").forEach((n) => n.remove());
    const menu = document.createElement("div");
    menu.className = "sb-itemmenu";
    menu.innerHTML = `
        <button data-act="insert">填入输入框</button>
        <button data-act="reveal">在文件夹中显示</button>
        <button data-act="rename">重命名…</button>
        <button data-act="delete" class="sb-danger">删除</button>
    `;
    document.body.appendChild(menu);
    menu.style.left = Math.min(x, window.innerWidth - menu.offsetWidth - 8) + "px";
    menu.style.top = Math.min(y, window.innerHeight - menu.offsetHeight - 8) + "px";

    const close = () => menu.remove();
    menu.addEventListener("click", async (e) => {
        const act = e.target.closest("[data-act]")?.dataset.act;
        if (!act) return;
        e.stopPropagation();
        close();
        if (act === "insert") return insertSticker(item);
        if (act === "reveal") return void (await api.reveal(item.name));
        if (act === "delete") {
            await api.remove([item.name]);
            toast("已删除 " + item.name);
            return void (await refreshPanel());
        }
        if (act === "rename") {
            const next = window.prompt("新的文件名（不含扩展名）", item.name.replace(/\.[^.]*$/, ""));
            if (!next) return;
            const res = await api.rename(item.name, next);
            if (res.ok) {
                toast("已重命名为 " + res.name);
                await refreshPanel();
            } else {
                toast("重命名失败：" + (res.error || ""), true);
            }
        }
    });
    setTimeout(() => {
        const off = (ev) => {
            if (!menu.contains(ev.target)) {
                close();
                document.removeEventListener("mousedown", off, true);
            }
        };
        document.addEventListener("mousedown", off, true);
    }, 0);
}

// 点击别处关闭面板与浮动菜单
document.addEventListener(
    "mousedown",
    (e) => {
        const t = e.target instanceof Element ? e.target : null;
        if (panelEl && !panelEl.contains(t) && !t?.closest(".sb-float")) closePanel();
        if (!t?.closest(".sb-itemmenu")) document.querySelectorAll(".sb-itemmenu").forEach((n) => n.remove());
    },
    true
);
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        closePanel();
        document.querySelectorAll(".sb-itemmenu").forEach((n) => n.remove());
    }
});
window.addEventListener("resize", positionPanel);

// ============================================================ 填入输入框

function getEditor() {
    const list = [...document.querySelectorAll(".ck.ck-content.ck-editor__editable")];
    return list.find((el) => el.offsetParent !== null) || list[0] || null;
}

/**
 * 把动图/不支持的格式转成静态 PNG（第一帧）。
 * nativeImage 只认 PNG/JPEG，GIF/WebP 进不了图片剪贴板，只能这样退化。
 * 用 IPC 取字节再造 Blob，避免 canvas 被 local:// 图片污染（tainted）后 toBlob 抛异常。
 *
 * 带缓存：同一张动图第二次点击就不用重新解码了（2.5MB 的 GIF 解码要几百毫秒，
 * 用户对"点了半天才填进去"很敏感）。
 */
const pngCache = new Map();
const PNG_CACHE_MAX = 24;

async function rasterizeToPng(item) {
    const hit = pngCache.get(item.name);
    if (hit) {
        log("静态 PNG 命中缓存: " + item.name);
        return hit;
    }
    try {
        const r = await api.readFile(item.name);
        if (!r || !r.ok) return null;
        const blob = new Blob([new Uint8Array(r.buffer)], { type: r.type || "image/gif" });
        const bmp = await createImageBitmap(blob);
        const canvas = document.createElement("canvas");
        canvas.width = bmp.width || 128;
        canvas.height = bmp.height || 128;
        canvas.getContext("2d").drawImage(bmp, 0, 0);
        if (bmp.close) bmp.close();
        const png = await new Promise((res) => canvas.toBlob(res, "image/png"));
        if (!png) return null;
        const out = { name: item.name.replace(/\.[^.]+$/, "") + ".png", buffer: await png.arrayBuffer() };
        if (pngCache.size >= PNG_CACHE_MAX) pngCache.delete(pngCache.keys().next().value);
        pngCache.set(item.name, out);
        return out;
    } catch (e) {
        log("转静态 PNG 失败: " + String(e));
        return null;
    }
}

/** 轮询等待编辑器内容变化 */
function waitForEditorChange(editor, before, timeout) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const timer = setInterval(() => {
            let len = -1;
            try {
                len = editor.innerHTML.length;
            } catch (e) {
                /* 编辑器被销毁了 */
            }
            if (len !== before) {
                clearInterval(timer);
                resolve(true);
            } else if (Date.now() - t0 > timeout) {
                clearInterval(timer);
                resolve(false);
            }
        }, 120);
    });
}

/**
 * 把库里的表情填进输入框。
 *
 * 只有一条可靠通路：**把图片放进系统剪贴板，再让 QQ 执行一次真实粘贴**
 * （主进程 clipboard.writeImage + webContents.paste）。
 *
 * 合成 paste 事件这条路已经删掉了，原因不是"没用"而是"有害"：
 * QQ 的粘贴处理读的是系统剪贴板，不看我们合成事件里的 DataTransfer，
 * 结果会把用户剪贴板里当时的东西粘进去 —— 实测把用户刚截的图粘进了输入框。
 */
async function insertSticker(item) {
    const editor = getEditor();
    if (!editor) {
        toast("找不到聊天输入框，请先打开一个聊天窗口", true);
        return;
    }
    try {
        let before = editor.innerHTML.length;
        editor.focus();

        let r = await api.pasteFile(item.name);
        log("真实粘贴返回: " + JSON.stringify(r));

        // GIF/WebP 进不了图片剪贴板：退化成静态首帧，至少能发出去
        if (r && r.unsupported) {
            log("该格式 nativeImage 解不了，改用 canvas 转静态 PNG 再粘贴");
            const png = await rasterizeToPng(item);
            r = png ? await api.pastePng(png.name, png.buffer) : r;
            log("静态 PNG 粘贴返回: " + JSON.stringify(r));
            if (r && r.ok) toast("动图只能填静态首帧；想保留动画请把文件拖进输入框", true);
        }

        if (r && r.ok && (await waitForEditorChange(editor, before, 2500))) {
            log("插入成功");
            if (config.closeAfterInsert) closePanel();
            return;
        }

        if (r && r.unsupported) {
            toast("这个格式暂时塞不进图片剪贴板，请把文件拖进输入框", true);
        } else {
            toast("没能填进输入框：" + ((r && r.error) || "输入框没反应，详情见日志"), true);
        }
    } catch (e) {
        log("插入失败: " + String(e));
        toast("插入失败：" + String(e.message || e), true);
    }
}

// ============================================================ 右键菜单：存入本地

let ctxTarget = null;
let ctxPoint = null;
let ctxTimer = null;

document.addEventListener(
    "mousedown",
    (e) => {
        if (e.button !== 2) {
            ctxTarget = null;
            ctxPoint = null;
            return;
        }
        ctxPoint = { x: e.clientX, y: e.clientY };
        ctxTarget = document.elementFromPoint(e.clientX, e.clientY) || e.target;
    },
    true
);

document.addEventListener(
    "contextmenu",
    (e) => {
        if (!ctxTarget) {
            ctxPoint = { x: e.clientX, y: e.clientY };
            ctxTarget = e.target;
        }
        watchContextMenu();
    },
    true
);

function findVisibleContextMenu() {
    const list = [...document.querySelectorAll(".q-context-menu")];
    return (
        list.find((el) => {
            const r = el.getBoundingClientRect();
            return el.isConnected && r.width > 20 && r.height > 20;
        }) || null
    );
}

function watchContextMenu() {
    if (ctxTimer) clearInterval(ctxTimer);
    let n = 0;
    ctxTimer = setInterval(() => {
        if (++n > 30 || !ctxTarget) {
            clearInterval(ctxTimer);
            ctxTimer = null;
            return;
        }
        const menu = findVisibleContextMenu();
        if (menu) {
            clearInterval(ctxTimer);
            ctxTimer = null;
            try {
                decorateContextMenu(menu);
            } catch (e) {
                log("装饰右键菜单失败: " + String(e));
            }
        }
    }, 40);
}

/** 从右键目标周边收集所有可能的图片来源 */
function collectCandidates(target, point) {
    const out = [];
    const seen = new Set();
    const push = (v) => {
        if (typeof v !== "string") return;
        const s = v.trim();
        if (!s || s === "none" || s === "about:blank") return;
        if (!/^(https?:|appimg:|local:|file:|blob:|data:image)/i.test(s)) return;
        if (seen.has(s)) return;
        seen.add(s);
        out.push(s);
    };

    const handleImg = (img) => {
        push(img.getAttribute("src"));
        push(img.getAttribute("data-src"));
        push(img.currentSrc);
        push(img.src);
    };
    const handleBg = (node) => {
        try {
            const bg = getComputedStyle(node).backgroundImage;
            const m = /url\((["']?)(.*?)\1\)/.exec(bg || "");
            if (m) push(m[2]);
        } catch (e) {
            /* ignore */
        }
    };

    let scope = null;
    if (target) {
        if (target.tagName === "IMG") handleImg(target);
        handleBg(target);
        // 向上找到第一个含图片的祖先作为作用域，避免串到隔壁消息
        let node = target.parentElement;
        for (let i = 0; i < 10 && node && node !== document.body; i++, node = node.parentElement) {
            const imgs = node.querySelectorAll("img");
            if (imgs.length && imgs.length <= 12) {
                scope = node;
                break;
            }
        }
        if (scope) {
            const imgs = [...scope.querySelectorAll("img")];
            // 优先取鼠标点中的那张
            imgs.sort((a, b) => score(a) - score(b));
            imgs.forEach(handleImg);
            handleBg(scope);
        }
    }

    function score(img) {
        if (!point) return 1;
        const r = img.getBoundingClientRect();
        const inside = point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom;
        if (inside) return 0;
        const dx = Math.max(r.left - point.x, 0, point.x - r.right);
        const dy = Math.max(r.top - point.y, 0, point.y - r.bottom);
        return 1 + Math.hypot(dx, dy) / 1000;
    }

    return { candidates: out, scope };
}

function describeContextTarget(target) {
    const { candidates, scope } = collectCandidates(target, ctxPoint);
    const inMessageArea = !!target?.closest?.(".ml-list, .chat-msg-area__vlist, [class*='msg-'], [class*='message']");
    const context = {
        tag: target?.tagName || null,
        cls: String(target?.className || "").slice(0, 160),
        hasImg: !!target?.closest?.("img") || target?.tagName === "IMG",
        scopeCls: String(scope?.className || "").slice(0, 160),
        inMessageArea,
        candidateCount: candidates.length,
        // 只记摘要：data: URI 是整张图片的 base64，原样打出来就是几百 KB 一行
        candidates: candidates.slice(0, 8).map(summarizeSource)
    };
    return { allow: candidates.length > 0 || inMessageArea, candidates, context };
}

/** 把候选来源里渲染进程才能取的（blob:）先转成字节 */
async function materialize(candidates) {
    const rest = [];
    let bytes = null;
    for (const src of candidates) {
        if (/^blob:/i.test(src) && !bytes) {
            try {
                const r = await fetch(src);
                const ab = await r.arrayBuffer();
                bytes = { name: "sticker.png", buffer: ab, source: "blob" };
                continue;
            } catch (e) {
                log("blob 转换失败: " + String(e));
            }
        }
        rest.push(src);
    }
    return { candidates: rest, bytes };
}

function addMenuItem(menu, id, title, onClick) {
    if (menu.querySelector("#" + id)) return null;

    let item = null;
    const tpl = [...menu.querySelectorAll(".q-context-menu-item")].find(
        (n) => n.querySelector(".q-context-menu-item__text") && !n.classList.contains("q-context-menu-item--disabled")
    );
    if (tpl) {
        item = tpl.cloneNode(true);
        item.removeAttribute("id");
        item.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
        const iconHost = item.querySelector(".q-context-menu-item__icon") || item.querySelector(".q-icon");
        if (iconHost) iconHost.innerHTML = ICON_SVG;
        const textEl = item.querySelector(".q-context-menu-item__text");
        if (textEl) textEl.textContent = title;
        item.classList.remove("q-context-menu-item--disabled");
        item.removeAttribute("aria-disabled");
    } else {
        item = document.createElement("a");
        item.className = "q-context-menu-item q-context-menu-item--normal";
        item.setAttribute("role", "menuitem");
        item.innerHTML = `<div class="q-context-menu-item__icon q-context-menu-item__head">${ICON_SVG}</div><span class="q-context-menu-item__text">${escapeHtml(
            title
        )}</span>`;
    }
    item.id = id;
    item.classList.add("sb-menu-item");
    item.addEventListener("click", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        try {
            onClick();
        } finally {
            setTimeout(() => menu.remove(), 0);
        }
    });

    menu.appendChild(item);

    // 菜单太长时上移，避免超出窗口
    const rect = menu.getBoundingClientRect();
    if (rect.bottom > window.innerHeight - 4) {
        menu.style.top = Math.max(4, window.innerHeight - rect.height - 4) + "px";
    }
    if (rect.right > window.innerWidth - 4) {
        menu.style.left = Math.max(4, window.innerWidth - rect.width - 4) + "px";
    }
    return item;
}

function decorateContextMenu(menu) {
    if (menu.querySelector("#sb-save-menu")) return;
    const info = describeContextTarget(ctxTarget);
    if (!info.allow) {
        log("右键菜单：目标不像可保存内容，跳过 " + JSON.stringify(info.context));
        return;
    }
    addMenuItem(menu, "sb-save-menu", "存入本地表情库", async () => {
        toast("正在存入…");
        const { candidates, bytes } = await materialize(info.candidates);
        const res = await api.saveCandidates({ candidates, bytes, context: info.context });
        if (res.ok) toast(res.duplicated ? `库里已有：${res.name}` : `已存入：${res.name}`);
        else toast("存入失败：" + res.error, true);
    });
    log("右键菜单：已注入条目 " + JSON.stringify(info.context));
}

// ============================================================ 设置页


/**
 * 现场自检：在真实 QQ 渲染进程里跑一遍关键环节，把结果写进日志。
 * 一次点击就能拿到完整诊断，不用反复来回猜。
 */
async function runSelfTest() {
    const push = (s) => log(s);
    push("===== SELF-TEST =====");
    try {
        push("window.sticker_box: " + (api ? Object.keys(api).length + " 个方法" : "缺失！"));
        push("插件目录: " + PLUGIN_DIR);
        push("LiteLoader: " + JSON.stringify(globalThis.LiteLoader?.versions || {}));

        const eds = [...document.querySelectorAll(".ck.ck-content.ck-editor__editable")];
        // 自检是从设置页触发的，而设置页是独立窗口 —— 那里看不到聊天输入框，
        // 所以这里报 0 是正常的，不代表编辑器有问题（探针走的是转发到聊天窗口的路子）。
        push("编辑器: 共 " + eds.length + " 个, 可见 " + eds.filter((e) => e.offsetParent !== null).length + "（设置窗口里看不到聊天输入框，0 属正常）");

        push("chat-func-bar: " + (document.querySelector(".chat-func-bar") ? "有" : "无"));
        const row = findToolbarIconRow();
        push("工具栏图标行: " + (row ? `找到，.bar-icon 数量=${row.querySelectorAll(".bar-icon").length}` : "未找到"));
        push("工具栏星标: " + (document.querySelector(".sb-bar-icon") ? `在位（第 ${barInjectCount} 次插入）` : "不在位"));
        push("入口轮询: " + (entryPollTimer ? `运行中(${ENTRY_POLL_MS}ms)` : "未启动"));
        push("库面板(#sb-panel): " + (document.querySelector(".sb-panel") ? "打开中" : "未打开"));

        try {
            const st = await api.stats();
            push("库: " + st.count + " 张 / " + st.bytes + " 字节 @ " + st.libraryPath);
        } catch (e) {
            push("stats 调用失败: " + String(e));
        }

        try {
            const r = await fetch(PLUGIN_URL + "/style.css");
            const t = await r.text();
            push("local:// fetch 测试: ok=" + r.ok + ", 读到 " + t.length + " 字符");
        } catch (e) {
            push("local:// fetch 测试失败: " + String(e));
        }

        push("===== SELF-TEST END =====");
    } catch (e) {
        push("自检自身异常: " + String(e));
    }
}

export async function onSettingWindowCreated(view) {
    try {
        config = { ...config, ...(await api.getConfig()) };
        const stats = await api.stats();

        view.innerHTML = `
        <style>
            .sb-set { margin: 20px; }
            .sb-set .sb-row { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
            .sb-set .sb-row h2 { color: var(--text_primary); font-size: min(var(--font_size_3), 18px); font-weight: var(--font-bold); margin: 0; }
            .sb-set .sb-sub { color: var(--text_secondary); font-size: min(var(--font_size_2), 16px); margin-top: 4px; word-break: break-all; }
            .sb-set .sb-btns { display: flex; gap: 8px; flex-shrink: 0; }
        </style>
        <div class="sb-set">
            <setting-section data-title="本地表情包库">
                <setting-panel>
                    <setting-list data-direction="column">
                        <setting-item data-direction="row">
                            <div>
                                <h2>表情库目录</h2>
                                <div class="sb-sub" id="sb-path">${escapeHtml(stats.libraryPath)}</div>
                            </div>
                            <div class="sb-btns">
                                <setting-button data-type="secondary" id="sb-open">打开目录</setting-button>
                                <setting-button data-type="secondary" id="sb-choose">更改位置</setting-button>
                            </div>
                        </setting-item>
                        <setting-item data-direction="row">
                            <div>
                                <h2>批量导入</h2>
                                <div class="sb-sub">把已有的表情图片加进库里（同一张图会自动去重）</div>
                            </div>
                            <div class="sb-btns">
                                <setting-button data-type="primary" id="sb-impf">导入文件…</setting-button>
                                <setting-button data-type="secondary" id="sb-impd">导入文件夹…</setting-button>
                            </div>
                        </setting-item>
                        <setting-item data-direction="row">
                            <div>
                                <h2>库内统计</h2>
                                <div class="sb-sub" id="sb-stats">共 ${stats.count} 张 · ${formatSize(stats.bytes)}</div>
                            </div>
                            <div class="sb-btns">
                                <setting-button data-type="secondary" id="sb-refresh">刷新</setting-button>
                                <setting-button data-type="secondary" id="sb-clear">清空库</setting-button>
                            </div>
                        </setting-item>
                        <setting-item data-direction="row">
                            <div>
                                <h2>填入后关闭面板</h2>
                                <div class="sb-sub">连续发表情时建议关闭</div>
                            </div>
                            <setting-switch id="sb-close"></setting-switch>
                        </setting-item>
                        <setting-item data-direction="row">
                            <div>
                                <h2>在 QQ 表情面板加入口</h2>
                                <div class="sb-sub">在「最近表情 / 超级表情」浮层里显示「本地表情库」按钮</div>
                            </div>
                            <setting-switch id="sb-panel-entry"></setting-switch>
                        </setting-item>
                        <setting-item data-direction="row">
                            <div>
                                <h2>诊断日志</h2>
                                <div class="sb-sub">QQNT 移除了 DevTools，排查问题时靠它</div>
                            </div>
                            <div class="sb-btns">
                                <setting-button data-type="primary" id="sb-selftest">运行自检</setting-button>
                                <setting-button data-type="secondary" id="sb-log">打开日志</setting-button>
                            </div>
                        </setting-item>
                    </setting-list>
                </setting-panel>
            </setting-section>
        </div>`;

        const $ = (id) => view.querySelector("#" + id);

        $("sb-open").addEventListener("click", () => api.openLibrary());
        $("sb-choose").addEventListener("click", async () => {
            const r = await api.chooseLibrary();
            if (r.ok) {
                $("sb-path").textContent = r.libraryPath;
                toast("库目录已切换");
            }
        });
        $("sb-impf").addEventListener("click", async () => {
            const r = await api.importFiles();
            if (r.ok) toast(`导入完成：新增 ${r.added}，重复 ${r.duplicated}`);
            await refreshStats();
        });
        $("sb-impd").addEventListener("click", async () => {
            const r = await api.importFolder();
            if (r.ok) toast(`导入完成：新增 ${r.added}，重复 ${r.duplicated}`);
            await refreshStats();
        });
        $("sb-refresh").addEventListener("click", refreshStats);
        $("sb-clear").addEventListener("click", async () => {
            const r = await api.clearLibrary();
            if (r.ok) toast(`已删除 ${r.removed} 个文件`);
            await refreshStats();
        });
        $("sb-log").addEventListener("click", () => api.openLog());
        $("sb-selftest").addEventListener("click", async () => {
            toast("正在自检，结果写入日志…");
            try {
                await runSelfTest();
                toast("自检完成，已写入 debug.log");
            } catch (e) {
                toast("自检失败：" + String(e.message || e), true);
            }
        });
        $("sb-snapshot")?.remove();


        const sw = $("sb-close");
        if (config.closeAfterInsert) sw.setAttribute("is-active", "");
        sw.addEventListener("click", async () => {
            const next = !sw.hasAttribute("is-active");
            if (next) sw.setAttribute("is-active", "");
            else sw.removeAttribute("is-active");
            config = { ...config, ...(await api.setConfig({ closeAfterInsert: next })) };
        });

        const swPanel = $("sb-panel-entry");
        if (config.panelEntry !== false) swPanel.setAttribute("is-active", "");
        swPanel.addEventListener("click", async () => {
            const next = !swPanel.hasAttribute("is-active");
            if (next) swPanel.setAttribute("is-active", "");
            else swPanel.removeAttribute("is-active");
            config = { ...config, ...(await api.setConfig({ panelEntry: next })) };
            if (next) {
                startEntryPoll();
                lastBarInjectAt = 0; // 允许立刻插回去，不用等冷却
                ensureToolbarEntry();
            } else {
                // 安全阀要真的管用：关掉后工具栏星标必须消失
                ensureToolbarEntry(); // config 已是 false，它会把自己摘掉
                log("已按设置移除工具栏星标");
            }
        });

        async function refreshStats() {
            const s = await api.stats();
            $("sb-stats").textContent = `共 ${s.count} 张 · ${formatSize(s.bytes)}`;
            $("sb-path").textContent = s.libraryPath;
        }

        log("设置页已渲染");
    } catch (e) {
        log("设置页渲染失败: " + String(e));
    }
}

// ============================================================ 入口轮询
//
// 【设计取舍】这里刻意只做一件事：把工具栏星标放在它该在的位置。
//
// 之前为了"在 QQ 表情面板里也加一个入口"，做了一整套面板识别 + 浮层对位，
// 代价是：一个常驻 MutationObserver、几何特征猜测、还有入口在面板关闭后
// "黏在原地"的问题。用户明确表示不要面板里那个入口，于是整套都删了。
//
// 现在只有一个 1.2 秒一次的轮询，每轮就两次廉价查询（.chat-func-bar / .func-bar），
// 星标不在位上就补一次（5 秒冷却）。没有观察器，没有几何计算。

const ENTRY_POLL_MS = 1200;

function startEntryPoll() {
    if (entryPollTimer) return;
    entryPollTimer = setInterval(() => {
        try {
            ensureToolbarEntry();
        } catch (e) {
            log("入口轮询异常: " + String(e));
        }
    }, ENTRY_POLL_MS);
    log(`入口轮询已启动（每 ${ENTRY_POLL_MS}ms 一次，只维护工具栏星标）`);
}

// ============================================================ 渲染进程看门狗
//
// 和主进程看门狗一个思路：主线程被卡住时定时器就停摆，恢复后第一件事就是
// 把「卡了多久」写进日志。这是唯一能在「界面点不动」的情况下留下证据的办法。

const WD_INTERVAL = 500;
/**
 * 【为什么要区分「节流」和「阻塞」】
 * Chromium 会把**后台/隐藏窗口**的 setInterval 节流到大约 1000ms。
 * 上一版没区分，于是每 500ms 的检测测出「阻塞 500ms」——全是假的：
 * 一晚上攒了 808 条报告，占整个日志的 81%，把真正有用的信息全淹了。
 * 所以：窗口不可见时直接不判；阈值也提到 1500ms。
 */
const WD_MIN_DRIFT = 1500;
const WD_REPORT_GAP = 10000; // 两条报告至少隔 10 秒，避免刷屏
const WD_SLEEP_HINT = 20000; // 这个量级更像系统休眠，不是阻塞

let wdTimer = null;
let wdLast = 0;
let wdWorst = 0;
let wdCount = 0;
let wdLastReportAt = 0;
let wdSuppressed = 0;

function startWatchdog() {
    if (wdTimer) return;
    wdLast = Date.now();
    wdTimer = setInterval(() => {
        const now = Date.now();
        const drift = now - wdLast - WD_INTERVAL;
        wdLast = now;

        // 后台窗口的定时器被节流，测出来的"阻塞"没有意义
        if (document.visibilityState !== "visible") return;
        if (drift < WD_MIN_DRIFT) return;

        wdCount++;
        if (drift > wdWorst) wdWorst = drift;

        if (now - wdLastReportAt < WD_REPORT_GAP) {
            wdSuppressed++;
            return;
        }
        const extra = wdSuppressed ? `，期间另有 ${wdSuppressed} 次未记录` : "";
        const hint = drift > WD_SLEEP_HINT ? "（这个量级更像系统休眠/挂起，不是阻塞）" : "";
        wdSuppressed = 0;
        wdLastReportAt = now;
        log(`[看门狗] 渲染进程主线程被阻塞 ${drift}ms（累计 ${wdCount} 次，最久 ${wdWorst}ms）${extra}${hint}`);
    }, WD_INTERVAL);
    log(`渲染进程看门狗已启动（每 ${WD_INTERVAL}ms 一次，阈值 ${WD_MIN_DRIFT}ms，后台窗口不判）`);
}

// ============================================================ 启动

(async () => {
    try {
        config = { ...config, ...(await api.getConfig()) };
        log("渲染进程就绪，插件目录: " + PLUGIN_DIR);
        ensureToolbarEntry();

        // ---------- 最小化恢复后唤活界面 ----------
        //
        // Chromium 在 Windows 上有个存在多年的已知问题：窗口从最小化恢复后，界面看着
        // 完全正常，但**点哪里都没反应**（鼠标没冻结，最大化/最小化本身也正常）。
        // QQNT、VS Code、Chrome、Edge 都有人报告同样症状（microsoft/vscode#167556），
        // 根因指向 Chromium 的 GPU 渲染管线 —— 也正因为卡在那一层，插件的看门狗
        // 测不到它（主进程事件循环只记录到 253ms，看起来一切正常）。
        //
        // 社区 workaround 是在输入框里右键 → 粘贴任意字符，本质是**给窗口一个输入事件**
        // 把它从假死里唤醒。这里在恢复可见时自动做一次等价操作：强制重绘 + 聚焦。
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState !== "visible") return;
            if (config.wakeOnRestore === false) return;
            // 等 Chromium 把恢复流程走完再戳，太早没有意义
            setTimeout(() => {
                api.wakeWindow()
                    .then((r) => {
                        if (r && r.ok) log("恢复可见，已尝试唤活窗口（" + (r.done || []).join("+") + "）");
                    })
                    .catch(() => {
                        /* 唤活失败不影响任何功能 */
                    });
            }, 800);
        });

        // 只在聊天窗口里跑轮询，免得登录窗/设置窗白跑
        const gate = () => {
            if (document.querySelector(".chat-func-bar")) {
                clearInterval(gateTimer);
                startEntryPoll();
                startWatchdog();
            }
        };
        const gateTimer = setInterval(gate, 1000);
        gate();
    } catch (e) {
        log("启动失败: " + String(e));
    }
})();
