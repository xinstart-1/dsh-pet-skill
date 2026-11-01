/**
 * 把各技能的设置页静态资源复制进产物目录。
 *
 * tsdown 只处理 JS 入口，html/css 这些不会被带进 `lib/`；而两个技能的路由分别用
 * `new URL('./douyin-web/', import.meta.url)` / `new URL('./qq-web/', ...)` 定位资源，
 * 打包后那就是 `lib/douyin-web/`、`lib/qq-web/`。所以 `npm run bundle` 里要在 tsdown 之后补这一步。
 *
 * 表驱动：以后再加技能，往 `DIRS` 里加一条就行，不用改脚本逻辑。
 *
 * @module dsh-pet/scripts/copy-web
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** `[源目录（相对 src）, 产物目录名]` */
const DIRS = [
  [join('douyin', 'douyin-web'), 'douyin-web'],
  [join('qq', 'qq-web'), 'qq-web'],
];

for (const [relFrom, name] of DIRS) {
  const from = join(root, 'src', relFrom);
  const to = join(root, 'lib', name);
  // 先删后拷：避免源目录里删掉的文件在产物里继续躺着被访问到
  await rm(to, { recursive: true, force: true });
  await mkdir(to, { recursive: true });
  await cp(from, to, { recursive: true });
  console.log(`[web] ${name} → ${to}`);
}
