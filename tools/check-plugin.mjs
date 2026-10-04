/**
 * LiteLoaderQQNT 插件自检脚本
 *   node check-plugin.mjs <插件目录>
 *
 * 检查项：
 *  1. main.js / preload.js 按 CommonJS 语法检查
 *  2. renderer.js 按 ES Module 语法检查
 *  3. manifest.json 必填字段与取值
 *  4. injects 指向的文件是否存在
 *  5. renderer 里用到的 api.xxx 在 preload 里是否都暴露了
 *  6. preload 里暴露的每个方法在 main 里是否都有 ipcMain.handle
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const dir = path.resolve(process.argv[2] || ".");
let fail = 0;
const ok = (m) => console.log("  \u2713 " + m);
const bad = (m) => {
    fail++;
    console.log("  \u2717 " + m);
};

function syntaxCheck(file, asModule) {
    const target = asModule ? file.replace(/\.js$/, ".mjs") : file;
    if (asModule) fs.copyFileSync(file, target);
    try {
        // 注意：沙箱下不能用管道捕获子进程输出（EPERM），所以用 inherit 让 node 直接打到控制台
        execFileSync(process.execPath, ["--check", target], { stdio: "inherit" });
        ok(`语法通过: ${path.basename(file)}${asModule ? " (ESM)" : " (CJS)"}`);
    } catch (e) {
        bad(`语法错误: ${path.basename(file)} (exit ${e.status}) —— 具体错误见上方 node 输出`);
    } finally {
        if (asModule) fs.rmSync(target, { force: true });
    }
}

console.log("== 1/6 语法 ==");
const mainJs = path.join(dir, "main.js");
const preloadJs = path.join(dir, "preload.js");
const rendererJs = path.join(dir, "renderer.js");
syntaxCheck(mainJs, false);
syntaxCheck(preloadJs, false);
syntaxCheck(rendererJs, true);

console.log("== 2/6 manifest.json ==");
let manifest = null;
try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
} catch (e) {
    bad("manifest.json 无法解析: " + e.message);
}
if (manifest) {
    manifest.manifest_version === 4 ? ok("manifest_version = 4") : bad("manifest_version 必须是 4");
    ["extension", "theme", "framework"].includes(manifest.type) ? ok("type = " + manifest.type) : bad("type 非法: " + manifest.type);
    for (const k of ["name", "slug", "description", "version"]) {
        typeof manifest[k] === "string" && manifest[k].trim() ? ok(`${k} = ${manifest[k]}`) : bad(`${k} 缺失或为空`);
    }
    Array.isArray(manifest.authors) && manifest.authors.length && manifest.authors.every((a) => a && a.name && a.link)
        ? ok("authors 合法")
        : bad("authors 必须是 [{name, link}]");
    Array.isArray(manifest.platform) && manifest.platform.length ? ok("platform = " + manifest.platform.join(",")) : bad("platform 缺失");
    // 目录名要不要等于 slug：只有在「已安装的插件目录」下才强制。
    // 仓库目录（比如 LiteLoaderQQNT-StickerBox）和 slug 不一样是正常的。
    const base = path.basename(dir);
    const looksInstalled = path.basename(path.dirname(dir)).toLowerCase() === "plugins";
    if (!manifest.slug) {
        /* 上面已经报过缺失 */
    } else if (base === manifest.slug) {
        ok("slug 与目录名一致");
    } else if (looksInstalled) {
        bad(`slug(${manifest.slug}) 与安装目录名(${base}) 不一致 —— 装进 plugins/ 的目录名应当等于 slug`);
    } else {
        console.log(`  · 提示: 当前不是安装目录（${base}），跳过「目录名 = slug」检查`);
    }
}

console.log("== 3/6 injects 文件 ==");
const injects = manifest?.injects || {};
for (const [k, rel] of Object.entries(injects)) {
    const p = path.join(dir, rel);
    fs.existsSync(p) ? ok(`${k} -> ${rel}`) : bad(`${k} 指向的文件不存在: ${rel}`);
}

console.log("== 4/6 preload 暴露的 API ==");
const preloadSrc = fs.readFileSync(preloadJs, "utf8");
const exposed = new Set([...preloadSrc.matchAll(/^\s{4}([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1]));
// 标了 @local-only 的方法是纯 preload 实现：比如查 electron.webUtils ——
// 那是渲染侧才有的模块，主进程里根本没有，不该要求它有 ipcMain.handle。
const localOnly = new Set(
    [...preloadSrc.matchAll(/@local-only[\s\S]{0,120}?^\s{4}([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1])
);
if (localOnly.size) console.log(`  · 纯 preload 方法（不需要 IPC handler）: ${[...localOnly].join(", ")}`);
exposed.size ? ok("暴露 " + exposed.size + " 个方法: " + [...exposed].join(", ")) : bad("没解析到暴露的方法");

console.log("== 5/6 renderer 调用的 api.xxx ==");
const rendererSrc = fs.readFileSync(rendererJs, "utf8");
const used = new Set([...rendererSrc.matchAll(/\bapi\.([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
for (const name of used) {
    exposed.has(name) ? ok(`api.${name} 已暴露`) : bad(`api.${name} 在 preload 里没有暴露！`);
}

console.log("== 6/6 main 里的 ipcMain.handle ==");
const mainSrc = fs.readFileSync(mainJs, "utf8");
// main.js 里 handler 的两种写法都要认：
//   1) ipcMain.handle(CH("x"), ...)                      —— 直接注册
//   2) handle("x", ...)                                  —— 走带计时的统一包装
const handled = new Set([
    ...[...mainSrc.matchAll(/ipcMain\.handle\(\s*CH\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]),
    ...[...mainSrc.matchAll(/(?:^|[^.\w])handle\(\s*"([^"]+)"\s*,/g)].map((m) => m[1])
]);
for (const name of exposed) {
    if (localOnly.has(name)) continue;
    handled.has(name) ? ok(`handler: ${name}`) : bad(`preload 暴露了 ${name}，但 main 里没有 ipcMain.handle`);
}
for (const name of handled) {
    if (!exposed.has(name)) console.log(`  · 提示: main 有 handler "${name}" 但 preload 未暴露（可能是内部用）`);
}

console.log(fail ? `\n结果: ${fail} 项不通过` : "\n结果: 全部通过");
process.exit(fail ? 1 : 0);
