/**
 * ────────────────────────────────────────────────────────────────────────────
 * Motor geométrico. Funciones puras, sin React, sin Next, sin pdf.js.
 *
 * Todo lo que mide CUBICCA sale de acá: la UI marca puntos y el server llama a
 * estas funciones. Que sea puro no es prolijidad — es lo que permite testear
 * las cuentas contra casos conocidos (3-4-5, shoelace de un triángulo) sin
 * levantar un browser ni una base.
 *
 * ── Dos convenciones que valen para todo el módulo ──
 *
 * 1. Los puntos están en USER-SPACE del PDF, nunca en píxeles. Un píxel
 *    depende del zoom, del tamaño de la ventana y del DPR de la pantalla; el
 *    user-space es del documento y no se mueve. La conversión click → user-space
 *    la hace el viewer con `viewport.convertToPdfPoint()`, y de ahí para adentro
 *    acá no entra un píxel.
 *
 * 2. Toda longitud real está en METROS. `scaleFactor` son metros por unidad de
 *    user-space. El usuario tipea en m/cm/mm y se normaliza ANTES de derivar
 *    nada: una sola unidad adentro del sistema, la conversión en el borde.
 *
 * De esas dos convenciones salen las dos fórmulas del negocio:
 *   longitud real = longitud_pdf × scaleFactor
 *   área real     = área_pdf     × scaleFactor²   (el cuadrado no es opcional)
 * ────────────────────────────────────────────────────────────────────────────
 */

/** Un punto en user-space del PDF. */
export type Point = { x: number; y: number };

/** Unidades que el usuario puede tipear al calibrar. */
export type LengthUnit = "m" | "cm" | "mm";

export const LENGTH_UNITS: readonly LengthUnit[] = ["m", "cm", "mm"];

const METERS_PER_UNIT: Readonly<Record<LengthUnit, number>> = {
  m: 1,
  cm: 0.01,
  mm: 0.001,
};

/**
 * Un número que sirve para medir: finito y no NaN.
 *
 * Se chequea seguido y a propósito. `NaN` se propaga callado por toda la
 * aritmética y termina persistido como un `scaleFactor` inútil; un error acá se
 * ve en el momento y con el nombre del dato que vino mal.
 */
function assertFinite(value: number, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} tiene que ser un número finito (llegó ${String(value)}).`);
  }
}

function assertPoint(point: Point, label: string): void {
  assertFinite(point?.x, `${label}.x`);
  assertFinite(point?.y, `${label}.y`);
}

/** Distancia euclídea entre dos puntos, en unidades de user-space. */
export function distance(a: Point, b: Point): number {
  assertPoint(a, "a");
  assertPoint(b, "b");

  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Largo total de una polilínea: la suma de sus segmentos.
 *
 * NO cierra la figura. Un cuadrado unitario marcado con sus 4 vértices mide 3,
 * no 4: el usuario marcó tres segmentos. Cerrarlo por nuestra cuenta sería
 * inventarle un cuarto muro que no dibujó.
 */
export function polylineLength(points: readonly Point[]): number {
  if (points.length < 2) {
    throw new Error(`Una polilínea necesita al menos 2 puntos (llegaron ${points.length}).`);
  }

  let total = 0;

  for (let i = 1; i < points.length; i += 1) {
    total += distance(points[i - 1], points[i]);
  }

  return total;
}

/**
 * Área de un polígono por la fórmula del cordón (shoelace), en valor absoluto.
 *
 * Absoluto a propósito: el signo del shoelace solo dice si los vértices se
 * marcaron en sentido horario o antihorario, y un área negativa porque el
 * usuario giró para el otro lado no tiene ningún sentido físico.
 *
 * El polígono se cierra solo (último vértice con el primero): a diferencia de
 * una polilínea, un área abierta no existe. Sirve igual para una losa que para
 * el triángulo de un hastial.
 */
export function polygonArea(points: readonly Point[]): number {
  if (points.length < 3) {
    throw new Error(`Un polígono necesita al menos 3 puntos (llegaron ${points.length}).`);
  }

  let doubleArea = 0;

  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    // El módulo cierra la figura sin tener que duplicar el primer vértice.
    const next = points[(i + 1) % points.length];

    assertPoint(current, `points[${i}]`);
    assertPoint(next, `points[${(i + 1) % points.length}]`);

    doubleArea += current.x * next.y - next.x * current.y;
  }

  return Math.abs(doubleArea) / 2;
}

/** Pasa a metros un valor tipeado por el usuario en m, cm o mm. */
export function toMeters(value: number, unit: LengthUnit): number {
  assertFinite(value, "El valor");

  const factor = METERS_PER_UNIT[unit];

  if (factor === undefined) {
    throw new Error(`Unidad desconocida: ${String(unit)}.`);
  }

  return value * factor;
}

/**
 * El factor de escala del plano: metros reales por unidad de user-space.
 *
 * Es una división, y por eso las dos guardas. `pdfDistance <= 0` es el caso
 * real de un doble click en el mismo lugar: sin guarda devolvería `Infinity` y
 * ese infinito quedaría persistido, envenenando toda medición futura del plano.
 */
export function scaleFactorFromCalibration(pdfDistance: number, realMeters: number): number {
  assertFinite(pdfDistance, "La distancia en el PDF");
  assertFinite(realMeters, "La distancia real");

  if (pdfDistance <= 0) {
    throw new Error("Los dos puntos de la calibración tienen que estar separados.");
  }

  if (realMeters <= 0) {
    throw new Error("La distancia real tiene que ser mayor a cero.");
  }

  return realMeters / pdfDistance;
}

/** Longitud real, en metros, de una longitud medida en user-space. */
export function applyScaleLength(pdfLength: number, scaleFactor: number): number {
  assertFinite(pdfLength, "La longitud en el PDF");
  assertFinite(scaleFactor, "El factor de escala");

  return pdfLength * scaleFactor;
}

/**
 * Área real, en metros cuadrados, de un área medida en user-space.
 *
 * Va al CUADRADO: el factor escala cada dimensión, y el área tiene dos. Con
 * scaleFactor 0,05 un área de 400 unidades PDF son 1 m², no 20.
 */
export function applyScaleArea(pdfArea: number, scaleFactor: number): number {
  assertFinite(pdfArea, "El área en el PDF");
  assertFinite(scaleFactor, "El factor de escala");

  return pdfArea * scaleFactor * scaleFactor;
}
