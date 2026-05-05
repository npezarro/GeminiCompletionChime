import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  // Browser userscript (script.js) — IIFE, no module imports
  {
    files: ["script.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.browser,
        Notification: "readonly",
        Audio: "readonly",
        AudioContext: "readonly",
        webkitAudioContext: "readonly",
        Response: "readonly",
        Request: "readonly",
        XMLHttpRequest: "readonly",
      },
    },
  },
  // Test files — vitest globals
  {
    files: ["*.test.js"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    ignores: ["node_modules/"],
  },
];
