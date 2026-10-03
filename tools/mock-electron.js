/**
 * electron 模块的 mock，只覆盖 sticker_box 主进程用到的 API。
 * 通过 Module._resolveFilename 钩子注入，这样测的是真实的 main.js，不是副本。
 */
const handlers = new Map();
const calls = { openPath: [], showItemInFolder: [] };

// 测试用例通过这些开关控制返回值
const sender = {
    isDestroyed: () => false,
    paste: () => {
        calls.paste = (calls.paste || 0) + 1;
    },
    startDrag: (item) => {
        calls.startDrag = (calls.startDrag || 0) + 1;
        calls.lastDragItem = item;
    }
};

globalThis.__mock = {
    handlers,
    calls,
    sender,
    openDialogResult: { canceled: true, filePaths: [] },
    messageBoxResponse: 0,
    netFetchImpl: null,
    // pasteFile 用到的开关
    nativeImageEmpty: false,
    hasFocusedWebContents: true,
    clipboardImages: []
};

module.exports = {
    shell: {
        openPath: async (p) => {
            calls.openPath.push(p);
            return "";
        },
        showItemInFolder: (p) => {
            calls.showItemInFolder.push(p);
        }
    },
    dialog: {
        showOpenDialog: async () => globalThis.__mock.openDialogResult,
        showMessageBox: async () => ({ response: globalThis.__mock.messageBoxResponse })
    },
    ipcMain: {
        handle: (channel, fn) => {
            if (handlers.has(channel)) throw new Error("重复注册 handler: " + channel);
            handlers.set(channel, fn);
        }
    },
    net: {
        fetch: async (...args) => {
            if (!globalThis.__mock.netFetchImpl) throw new Error("net.fetch 未 mock");
            return globalThis.__mock.netFetchImpl(...args);
        }
    },
    app: {
        whenReady: () => Promise.resolve(),
        getPath: () => ""
    },
    clipboard: {
        writeImage: (img) => globalThis.__mock.clipboardImages.push(img)
    },
    nativeImage: {
        createFromBuffer: (buf) => ({
            isEmpty: () => globalThis.__mock.nativeImageEmpty,
            getSize: () => ({ width: 32, height: 32, bytes: buf ? buf.length : 0 })
        })
    },
    webContents: {
        getFocusedWebContents: () => {
            if (!globalThis.__mock.hasFocusedWebContents) return null;
            return {
                paste: () => {
                    calls.paste = (calls.paste || 0) + 1;
                },
                startDrag: (item) => {
                    calls.startDrag = (calls.startDrag || 0) + 1;
                    calls.lastDragItem = item;
                }
            };
        }
    },
    BrowserWindow: {
        getFocusedWindow: () => null
    }
};
