import { z } from "zod";

import type { LengthUnit } from "@/lib/geometry";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * Contrato de la calibración de escala.
 *
 * El cliente MARCA (dos puntos en user-space + la cota real que lee del plano);
 * el servidor CALCULA (con el motor geométrico) y persiste. Lo que viaja no
 * incluye el `scaleFactor`: si el cliente lo mandara, alcanzaría con un POST a
 * mano para declarar cualquier escala, y todas las cubicaciones del plano
 * saldrían de un número que nadie derivó.
 *
 * Este módulo lo importan client components: nada de `server-only` acá.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** Versión del formato de `calibrationJson`. Subirla si cambian los campos. */
export const CALIBRATION_VERSION = 1;

/**
 * Un metro tiene 39,37 pulgadas y una unidad de user-space es 1/72 de pulgada.
 * Sirve para traducir el `scaleFactor` a la escala de arquitecto (1:50, 1:100)
 * que el usuario puede cruzar contra el cajetín del plano.
 */
export const METERS_PER_PDF_UNIT = 0.0254 / 72;

const unitSchema: z.ZodType<LengthUnit> = z.enum(["m", "cm", "mm"]);

/**
 * Un punto en user-space del PDF.
 *
 * `finite()` no es paranoia: un `Infinity` o un `NaN` que entre por acá se
 * propaga callado hasta el `scaleFactor` y ahí ya no hay forma de notarlo.
 */
const pointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

/** Lo que manda el cliente al calibrar. */
export const calibrationInputSchema = z.object({
  /** 0-based, como se guarda; el viewer numera desde 1 para el usuario. */
  pageIndex: z.number().int().nonnegative(),
  pdfPointA: pointSchema,
  pdfPointB: pointSchema,
  enteredValue: z.number().positive("La distancia real tiene que ser mayor a cero."),
  enteredUnit: unitSchema,
});

export type CalibrationInput = z.infer<typeof calibrationInputSchema>;

/** Lo que queda guardado: lo que marcó el usuario más lo que se derivó de eso. */
export type PlanCalibration = CalibrationInput & {
  version: typeof CALIBRATION_VERSION;
  /** Distancia entre los dos puntos en unidades de user-space. */
  pdfDistance: number;
  /** La cota, ya normalizada a metros. */
  realMeters: number;
  /** Cuándo se calibró, en ISO. Un plano se recalibra y conviene saber cuándo. */
  calibratedAt: string;
};

export const storedCalibrationSchema: z.ZodType<PlanCalibration> = z.object({
  version: z.literal(CALIBRATION_VERSION),
  pageIndex: z.number().int().nonnegative(),
  pdfPointA: pointSchema,
  pdfPointB: pointSchema,
  enteredValue: z.number().positive(),
  enteredUnit: unitSchema,
  pdfDistance: z.number().positive(),
  realMeters: z.number().positive(),
  calibratedAt: z.string(),
});

/**
 * Relee un `calibrationJson` que viene de la base.
 *
 * Misma regla que el diagnóstico: la columna es `Json` y lo que hay adentro lo
 * escribió una versión anterior del código. Si no valida, la UI muestra el
 * plano sin el detalle de la calibración en vez de romper.
 */
export function parseStoredCalibration(value: unknown): PlanCalibration | null {
  const parsed = storedCalibrationSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
}

/**
 * El denominador de la escala de arquitecto: 1:N.
 *
 * Es una comodidad de lectura, no un dato del sistema — el sistema mide con
 * `scaleFactor`. Sirve para el control de sanidad que cualquier arquitecto hace
 * de memoria: si el cajetín dice 1:100 y esto dice 1:99, la calibración está
 * bien; si dice 1:37, se marcó cualquier cosa.
 */
export function paperScaleDenominator(scaleFactor: number): number {
  return scaleFactor / METERS_PER_PDF_UNIT;
}
