import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // Errors
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],

      // Code quality
      'eqeqeq': ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'warn',
      'no-throw-literal': 'error',

      // Off — handled by Prettier
      'indent': 'off',
      'semi': 'off',
      'quotes': 'off',
    },
  },
  {
    // Webview scripts run in the VS Code webview (browser) context, not Node,
    // and are plain JS — so they are NOT covered by tsc or the src/ TS lint
    // block above. Without this block undefined-identifier bugs (a typo'd
    // variable, a wrong DOM container name) ship silently: that is exactly how
    // three dead `suggestNextSteps` bugs survived every review. `no-undef`
    // here is the mechanical backstop for that whole class.
    files: ['media/**/*.js'],
    ignores: ['media/*.min.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        // Webview ↔ extension bridge
        acquireVsCodeApi: 'readonly',
        // Browser/DOM globals used by the webview scripts
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        fetch: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        FileReader: 'readonly',
        URL: 'readonly',
        Image: 'readonly',
        Audio: 'readonly',
        Event: 'readonly',
        CustomEvent: 'readonly',
        KeyboardEvent: 'readonly',
        MouseEvent: 'readonly',
        MutationObserver: 'readonly',
        ResizeObserver: 'readonly',
        IntersectionObserver: 'readonly',
        DOMParser: 'readonly',
        Node: 'readonly',
        HTMLElement: 'readonly',
        getComputedStyle: 'readonly',
        XMLSerializer: 'readonly',
        AudioContext: 'readonly',
        CSS: 'readonly',
        NodeFilter: 'readonly',
        structuredClone: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        crypto: 'readonly',
        performance: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        prompt: 'readonly',
        MediaRecorder: 'readonly',
        SpeechRecognition: 'readonly',
        webkitSpeechRecognition: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-var': 'error',
      // 'smart' permits the `x != null` idiom (catches null AND undefined),
      // which the webview relies on, while still flagging other loose equality.
      'eqeqeq': ['error', 'smart'],
      'indent': 'off',
      'semi': 'off',
      'quotes': 'off',
    },
  },
  {
    // Production code routes diagnostics through the central `logger`
    // (src/system/logger.ts → "SideCar" output channel), never the dev
    // console. Tests and the eval/integration harness under src/test/ may use
    // console freely (they run outside the extension host).
    files: ['src/**/*.ts'],
    ignores: ['**/*.test.ts', 'src/test/**/*.ts'],
    rules: {
      'no-console': 'error',
    },
  },
];
