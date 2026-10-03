# 本地表情包库 · LiteLoaderQQNT-StickerBox

一个 [LiteLoaderQQNT](https://github.com/LiteLoaderQQNT/LiteLoaderQQNT) 插件：把聊天里看到的表情/图片**一键存到本地**，攒成自己的表情库，想用的时候点一下就填进输入框。

表情库就是一个普通文件夹（默认在插件数据目录，可改到任意位置，比如 `D:\本地表情库`），里面的图片你可以直接用资源管理器管理——不搞私有格式，不锁数据。

## 功能

- **右键存入**：在聊天消息上右键 → 「存入本地表情库」
  - QQ 的图片走 `appimg://` 协议，`src` 去掉协议头就是本地路径，所以是**直接复制文件**，不重新下载
  - 右键的是缩略图时，会自动去找原图（`Thumb/xxx_720.gif` → `Ori/xxx.gif`），不会存成一张几十 KB 的糊图
  - 按内容 SHA-1 去重，同一张图重复存只会提示「库里已有」
- **工具栏入口**：聊天工具栏最右边一个 ⭐，点开本地表情库面板
- **点击填入**：面板里点某个表情 → 直接进输入框
- **拖拽填入**：把表情从面板**拖进输入框** → **动图动画完整保留**
- **面板功能**：搜索文件名、导入文件/导入文件夹、重命名、删除、在文件夹中显示、一键打开库目录、按内容去重导入
- **设置页**：改库目录、批量导入、统计、清空、运行自检、打开日志

## 安装

### 通过插件市场

已提交到 [Plugin-List](https://github.com/LiteLoaderQQNT/Plugin-List)，在插件市场类插件（例如 [list-viewer](https://github.com/ltxhhz/LL-plugin-list-viewer)）里搜索「本地表情包库」即可。

### 手动安装

1. 从 [Releases](https://github.com/ZHKDQW/LiteLoaderQQNT-StickerBox/releases) 下载 `StickerBox.zip`
2. 解压到 LiteLoaderQQNT 的插件目录，**确保 `manifest.json` 就在这一层**：
   - 设了 `LITELOADERQQNT_PROFILE` 环境变量 → `<该目录>/plugins/sticker_box/`
   - 没设 → `<LiteLoaderQQNT 本体目录>/plugins/sticker_box/`
3. 重启 QQ

> 前提是你的 QQ 已经装好 LiteLoaderQQNT。Windows 上还需要绕过 QQNT 文件校验，参见[官方安装文档](https://liteloaderqqnt.github.io/guide/install.html)。

## 使用

| 想干什么 | 怎么做 |
|---|---|
| 存一张表情 | 右键聊天里的表情/图片 → 「存入本地表情库」 |
| 打开表情库 | 点工具栏最右边的 ⭐ |
| 发出去 | 点表情（填入输入框）或把表情**拖**进输入框 |
| 批量导入 | 面板上方「导入文件夹」，或设置页里导入 |

## 已知限制

这几条是踩过的坑，写出来省得你以为是 bug：

- **点击填入时，GIF/WebP 只会填入静态首帧**。Electron 的 `nativeImage` 只能解码 PNG/JPEG，动图放不进图片剪贴板。**想保留动画请用拖拽**——拖拽走的是原生文件拖放，QQ 收到的是货真价实的文件。
- **点击会覆盖你的系统剪贴板**。填入的原理是把图片写进剪贴板再触发一次真实粘贴，所以剪贴板里原来的内容会被替换。介意的话用拖拽。
- 动图格子上有 `GIF` 角标、悬停会提示「拖进聊天窗口」，就是提醒这条。
- 只在 **Windows + QQNT 9.9.25 + LiteLoaderQQNT 1.4.1** 上实测过。`platform` 里虽然写了 linux/darwin，但那些平台没测过（尤其剪贴板相关的行为）。

## 免责声明

这个插件是我闲着没事、**和 AI（大肥鱼）一起做着玩的**产物。

- **不保证后续更新**。功能够我自己用就行，不承诺修 bug 或加功能的时间表。
- 不过说实在的，**只要我还在用 QQ，遇到问题大概率会顺手修掉**。
- 用之前请自行判断风险。出问题欢迎提 Issue，但别期待响应速度。

代码里能看出明显的「边写边试」痕迹——比如拖拽那条路我改了三次才对（先是漏了 `preventDefault`，导致 QQ 只收到文件名；再是拖拽图标为空，导致动图根本拖不动）。不过每个踩过的坑都留了注释和回归测试，算是**能跑、也能看懂**。

## 开发

```bash
git clone https://github.com/ZHKDQW/LiteLoaderQQNT-StickerBox
cd LiteLoaderQQNT-StickerBox/tools
npm install          # 只装 jsdom，给渲染进程测试用
```

插件本体是**无构建**的纯 JS：`main.js` / `preload.js` 是 CommonJS，`renderer.js` 是 ESM，改完直接复制进插件目录即可。

### 测试

```bash
node tools/check-plugin.mjs .        # 语法 + manifest 规范 + IPC 交叉校验
node tools/test-main.mjs             # 主进程逻辑（mock 掉 electron）
node tools/test-renderer.mjs         # 渲染进程（jsdom 真 DOM 里跑真实 renderer.js）
```

一共 100 多项断言。其中几条是**回归守卫**，钉住踩过的坑：

- 每个 IPC 方法在 preload / main 两侧必须对得上
- 渲染进程**不允许创建 MutationObserver**（早期一个常驻观察器把 QQ 拖死过）
- 不导出 `onVueComponentMount`（那个钩子在 QQ 里每条消息都会触发，是最热的路径）
- 插件元素不能出现在 QQ 的容器内部（除了工具栏星标，那是有意为之）
- 拖拽必须 `preventDefault`，否则浏览器自己的 HTML5 拖拽会顶掉原生拖拽

### 其他工具

```bash
node tools/deploy.mjs [插件目录]       # 把仓库内容部署到 LiteLoader 插件目录
node tools/read-log.mjs [日志路径]     # 分析运行日志
node tools/make-drag-icon.mjs         # 重新生成 assets/drag-icon.png
```

## 协议

[MIT](LICENSE)
