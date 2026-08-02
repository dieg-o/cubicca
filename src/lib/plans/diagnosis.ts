import { z } from "zod";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * Contrato del diagnóstico vector/raster.
 *
 * El CONTEO lo hace el cliente (pdf.js corre en el browser, ver
 * `src/lib/plans/diagnose.ts`); el VEREDICTO lo calcula esta heurística, que es
 * pura y compartida. El server la vuelve a aplicar sobre los conteos que recibe
 * en vez de creerle el veredicto al cliente: así el JSON guardado nunca puede
 * contradecir a sus propios números, y si mañana movemos un umbral, alcanza con
 * recalcular sobre lo que ya está persistido.
 *
 * Este módulo lo importan client components: nada de `server-only` acá.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** Versión del formato de `diagnosisJson`. Subirla si cambian los campos. */
export const DIAGNOSIS_VERSION = 1;

/**
 * Tope de páginas analizadas. El conteo de operadores es O(operadores) y corre
 * en el browser: un PDF de 500 páginas colgaría la pestaña sin aportar nada.
 * `pageCount` sigue siendo el real del documento.
 */
export const DIAGNOSIS_MAX_PAGES = 30;

/**
 * Umbrales de la heurística. Los números salen de cómo se ven en la práctica
 * los dos extremos: un plano vectorial de CAD trae miles de segmentos por
 * página; un escaneo trae una sola imagen y, como mucho, un sello o un marco.
 */

/** Segmentos de path mínimos para considerar que la página tiene geometría. */
export const VECTOR_SEGMENT_THRESHOLD = 40;

/** Cobertura (fracción del área de página) desde la cual una imagen "domina". */
export const FULL_PAGE_IMAGE_COVERAGE = 0.6;

/**
 * Con una imagen a página completa encima, hace falta MUCHA más geometría para
 * llamar vectorial a la página: un escaneo con marco, sello y cajetín vectorial
 * puede pasar los 40 segmentos sin que ninguna pared sea vectorial.
 */
export const IMAGE_DOMINANCE_ESCAPE_SEGMENTS = 200;

/** Conteos crudos de una página. Es lo que el cliente calcula y manda. */
export const pageCountsSchema = z.object({
  /** 1-based, como lo numera pdf.js y como lo ve el usuario. */
  page: z.number().int().positive(),
  /** Segmentos de path: moveTo / lineTo / curveTo / quadraticCurveTo / closePath. */
  vectorSegments: z.number().int().nonnegative(),
  /** Operaciones de pintado de path: stroke / fill / eoFill / fillStroke / … */
  paintOps: z.number().int().nonnegative(),
  /** Operaciones de imagen: paintImageXObject / paintInlineImageXObject / … */
  imageOps: z.number().int().nonnegative(),
  /** Operaciones de texto: showText / showSpacedText / … */
  textOps: z.number().int().nonnegative(),
  /**
   * Fracción del área de la página cubierta por la imagen más grande.
   * Puede pasar de 1 (una imagen puede exceder el MediaBox), por eso no hay max.
   */
  maxImageCoverage: z.number().nonnegative().finite(),
});

export type PageCounts = z.infer<typeof pageCountsSchema>;

/** Lo que el cliente manda: conteos crudos, sin veredicto. */
export const diagnosisInputSchema = z
  .object({
    version: z.literal(DIAGNOSIS_VERSION),
    /** Motor y versión que produjo los conteos, p. ej. "pdfjs-dist@6.2.108". */
    engine: z.string().min(1).max(64),
    /** Páginas del documento (puede ser mayor que las analizadas). */
    pageCount: z.number().int().positive(),
    pages: z.array(pageCountsSchema).min(1).max(DIAGNOSIS_MAX_PAGES),
  })
  .refine(
    (value) => value.pages.every((page) => page.page <= value.pageCount),
    "Hay páginas diagnosticadas fuera del rango del documento."
  )
  .refine(
    (value) => value.pages.length === new Set(value.pages.map((page) => page.page)).size,
    "Hay páginas diagnosticadas repetidas."
  );

export type DiagnosisInput = z.infer<typeof diagnosisInputSchema>;

/** Una página con su veredicto ya resuelto. Es lo que se persiste. */
export type PageDiagnosis = PageCounts & {
  isVector: boolean;
  /** Por qué dio lo que dio. Se muestra en el desglose de la UI. */
  reason: "vector" | "sin-geometria" | "imagen-dominante";
};

export type PlanDiagnosis = {
  version: typeof DIAGNOSIS_VERSION;
  engine: string;
  pageCount: number;
  analyzedPageCount: number;
  hasVectorGeometry: boolean;
  vectorPageCount: number;
  pages: PageDiagnosis[];
};

/**
 * El veredicto de una página.
 *
 * Vectorial = tiene geometría propia suficiente Y no es un escaneo con algo
 * dibujado encima. Lo segundo importa tanto como lo primero: un plano escaneado
 * con cajetín vectorial tiene paths de sobra y ni una pared que detectar.
 */
export function diagnosePage(counts: PageCounts): PageDiagnosis {
  if (counts.vectorSegments < VECTOR_SEGMENT_THRESHOLD) {
    return { ...counts, isVector: false, reason: "sin-geometria" };
  }

  const dominatedByImage =
    counts.maxImageCoverage >= FULL_PAGE_IMAGE_COVERAGE &&
    counts.vectorSegments < IMAGE_DOMINANCE_ESCAPE_SEGMENTS;

  return dominatedByImage
    ? { ...counts, isVector: false, reason: "imagen-dominante" }
    : { ...counts, isVector: true, reason: "vector" };
}

/**
 * El veredicto del documento: alcanza UNA página con geometría vectorial
 * significativa. Un PDF de 12 páginas donde solo la planta baja es vectorial
 * igual sirve para auto-detectar muros — en esa página.
 */
export function diagnosePlan(input: DiagnosisInput): PlanDiagnosis {
  const pages = input.pages.map(diagnosePage);
  const vectorPageCount = pages.filter((page) => page.isVector).length;

  return {
    version: DIAGNOSIS_VERSION,
    engine: input.engine,
    pageCount: input.pageCount,
    analyzedPageCount: pages.length,
    hasVectorGeometry: vectorPageCount > 0,
    vectorPageCount,
    pages,
  };
}

/**
 * Relee un `diagnosisJson` que viene de la base.
 *
 * La columna es `Json`: lo que hay adentro lo escribió una versión anterior del
 * código y no hay tipo que lo garantice. Se valida igual que si viniera del
 * request, y si no valida se muestra el plano sin desglose en vez de romper.
 */
export const storedDiagnosisSchema: z.ZodType<PlanDiagnosis> = z.object({
  version: z.literal(DIAGNOSIS_VERSION),
  engine: z.string(),
  pageCount: z.number().int().positive(),
  analyzedPageCount: z.number().int().nonnegative(),
  hasVectorGeometry: z.boolean(),
  vectorPageCount: z.number().int().nonnegative(),
  pages: z.array(
    pageCountsSchema.extend({
      isVector: z.boolean(),
      reason: z.enum(["vector", "sin-geometria", "imagen-dominante"]),
    })
  ),
});

export function parseStoredDiagnosis(value: unknown): PlanDiagnosis | null {
  const parsed = storedDiagnosisSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
}
