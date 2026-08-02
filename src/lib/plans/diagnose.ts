import type * as PdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";

import {
  DIAGNOSIS_MAX_PAGES,
  DIAGNOSIS_VERSION,
  type DiagnosisInput,
  type PageCounts,
} from "@/lib/plans/diagnosis";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * Conteo de operadores por página: ¿el plano está DIBUJADO o ESCANEADO?
 *
 * Corre en el browser, sobre la lista de operadores que devuelve pdf.js
 * (`getOperatorList()`), sin renderizar nada. Acá NO se decide nada: esto
 * cuenta, y la heurística que interpreta los conteos vive en `diagnosis.ts`,
 * compartida con el servidor.
 *
 * ⚠️ Traducción a pdf.js v6: la lista de operadores YA NO trae `moveTo`,
 * `lineTo`, `curveTo` ni `rectangle` sueltos — el worker los comprime en un
 * único `constructPath` cuyos args son `[opDePintado, [Float32Array], minMax]`,
 * y el Float32Array trae los segmentos codificados como DrawOPS. Contar
 * `fnArray` a secas daría 1 por path, no 1 por segmento: la diferencia entre
 * "12 paths" y "9.400 segmentos" es justamente el dato que buscamos. Los ops
 * sueltos igual se cuentan por si aparecen (PDFs raros, versiones viejas).
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * Cuántos números consume cada DrawOP después del código, para poder saltarlos.
 *
 * ⚠️ `DrawOPS` es interno de pdf.js: NO está exportado, así que los códigos van
 * escritos a mano (v6: moveTo 0, lineTo 1, curveTo 2, quadraticCurveTo 3,
 * closePath 4). Si una versión futura los renumera, el recorrido corta en el
 * primer código desconocido y el conteo queda bajo — nunca inventado. Al subir
 * de major de pdfjs-dist, revisar esta tabla.
 */
const DRAW_OP_ARITY: ReadonlyMap<number, number> = new Map([
  [0, 2], // moveTo
  [1, 2], // lineTo
  [2, 6], // curveTo
  [3, 4], // quadraticCurveTo
  [4, 0], // closePath
]);

function isNumberArray(value: unknown): value is ArrayLike<number> {
  return value instanceof Float32Array || Array.isArray(value);
}

/**
 * Segmentos codificados en el buffer de un `constructPath`.
 *
 * Se recorre igual que `makePathFromDrawOPS` de pdf.js: código de operación,
 * después sus coordenadas. Ante un código desconocido cortamos — seguir
 * leyendo desalineado contaría basura, y un conteo inventado es peor que uno
 * corto.
 */
function countPathSegments(buffer: ArrayLike<number>): number {
  let segments = 0;

  for (let i = 0; i < buffer.length; ) {
    const arity = DRAW_OP_ARITY.get(buffer[i]);

    if (arity === undefined) {
      break;
    }

    segments += 1;
    i += 1 + arity;
  }

  return segments;
}

/**
 * Área de la página que cubre una imagen, como fracción del MediaBox.
 *
 * pdf.js dibuja toda imagen sobre el cuadrado unitario de la transformación
 * corriente, así que el área cubierta es |det(CTM)|. Y como det(A·B) =
 * det(A)·det(B), no hace falta llevar la matriz entera: alcanza con el
 * determinante, un solo número, con su pila de save/restore.
 *
 * Es una aproximación deliberada: ignora clips y grupos de transparencia, que
 * pueden recortar la imagen. Sobreestima la cobertura, nunca la subestima —
 * el error empuja hacia "raster", que es el lado conservador (un falso
 * "vectorial" mandaría la auto-detección de muros a buscar geometría que no
 * existe).
 */
type TransformTracker = {
  determinant: number;
  stack: number[];
};

function readMatrixDeterminant(value: unknown): number | null {
  if (!isNumberArray(value) || value.length < 4) {
    return null;
  }

  // Índices y no destructuring: `value` puede ser un Float32Array, y ArrayLike
  // no promete ser iterable.
  return value[0] * value[3] - value[1] * value[2];
}

/**
 * La tabla de códigos de operación de pdf.js (`OPS`).
 *
 * Se lee por acceso a propiedad y no por nombre dinámico: si una versión futura
 * renombra un operador, el error aparece al compilar y no como un conteo que da
 * cero sin que nadie se entere.
 */
type PdfOps = typeof PdfjsLib.OPS;

type OpSets = {
  paint: ReadonlySet<number>;
  legacyPath: ReadonlySet<number>;
  image: ReadonlySet<number>;
  /** Máscaras de color plano: cuentan como imagen, pero no cubren píxeles. */
  flatImage: ReadonlySet<number>;
  text: ReadonlySet<number>;
};

