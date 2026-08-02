"use client";

import type * as PdfjsLib from "pdfjs-dist";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * Carga de pdf.js. Solo en el browser.
 *
 * El import es DINÁMICO a propósito: los client components también se renderizan
 * en el servidor (SSR), y pdf.js toca `document`, `DOMMatrix` y `Worker` al
 * evaluarse. Un import estático lo traería a ese render y rompería.
 *
 * El módulo se carga una sola vez por pestaña: `GlobalWorkerOptions` es
 * global (el nombre no miente), así que configurarlo dos veces sería pisarlo.
 *
 * ⚠️ Se usa el build LEGACY, no el moderno. No es conservadurismo gratis: el
 * build moderno de pdf.js v6 llama a `Map.prototype.getOrInsertComputed`, que
 * es de una propuesta reciente de TC39 y todavía no está en todos los Chrome en
 * la calle. Sin ese método, `getOperatorList()` explota con
 * "this._intentStates.getOrInsertComputed is not a function" — verificado en
 * Chromium headless, no es teoría. El build legacy trae el polyfill adentro.
 * El precio es un bundle un poco más grande; el precio de la otra opción es que
 * el diagnóstico no corra en la máquina de un cliente.
 * ────────────────────────────────────────────────────────────────────────────
 */

let pdfjs: Promise<typeof PdfjsLib> | null = null;

export function loadPdfjs(): Promise<typeof PdfjsLib> {
  // `legacy/build/pdf.d.mts` reexporta los tipos del entrypoint principal, así
  // que la ruta legacy viene tipada igual: no hay `any` que se cuele por acá.
  pdfjs ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((lib) => {
    // El worker se sirve desde /public, y es el worker LEGACY: tiene que salir
    // del mismo build que la librería. La alternativa —dejar que el bundler lo
    // resuelva desde node_modules— depende de que Turbopack entienda un
    // `new URL(<paquete>, import.meta.url)`, y un fallo ahí aparece recién en
    // runtime como "Setting up fake worker failed". El archivo lo copia
    // `scripts/copy-pdf-worker.mjs` en cada `npm install`, así que su versión
    // NO se puede desincronizar de la librería (pdf.js aborta si difieren).
    lib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

    return lib;
  });

  return pdfjs;
}

/** Identifica al motor en `diagnosisJson`: el veredicto depende de su versión. */
export async function getPdfjsEngineId(): Promise<string> {
  const lib = await loadPdfjs();

  return `pdfjs-dist@${lib.version}`;
}
