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
    // 最小化恢复后唤活窗口。Chromium 在 Windows 上恢复后界面可能点不动
    // （QQNT / VS Code / Chrome / Edge 都有报告，见 microsoft/vscode#167556），
    // 这里只做强制重绘 + 聚焦 —— 无害，但可能省掉一次任务管理器。
    wakeWindow: () => ipcRenderer.invoke(CH("wakeWindow")),

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
