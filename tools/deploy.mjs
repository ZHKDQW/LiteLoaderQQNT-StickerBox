/**
 * 把仓库内容部署到 LiteLoaderQQNT 的插件目录
 *
 *   node deploy.mjs [目标插件目录]
 *
 * 不传参数时按下面的顺序找：
 *   1. 环境变量 STICKER_BOX_PLUGIN_DIR
 *   2. <LITELOADERQQNT_PROFILE>/plugins/sticker_box
 *   3. <LiteLoaderQQNT 本体>/plugins/sticker_box（需要自己传路径，脚本猜不到）
 *
 * 只复制插件本体，不会把 tools/ README LICENSE 这些一起塞进去。
 */
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const SRC = path.join(HERE, "..");

// 需要复制的东西（插件运行时用到的全部文件）
const PAYLOAD = ["manifest.json", "main.js", "preload.js", "renderer.js", "style.css", "assets"];

function resolveDest() {
    const fromArg = process.argv[2];
    if (fromArg) return path.resolve(fromArg);
    const fromEnv = process.env.STICKER_BOX_PLUGIN_DIR;
    if (fromEnv) return path.resolve(fromEnv);
    const profile = process.env.LITELOADERQQNT_PROFILE;
    if (profile) return path.join(profile, "plugins", "sticker_box");
    return null;
}

const dest = resolveDest();
if (!dest) {
    console.log("找不到目标目录。请显式传入，例如：");
    console.log("  node deploy.mjs \"C:/Users/you/Documents/LiteLoaderQQNT/plugins/sticker_box\"");
    console.log("或者设好环境变量 LITELOADERQQNT_PROFILE / STICKER_BOX_PLUGIN_DIR。");
    process.exit(1);
}

console.log(`源目录: ${SRC}`);
console.log(`目标目录: ${dest}`);

if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
    console.log("已清掉旧副本");
}
fs.mkdirSync(dest, { recursive: true });

let count = 0;
for (const item of PAYLOAD) {
    const from = path.join(SRC, item);
    if (!fs.existsSync(from)) {
        console.log(`  跳过（不存在）: ${item}`);
        continue;
    }
    fs.cpSync(from, path.join(dest, item), { recursive: true });
    count++;
}

console.log(`\n已复制 ${count} 项。校验：`);
for (const item of PAYLOAD) {
    const p = path.join(dest, item);
    if (!fs.existsSync(p)) {
        console.log(`  ✗ 缺失 ${item}`);
        continue;
    }
    const st = fs.statSync(p);
    console.log(`  ✓ ${item}${st.isDirectory() ? "/" : `  ${st.size} B`}`);
}

// 顺手确认 manifest 里的 slug 和目录名一致 —— 不一致 LiteLoader 会认不出来
const manifest = JSON.parse(fs.readFileSync(path.join(dest, "manifest.json"), "utf8"));
if (path.basename(dest) !== manifest.slug) {
    console.log(`\n⚠ 目录名(${path.basename(dest)}) 与 manifest.slug(${manifest.slug}) 不一致，LiteLoader 可能加载不到。`);
} else {
    console.log(`\n✓ 目录名与 slug 一致（${manifest.slug}），重启 QQ 生效。`);
}
