const { contextBridge, ipcRenderer } = require("electron");

const SLUG = "sticker_box";
const CH = (method) => `LiteLoader.${SLUG}.${method}`;

const api = {
    // ---- 配置 ----
    getConfig: () => ipcRenderer.invoke(CH("getConfig")),
    setConfig: (config) => ipcRenderer.invoke(CH("setConfig"), config),

    // ---- 表情库 ----
    list: (query) => ipcRenderer.invoke(CH("list"), query),
    stats: () => ipcRenderer.invoke(CH("stats")),
    remove: (names) => ipcRenderer.invoke(CH("remove"), names),
    rename: (oldName, newName) => ipcRenderer.invoke(CH("rename"), { oldName, newName }),
    readFile: (name) => ipcRenderer.invoke(CH("readFile"), name),
    pasteFile: (name) => ipcRenderer.invoke(CH("pasteFile"), name),
    pastePng: (name, buffer) => ipcRenderer.invoke(CH("pastePng"), name, buffer),
    startDrag: (name) => ipcRenderer.invoke(CH("startDrag"), name),
    // ★ 动图一键装填（推荐）：用真正的 CF_HDROP 把文件放进剪贴板再粘贴，
    // QQ 会当成"拖入文件"处理，按原文件上传，动画保留。
    // 需要借 PowerShell 写 CF_HDROP（Electron 写不了这个格式），失败会自动降级。
    pasteFileAsDrop: (name) => ipcRenderer.invoke(CH("pasteFileAsDrop"), name),
    // 悬停预填：鼠标停在动图上时提前准备剪贴板，点下去就不用等那 ~860ms
    prepareDrop: (name) => ipcRenderer.invoke(CH("prepareDrop"), name),

    // ---- 入库 ----
    saveCandidates: (payload) => ipcRenderer.invoke(CH("saveCandidates"), payload),
    importFiles: () => ipcRenderer.invoke(CH("importFiles")),
    importFolder: () => ipcRenderer.invoke(CH("importFolder")),
    chooseLibrary: () => ipcRenderer.invoke(CH("chooseLibrary")),

    // ---- 杂项 ----
    openLibrary: () => ipcRenderer.invoke(CH("openLibrary")),
    reveal: (name) => ipcRenderer.invoke(CH("reveal"), name),
    clearLibrary: () => ipcRenderer.invoke(CH("clearLibrary")),
    log: (message) =>
        ipcRenderer.invoke(CH("log"), message).catch(() => {
            /* 日志失败不能影响插件 */
        }),
    openLog: () => ipcRenderer.invoke(CH("openLog")),
    openPath: (p) => ipcRenderer.invoke(CH("openPath"), p)
};

contextBridge.exposeInMainWorld(SLUG, api);
