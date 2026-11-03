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
  { ignores: ['lib/**', 'scripts/**', 'assets/**', 'runtime/**', 'node_modules/**'] },
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
