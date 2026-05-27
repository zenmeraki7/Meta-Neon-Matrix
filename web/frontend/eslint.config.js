import noHardcodedMerchantText from "./eslint-rules/no-hardcoded-merchant-text.js";

export default [
  {
    files: ["**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      local: {
        rules: {
          "no-hardcoded-merchant-text": noHardcodedMerchantText,
        },
      },
    },
    rules: {
      "local/no-hardcoded-merchant-text": "error",
    },
    ignores: [
      "node_modules/**",
      "dist/**",
      "**/*.test.js",
      "**/*.test.jsx",
    ],
  },
];

