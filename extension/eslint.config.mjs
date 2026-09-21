import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "dist-e2e/**", "node_modules/**", "public/inject/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        chrome: "readonly",
        window: "readonly",
        document: "readonly",
        console: "readonly",
        navigator: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        URL: "readonly",
        Headers: "readonly",
        AbortController: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // The e2e drivers are Node scripts that launch Chrome, not extension code.
  { files: ["e2e/**"], languageOptions: { globals: globals.node } }
);
