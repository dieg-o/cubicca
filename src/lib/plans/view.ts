import { parseStoredDiagnosis, type PlanDiagnosis } from "@/lib/plans/diagnosis";

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
};

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
  };
}
