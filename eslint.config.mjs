import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Worker de pdf.js: bundle minificado de terceros, copiado por
    // scripts/copy-pdf-worker.mjs. No es código nuestro y no se edita.
    "public/pdf.worker.min.mjs",
  ]),
]);

export default eslintConfig;
