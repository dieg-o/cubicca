import type { Point } from "@/lib/geometry";
import { parseStoredCalibration, type PlanCalibration } from "@/lib/plans/calibration";
import { parseStoredDiagnosis, type PlanDiagnosis } from "@/lib/plans/diagnosis";
import { parseStoredGeometry, type MeasurementType } from "@/lib/plans/measurement";

/**
 * El plano tal como lo ve la UI.
 *
 * Lo que cruza del server al client component tiene que ser serializable: nada
 * de `Date` ni del `JsonValue` de Prisma. Y tampoco va la fila entera —
 * `storagePath` es interno: el cliente pide el archivo por `planId` y el
 * servidor decide qué objeto firma.
 */
export type PlanSummary = {
  id: string;
  originalFilename: string;
  fileSizeBytes: number;
  status: "PENDING" | "READY";
  pageCount: number | null;
  hasVectorGeometry: boolean | null;
  createdAt: string;
  diagnosis: PlanDiagnosis | null;
  /** Metros por unidad de user-space. `null` = el plano no se calibró todavía. */
  scaleFactor: number | null;
  calibration: PlanCalibration | null;
};

/** Forma mínima de la fila que necesita el mapeo (no importa Prisma acá). */
type PlanRow = {
  id: string;
  originalFilename: string;
  fileSizeBytes: number;
  status: "PENDING" | "READY";
  pageCount: number | null;
  hasVectorGeometry: boolean | null;
  createdAt: Date;
  diagnosisJson: unknown;
  scaleFactor: number | null;
  calibrationJson: unknown;
};

/** Una medición tal como la ve la UI. */
export type MeasurementSummary = {
  id: string;
  planId: string;
  type: MeasurementType;
  pageIndex: number;
  /** Los vértices en user-space. `null` si el JSON guardado no valida. */
  points: Point[] | null;
  computedValue: number;
  alto: number | null;
  label: string | null;
  createdAt: string;
};

type MeasurementRow = {
  id: string;
  planId: string;
  type: MeasurementType;
  pageIndex: number;
  geometryJson: unknown;
  computedValue: number;
  alto: number | null;
  label: string | null;
  createdAt: Date;
};

export function toMeasurementSummary(measurement: MeasurementRow): MeasurementSummary {
  return {
    id: measurement.id,
    planId: measurement.planId,
    type: measurement.type,
    pageIndex: measurement.pageIndex,
    // Si la geometría guardada no valida, la medición se sigue listando con su
    // valor: lo único que se pierde es poder redibujarla sobre el plano.
    points: parseStoredGeometry(measurement.geometryJson),
    computedValue: measurement.computedValue,
    alto: measurement.alto,
    label: measurement.label,
    createdAt: measurement.createdAt.toISOString(),
  };
}

export function toPlanSummary(plan: PlanRow): PlanSummary {
  return {
    id: plan.id,
    originalFilename: plan.originalFilename,
    fileSizeBytes: plan.fileSizeBytes,
    status: plan.status,
    pageCount: plan.pageCount,
    hasVectorGeometry: plan.hasVectorGeometry,
    createdAt: plan.createdAt.toISOString(),
    // La columna es `Json`: lo que hay adentro lo escribió una versión anterior
    // del código. Si no valida, se muestra el plano sin desglose y listo.
    diagnosis: parseStoredDiagnosis(plan.diagnosisJson),
    scaleFactor: plan.scaleFactor,
    calibration: parseStoredCalibration(plan.calibrationJson),
  };
}
