const js = require("@eslint/js");

module.exports = [
  {
    ignores: ["node_modules/**", "venv/**", "lab5-results/**"]
  },
  js.configs.recommended,
  {
    files: ["src/**/*.js", "test/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "readonly",
        exports: "readonly",
        process: "readonly",
        Buffer: "readonly",
        console: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        setImmediate: "readonly",
        clearImmediate: "readonly",
        AbortController: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly"
      }
    },
    rules: {
      "no-await-in-loop": "error"
    }
  }
];
