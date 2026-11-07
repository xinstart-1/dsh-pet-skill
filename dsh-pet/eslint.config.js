// ESLint 扁平配置（ESLint 9 flat config）
// 规则基调：js recommended + typescript-eslint recommended（未使用变量/类型相关规则）
//           + react-hooks 钩子规则（client 半侧是 React 代码）
// 忽略：构建产物 lib、发布前检查脚本 scripts、素材 assets（类型正确性交给 tsc，
//       因此 TS 文件关闭 no-undef，避免 window/fetch 等全局误报）
import js from '@eslint/js';
import jsdoc from 'eslint-plugin-jsdoc';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      'lib/**',
      'scripts/**',
      'assets/**',
      'runtime/**',
      'node_modules/**',
      // 本地临时目录：探针脚本、从 app.asar 抽出来的第三方源码、截图，不入库也不该参与检查。
      '.scratch/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // TS 文件：类型正确性由 tsc 负责，关闭 no-undef（避免 window/fetch 等全局误报）
    files: ['**/*.ts'],
    rules: {
      'no-undef': 'off',
    },
  },
  {
    // QQ / 抖音两个技能是纯 JS 实现（不经过 tsc），no-undef 必须靠显式 globals 兜住，
    // 否则 Buffer / setTimeout / URL 这类 Node 内置全局会被全量误报（实测 273 个）。
    // 不引 globals 包，避免为一条规则多一个开发依赖。
    files: ['src/qq/**/*.js', 'src/douyin/**/*.js'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        ReadableStream: 'readonly',
        Blob: 'readonly',
        globalThis: 'readonly',
        // Node 18+ 内置：structuredClone 做深拷贝，Response 用于测试桩与 Web 通道，
        // WebSocket 由 Node 22 原生提供（网关长连接与设置页回环都走它）。
        structuredClone: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
        WebSocket: 'readonly',
        // 浏览器全局：设置页回环脚本偶尔也会被 Node 侧引用到。
        history: 'readonly',
      },
    },
  },
  {
    // 设置页前端（qq-web / douyin-web）：无框架纯浏览器 JS，跑在 iframe 里，
    // 用的是 DOM / Web Storage / postMessage 那套全局，与上面 Node 全局不重叠。
    files: ['src/qq/qq-web/**/*.js', 'src/douyin/**/*-web/**/*.js', 'src/douyin/*-web/**/*.js'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        location: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        console: 'readonly',
        ResizeObserver: 'readonly',
        MutationObserver: 'readonly',
        HTMLElement: 'readonly',
        CustomEvent: 'readonly',
        Event: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        FileReader: 'readonly',
        Image: 'readonly',
        FormData: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        getComputedStyle: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        prompt: 'readonly',
      },
    },
  },
  {
    // 抖音/QQ 是纯 JS 实现，未走 tsc 也暂无脚本配套的类型收紧，下面几条规则在这里
    // 与既有代码风格冲突，且逐条核过不是真 bug，按规则豁免（不去动业务代码）：
    //   no-unused-vars —— 具名解构保留 future 参数、页面上留着的常量与格式化工具，
    //                     删掉反而让调用方对不上接口；测试里的 `_params`/`_cfg` 是占位。
    //   no-useless-assignment —— 均为「先给初值、随后在 try 内覆盖」，初值是异常路径的兜底。
    //   no-control-regex —— slugify 用 [\u0000-\u001f] 清理控制字符，是防文件名注入的必需。
    //   no-constant-binary-expression / require-yield —— 测试里刻意构造的边界与失败桩。
    files: [
      'src/douyin/**/*.js',
      'src/qq/**/*.js',
      'src/host/routes/persona.test.ts',
      'src/host/plugin/extension-say.ts',
    ],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'no-useless-assignment': 'off',
      'no-control-regex': 'off',
      'no-constant-binary-expression': 'off',
      'require-yield': 'off',
    },
  },
  {
    // client 半侧是 React 代码（hooks + 手写 h() 元素）：
    // rules-of-hooks 强制 hook 调用顺序稳定；exhaustive-deps 提醒 useEffect 依赖遗漏
    files: ['src/client/**/*.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // 注释门禁（warn）：只校验已有 JSDoc 的格式与参数名，不强制每个符号都写注释，
    // 因此不阻塞构建；稳定后再考虑升 error 或补 require-jsdoc。
    // TSDoc 的 @typeParam / @remarks / @internal / @module 不是 JSDoc 内置标签，需显式登记。
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    plugins: { jsdoc },
    settings: {
      jsdoc: { definedTags: ['typeParam', 'remarks', 'internal', 'module'] },
    },
    rules: {
      'jsdoc/check-tag-names': 'warn',
      // 解构参数（{ a, b }）不展开成 a、b 两个参数名，否则全是误报。
      'jsdoc/check-param-names': ['warn', { checkDestructured: false, checkRestProperty: false }],
      'jsdoc/require-param-description': 'warn',
      'jsdoc/require-returns-description': 'warn',
    },
  },
  {
    // 配置文件本身用的 ESM import，无浏览器代码，no-undef 放开
    files: ['eslint.config.js'],
    rules: {
      'no-undef': 'off',
    },
  },
);
