import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "**/*.ts",
      "**/*.tsx",
      "build/**",
      "dist/**",
      "external/**",
      "public/modules/**",
      ".claude/**",
      ".preview/**",
      ".gym/**",
      "data/**",
    ],
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        args: "after-used",
      }],
    },
  },
];
