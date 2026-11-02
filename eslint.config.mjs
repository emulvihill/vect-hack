// What this lints, and — more to the point — what it does not.
//
// It lints the ~70 hand-written JavaScript files under `scripts/`: the engine
// test drivers, the gate runners, the bot gym and the build tooling. That is
// deliberately the ONE part of the tree `npm run typecheck` cannot speak for.
// tsconfig.json turns `allowJs` on and leaves `checkJs` off, so tsc parses
// those `.mjs` files (a syntax error there is caught) and checks nothing about
// their semantics — its own comment says so. A typo'd global, a shadowed
// `catch` binding, a `case` that falls through, an import of a helper that no
// longer exports the name: none of it reports anywhere today. This is the
// linter for that gap.
//
// It does NOT lint `src/**/*.ts`, and not by preference:
//
//   typescript-eslint 8.68.0 — the current release, and the only maintained
//   TypeScript plugin for ESLint — declares `peerDependencies.typescript` as
//   ">=4.8.4 <6.1.0". This repo is on typescript ^7.0.2, which is npm `latest`.
//   Installing it alongside is a hard ERESOLVE (so `npm ci` in CI would fail),
//   and forced past that with --legacy-peer-deps the package throws on import:
//   "typescript-eslint does not support TS 7.0." Upstream tracks this as
//   typescript-eslint#10940. The route TypeScript's own 7.0 announcement
//   recommends is to alias the root `typescript` to the `@typescript/typescript6`
//   compat re-export so the linter gets the 6.0 API — but in this repo that
//   would quietly demote `npm run typecheck` from tsc 7 to tsc 6, which is a
//   worse trade than not linting the TypeScript. The TS half lands when
//   typescript-eslint ships TS 7 support; the flat config below is already the
//   shape that takes it.
//
// The rule set is `js.configs.recommended` and nothing else. Every rule in it
// is about a defect — an unreachable branch, a duplicate key, a promise
// executor that returns — never about layout. This project's files carry a lot
// of deliberate formatting and very deliberate comments, and a lint config that
// starts rewriting either is a lint config that gets deleted.
import js from "@eslint/js";
import globals from "globals";

export default [
  {
    // Everything not hand-written, plus the TypeScript this config cannot
    // parse. ESLint has no built-in TypeScript parser, so an unignored `.ts`
    // file is a crash, not a skip.
    ignores: [
      "**/*.ts",
      "**/*.tsx",
      "build/**",
      "dist/**",
      "external/**",
      "public/modules/**",
      // The primary checkout carries every live agent worktree under here, each
      // a full copy of this repo. Without this, `eslint .` lints them all: 242
      // files and 12034 errors, none of them about this tree. A worktree does
      // not contain other worktrees, so this is invisible from inside one —
      // which is exactly where the config was first verified.
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
        // Two hosts, one file. The gate runners are Node programs, but the
        // functions they hand to `page.evaluate()` are ordinary function
        // declarations in the same module that Playwright serializes and runs
        // inside the page — `browser-check.mjs` alone has 35 references to
        // `document` and `window` that are perfectly correct where they end up.
        // ESLint cannot tell the two halves apart, so `no-undef` here means
        // "not a global of either host", which still catches a typo'd name.
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // The drivers park an `err` they do not read and destructure fields they
      // only want skipped past. Matching tsconfig's noUnusedParameters, a
      // leading underscore is the way to say "unused on purpose"; an argument
      // before a used one cannot be removed at all.
      "no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        args: "after-used",
      }],
    },
  },
];
