import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * Copia el worker de pdf.js a `public/`.
 *
 * Corre en cada `npm install` (postinstall), así que el archivo servido y la
 * librería importada salen SIEMPRE de la misma versión instalada. pdf.js aborta
 * con "The API version does not match the Worker version" si difieren, y
 * commitear el worker en el repo es exactamente la forma de que difieran.
 *
 * Es el worker del build LEGACY, igual que la librería que carga
 * `src/lib/pdf/pdfjs.ts` (el motivo está documentado ahí). Mezclar builds es
 * otra forma de la misma desincronización.
 *
 * `public/pdf.worker.min.mjs` está en .gitignore: es un artefacto de build.
 */
const require = createRequire(import.meta.url);

const source = require.resolve("pdfjs-dist/legacy/build/pdf.worker.min.mjs");
const target = path.resolve(process.cwd(), "public", "pdf.worker.min.mjs");

await mkdir(path.dirname(target), { recursive: true });
await copyFile(source, target);

console.log(`pdf.js worker copiado a ${path.relative(process.cwd(), target)}`);