function buildOpSets(ops: PdfOps): OpSets {
  return {
    paint: new Set([
      ops.stroke,
      ops.closeStroke,
      ops.fill,
      ops.eoFill,
      ops.fillStroke,
      ops.eoFillStroke,
      ops.closeFillStroke,
      ops.closeEOFillStroke,
      ops.shadingFill,
    ]),
    // En v6 el worker los comprime en constructPath y nunca aparecen sueltos.
    // Se cuentan igual: es la red por si el motor cambia de versión.
    legacyPath: new Set([
      ops.moveTo,
      ops.lineTo,
      ops.curveTo,
      ops.curveTo2,
      ops.curveTo3,
      ops.closePath,
      ops.rectangle,
    ]),
    image: new Set([
      ops.paintImageXObject,
      ops.paintImageXObjectRepeat,
      ops.paintInlineImageXObject,
      ops.paintInlineImageXObjectGroup,
      ops.paintImageMaskXObject,
      ops.paintImageMaskXObjectGroup,
      ops.paintImageMaskXObjectRepeat,
    ]),
    flatImage: new Set([ops.paintSolidColorImageMask]),
    text: new Set([
      ops.showText,
      ops.showSpacedText,
      ops.nextLineShowText,
      ops.nextLineSetSpacingShowText,
    ]),
  };
}

function countPage(
  ops: PdfOps,
  sets: OpSets,
  fnArray: readonly number[],
  argsArray: readonly unknown[],
  pageAreaPoints: number,
  pageNumber: number
): PageCounts {
  const counts: PageCounts = {
    page: pageNumber,
    vectorSegments: 0,
    paintOps: 0,
    imageOps: 0,
    textOps: 0,
    maxImageCoverage: 0,
  };

  const ctm: TransformTracker = { determinant: 1, stack: [] };

  for (let i = 0; i < fnArray.length; i += 1) {
    const fn = fnArray[i];
    const args: unknown = argsArray[i];

    if (fn === ops.constructPath) {
      counts.paintOps += 1;

      // args = [opDePintado, [buffer], minMax]; el buffer puede venir null
      // cuando el path quedó vacío (p. ej. un endPath sin geometría).
      const buffer = Array.isArray(args) && Array.isArray(args[1]) ? args[1][0] : undefined;

      if (isNumberArray(buffer)) {
        counts.vectorSegments += countPathSegments(buffer);
      }

      continue;
    }

    if (sets.legacyPath.has(fn)) {
      counts.vectorSegments += 1;
      continue;
    }

    if (sets.paint.has(fn)) {
      counts.paintOps += 1;
      continue;
    }

    if (sets.text.has(fn)) {
      counts.textOps += 1;
      continue;
    }

    if (sets.image.has(fn) || sets.flatImage.has(fn)) {
      counts.imageOps += 1;

      if (sets.image.has(fn) && pageAreaPoints > 0) {
        const coverage = Math.abs(ctm.determinant) / pageAreaPoints;

        counts.maxImageCoverage = Math.max(counts.maxImageCoverage, coverage);
      }

      continue;
    }

    // A partir de acá, solo lo que mueve la transformación corriente.
    if (fn === ops.save) {
      ctm.stack.push(ctm.determinant);
      continue;
    }

    if (fn === ops.restore) {
      ctm.determinant = ctm.stack.pop() ?? ctm.determinant;
      continue;
    }

    if (fn === ops.transform) {
      const determinant = readMatrixDeterminant(args);

      if (determinant !== null) {
        ctm.determinant *= determinant;
      }

      continue;
    }

    if (fn === ops.paintFormXObjectBegin) {
      // El canvas de pdf.js hace save() y aplica la matriz: replicamos las dos.
      ctm.stack.push(ctm.determinant);

      const determinant = Array.isArray(args) ? readMatrixDeterminant(args[0]) : null;

      if (determinant !== null) {
        ctm.determinant *= determinant;
      }

      continue;
    }

    if (fn === ops.paintFormXObjectEnd) {
      ctm.determinant = ctm.stack.pop() ?? ctm.determinant;
    }
  }

  // Tres decimales alcanzan para una fracción de área y mantienen el JSON chico.
  counts.maxImageCoverage = Math.round(counts.maxImageCoverage * 1000) / 1000;

  return counts;
}

/**
 * Diagnostica un documento ya abierto por pdf.js.
 *
 * Devuelve SOLO conteos: el veredicto lo pone `diagnosePlan()` del lado del
 * servidor, sobre estos mismos números.
 */
export async function diagnoseDocument(
  pdf: PDFDocumentProxy,
  ops: PdfOps,
  engine: string
): Promise<DiagnosisInput> {
  const analyzedPages = Math.min(pdf.numPages, DIAGNOSIS_MAX_PAGES);
  const sets = buildOpSets(ops);
  const pages: PageCounts[] = [];

  for (let pageNumber = 1; pageNumber <= analyzedPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);

    try {
      const viewport = page.getViewport({ scale: 1 });
      const operatorList = await page.getOperatorList();

      pages.push(
        countPage(
          ops,
          sets,
          operatorList.fnArray,
          operatorList.argsArray,
          viewport.width * viewport.height,
          pageNumber
        )
      );
    } finally {
      // Sin esto, un PDF grande deja en memoria la lista de operadores de todas
      // las páginas a la vez.
      page.cleanup();
    }
  }

  return {
    version: DIAGNOSIS_VERSION,
    engine,
    pageCount: pdf.numPages,
    pages,
  };
}
