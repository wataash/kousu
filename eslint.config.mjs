import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";

// https://github.com/prettier/eslint-config-prettier
import eslintConfigPrettier from "eslint-config-prettier";

/** @type {import('eslint').Linter.Config[]} */
export default [
  { ignores: ["dist/**/*"]},
  {languageOptions: { globals: globals.node }},
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
];
