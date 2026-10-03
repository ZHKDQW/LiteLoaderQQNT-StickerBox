# tools

开发与测试工具。插件本体是**无构建**的纯 JS，改完直接用这里的脚本验证、部署即可。

```bash
cd tools
npm install     # 只装 jsdom（渲染进程测试要在真 DOM 里跑真实 renderer.js）
```

## 脚本

| 脚本 | 作用 |
|---|---|
| `check-plugin.mjs [目录]` | 静态自检：语法（CJS/ESM 分开查）、manifest 必填字段、preload 暴露的方法与 main 的 `ipcMain.handle` 是否一一对应 |
| `test-main.mjs` | 主进程逻辑测试。用 `Module._resolveFilename` 钩子把 `electron` 换成 mock，跑的是**真实 main.js** |
| `test-renderer.mjs` | 渲染进程测试。用 jsdom 造一个「像 QQ」的 DOM，把**真实 renderer.js** 放进去执行（只剥掉 `export` 关键字）；jsdom 缺的布局/事件 API 在文件里补了桩 |
| `deploy.mjs [目录]` | 把仓库内容复制到 LiteLoader 插件目录（只复制插件本体，不带 tools/README） |
| `read-log.mjs [路径]` | 分析运行日志：插件加载、注入、右键、入库、报错 |
| `make-drag-icon.mjs` | 重新生成 `assets/drag-icon.png`（手写 PNG 编码，不依赖任何图形库） |

一键跑全部：

```bash
npm test
```

## 为什么有这么多测试

QQNT 移除了 DevTools，插件跑在真实环境里出问题时**看不到任何报错**——所以这里的原则是：**能在离线环境里验证的，就不要留给用户去试**。

下面这些「回归守卫」都是踩过的坑，删掉它们对应的代码前请先看一眼注释：

- **每个 IPC 方法必须在 preload 和 main 两侧同时存在**（少一边只会静默失效）
- **渲染进程不允许创建 `MutationObserver`**。早期版本挂了一个监听整个 `document.body` 的观察器，对每个新增节点做子树展开，切聊天时直接把渲染进程拖死（症状是界面无响应、托盘图标也关不掉，只能任务管理器）
- **不导出 `onVueComponentMount`**。这个钩子在 QQ 里每条消息、每个头像都会触发，是最热的路径；早期在里面取 `getBoundingClientRect()` 等于持续强制同步布局
- **插件元素不能出现在 QQ 的容器内部**（唯一例外是工具栏星标，那是有意为之）。往 Vue 管理的元素里插节点，Vue patch 遇到不认识的子节点可能抛错 → 组件渲染失败 → 渲染进程崩溃重载 → 脚本重跑又插一次，形成死循环
- **拖拽必须 `preventDefault()`**。不这么做的话浏览器自己的 HTML5 拖拽会照常执行，QQ 收到的是拖拽数据里的文本，结果只填进去一个文件名
- **`startDrag` 的图标必须非空**。Electron 的 `nativeImage` 解不了 GIF/WebP，传空图标会导致整个拖拽不生效（表现为「动图根本拖不动」），所以必须退回内置图标

## 渲染进程测试的桩

jsdom 不实现布局和若干事件 API，`test-renderer.mjs` 里补了这些：

- `getBoundingClientRect` —— 用一张矩形注册表伪造（`setRect(el, x, y, w, h)`）
- `document.elementFromPoint` —— 用「面积最小的命中元素」近似"最上层"，并且**跳过已从 DOM 移除的元素**（不这么做会命中已经关掉的弹窗，测试结论就失真了）
- `DataTransfer` / `ClipboardEvent` / `DragEvent` / `createImageBitmap` / `canvas.toBlob`
- `MutationObserver` 计数包装 —— 用来断言插件一个观察器都没创建
