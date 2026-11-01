/**
 * 浏览器半侧 bundle 外壳：由 tsdown 构建为 lib/client.js。
 * 只负责把 makeFactory() 造出的模块交给宿主注入的 window.__ModuleLoader__。
 * 不负责业务逻辑；依赖 app.ts 的工厂与加载前已注入的模块系统。
 * 必须始终成立：整个文件是普通副作用脚本，不能有顶层 ESM import / export（react 由 factory 的 require 取得）。
 * @module dsh-pet/src/client/index
 */
import { makeFactory } from './app.ts';

declare const window: {
  __ModuleLoader__: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 全局注入的模块系统契约（f(require) => module）
    load(info: { id: string; factory: (require: (m: string) => any) => any }): void;
  };
};

// id 与 package.json 的 name 一致：DSH 按包名提供 /plugins/dsh-pet-skill/client.js，
// 模块系统也按这个 id 注册。改包名时这两处必须一起改，否则浏览器半侧加载不到。
window.__ModuleLoader__.load({
  id: 'dsh-pet-skill',
  factory: makeFactory(),
});
