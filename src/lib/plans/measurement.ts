import { z } from "zod";

import {
  applyScaleArea,
  applyScaleLength,
  polygonArea,
  polylineLength,
  type Point,
} from "@/lib/geometry";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * Contrato de las mediciones.
 *
 * El cliente DIBUJA (vértices en user-space del PDF); el servidor CALCULA. La
 * fórmula vive acá una sola vez y la usan los dos lados: el cliente para el
 * preview en vivo, el servidor para el número que se persiste. Que sea el mismo
 * código es lo que hace que el preview y el valor guardado no puedan divergir
 * por descuido — y si divergen igual, es que algo más está mal, por eso el
 * server compara y avisa.
 *
 * Este módulo lo importan client components: nada de `server-only` acá.
 * ────────────────────────────────────────────────────────────────────────────
 */

export const MEASUREMENT_TYPES = ["LARGO_CONTINUO", "MURO", "AREA"] as const;

export type MeasurementType = (typeof MEASUREMENT_TYPES)[number];

export const measurementTypeSchema = z.enum(
  MEASUREMENT_TYPES,
  "Herramienta de medición desconocida."
);

/** Cómo se llama cada herramienta y qué devuelve. */
export const MEASUREMENT_META: Readonly<
  Record<MeasurementType, { label: string; unit: "m" | "m²"; minPoints: number; closed: boolean }>
> = {
  LARGO_CONTINUO: { label: "Largo", unit: "m", minPoints: 2, closed: false },
  MURO: { label: "Muro", unit: "m²", minPoints: 2, closed: false },
  AREA: { label: "Área", unit: "m²", minPoints: 3, closed: true },
};

/**
 * Tolerancia relativa entre el preview del cliente y el valor del servidor.
 *
 * 1e-9 es ruido de punto flotante entre dos máquinas corriendo la misma cuenta.
 * Cualquier cosa más grande significa que las dos puntas no están calculando lo
 * mismo —código viejo en el bundle del browser, una fórmula tocada de un solo
 * lado— y eso hay que verlo en el log, no descubrirlo en un presupuesto.
 */
export const VALUE_MISMATCH_EPSILON = 1e-9;

/**
 * Todo mensaje de este schema puede terminar en pantalla: el server action
 * devuelve `parsed.error.issues[0].message` tal cual al cliente. Por eso van
 * TODOS escritos, y en castellano — el default de Zod es en inglés y desentona
 * con el resto de la app (lo pescó el E2E de TD-005).
 */
const INVALID_POINT = "Los puntos de la medición no son válidos.";

const pointSchema = z.object({
  x: z.number(INVALID_POINT).finite(INVALID_POINT),
  y: z.number(INVALID_POINT).finite(INVALID_POINT),
});

/**
 * Los puntos que manda el cliente.
 *
 * El techo de 500 vértices no es por la cuenta —el shoelace no se despeina—
 * sino porque el `geometryJson` viaja en cada carga de la página y una
 * polilínea de 50.000 puntos es un error de la UI, no un contorno de obra.
 */
export const pointsSchema = z
  .array(pointSchema)
  .min(2, "Marcá al menos 2 puntos.")
  .max(500, "Una medición no puede tener más de 500 vértices.");

/**
 * El mensaje del mínimo de vértices, que depende de la herramienta.
 *
 * `issue.input` es el objeto que se estaba validando y llega como `unknown`: se
 * lee el `type` con cuidado en vez de castear el objeto entero.
 */
function minPointsMessage(input: unknown): string {
  const type =
    typeof input === "object" && input !== null && "type" in input ? input.type : null;

  return type === "AREA" ? "Un área necesita al menos 3 puntos." : "Marcá al menos 2 puntos.";
}

export const createMeasurementSchema = z
  .object({
    planId: z.uuid("Plano inválido."),
    type: measurementTypeSchema,
    pageIndex: z
      .number("La página del plano no es válida.")
      .int("La página del plano no es válida.")
      .nonnegative("La página del plano no es válida."),
    points: pointsSchema,
    /** Altura del muro en metros. Obligatoria para MURO, prohibida para el resto. */
    alto: z
      .number("El alto del muro no es válido.")
      .positive("El alto del muro debe ser mayor a 0.")
      .max(100, "El alto del muro no puede pasar de 100 m.")
      .nullable(),
    label: z
      .string("La etiqueta no es válida.")
      .trim()
      .max(120, "La etiqueta es demasiado larga.")
      .nullable(),
    /** Lo que mostró el cliente mientras dibujaba. Se compara, no se persiste. */
    previewValue: z
      .number("El valor previsualizado no es válido.")
      .positive("El valor previsualizado no es válido.")
      .finite("El valor previsualizado no es válido."),
  })
  .refine((value) => value.points.length >= MEASUREMENT_META[value.type].minPoints, {
    error: (issue) => minPointsMessage(issue.input),
  })
  .refine(
    (value) => (value.type === "MURO" ? value.alto !== null : value.alto === null),
    "El alto es obligatorio para un muro y no corresponde en los otros tipos."
  );

export type CreateMeasurementInput = z.infer<typeof createMeasurementSchema>;

/** Relee un `geometryJson` que viene de la base (columna `Json`, sin garantías). */
export const storedGeometrySchema = z.array(pointSchema).min(2);

export function parseStoredGeometry(value: unknown): Point[] | null {
  const parsed = storedGeometrySchema.safeParse(value);

  return parsed.success ? parsed.data : null;
}

/**
 * La cuenta, en un solo lugar.
 *
 *   LARGO_CONTINUO -> largo_pdf × scaleFactor              (metros)
 *   MURO           -> largo_pdf × scaleFactor × alto       (m²)
 *   AREA           -> área_pdf  × scaleFactor²             (m²)
 *
 * El cuadrado del área no es un detalle: el factor escala cada dimensión y un
 * área tiene dos. Está en `applyScaleArea` y testeado en el motor.
 *
 * Tira si la geometría no alcanza para el tipo pedido (las guardas del motor).
 */
export function computeMeasurementValue(
  type: MeasurementType,
  points: readonly Point[],
  scaleFactor: number,
  alto: number | null
): number {
  if (type === "AREA") {
    return applyScaleArea(polygonArea(points), scaleFactor);
  }

  const length = applyScaleLength(polylineLength(points), scaleFactor);

  if (type !== "MURO") {
    return length;
  }

  if (alto === null || !Number.isFinite(alto) || alto <= 0) {
    throw new Error("Un muro necesita un alto mayor a cero.");
  }

  return length * alto;
}

/** "12,45 m²" — dos decimales, que es la precisión con la que se presupuesta. */
export function formatMeasurement(value: number, type: MeasurementType): string {
  return `${value.toFixed(2).replace(".", ",")} ${MEASUREMENT_META[type].unit}`;
}
