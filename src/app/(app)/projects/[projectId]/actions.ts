"use server";

import { randomUUID } from "node:crypto";

import { z } from "zod";

import { requireProfile } from "@/lib/auth/session";
import { getTenantPrisma } from "@/lib/db/tenant";
import { distance, scaleFactorFromCalibration, toMeters } from "@/lib/geometry";
import {
  CALIBRATION_VERSION,
  calibrationInputSchema,
  type PlanCalibration,
} from "@/lib/plans/calibration";
import { PLAN_CONTENT_TYPE, PLAN_MAX_FILE_SIZE_BYTES } from "@/lib/plans/constants";
import { diagnosePlan, diagnosisInputSchema } from "@/lib/plans/diagnosis";
import { getSupabaseAdmin, PLANS_BUCKET } from "@/lib/supabase/admin";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * Upload de planos: los bytes NO pasan por acá.
 *
 * El lambda de Vercel topea en ~4,5 MB de body, y un plano de obra pesa más que
 * eso sin despeinarse. El archivo va directo del browser a Supabase Storage con
 * una URL firmada de subida; el server solo autoriza (antes) y confirma
 * (después). Estos dos actions son esos dos momentos.
 *
 * El bucket es PRIVADO y no tiene RLS: la autorización vive acá. Toda operación
 * de Storage se mintea únicamente después de haber probado, vía
 * getTenantPrisma(orgId), que la fila es de la organización de la sesión.
 * ────────────────────────────────────────────────────────────────────────────
 */

export type RequestPlanUploadResult =
  | {
      ok: true;
      planId: string;
      /** Clave del objeto dentro del bucket. */
      path: string;
      /** Token de subida. Viene embebido en `signedUrl`; se expone por claridad. */
      token: string;
      /** URL completa a la que el browser hace PUT. Vale 2 horas. */
      signedUrl: string;
    }
  | { ok: false; error: string };

export type FinalizePlanUploadResult = { ok: true } | { ok: false; error: string };

const requestUploadSchema = z.object({
  projectId: z.uuid("Proyecto inválido."),
  filename: z
    .string()
    .trim()
    .min(1, "El archivo no tiene nombre.")
    .max(255, "El nombre del archivo es demasiado largo."),
  sizeBytes: z
    .number()
    .int()
    .positive("El archivo está vacío.")
    .max(PLAN_MAX_FILE_SIZE_BYTES, "El PDF supera el máximo de 50 MB."),
  contentType: z.literal(PLAN_CONTENT_TYPE, "Solo se aceptan archivos PDF."),
});

const finalizeSchema = z
  .object({
    planId: z.uuid("Plano inválido."),
    pageCount: z.number().int().positive(),
    hasVectorGeometry: z.boolean(),
    diagnosisJson: diagnosisInputSchema,
  })
  .refine(
    (value) => value.pageCount === value.diagnosisJson.pageCount,
    "El diagnóstico no coincide con la cantidad de páginas informada."
  );

/**
 * Paso 1: autoriza la subida y devuelve la URL firmada.
 *
 * El `storagePath` lo arma el servidor —nunca el cliente— y arranca con el
 * orgId: aunque un día se sumen políticas de Storage, la clave ya está
 * particionada por tenant.
 */
export async function requestPlanUpload(
  projectId: string,
  file: { filename: string; sizeBytes: number; contentType: string }
): Promise<RequestPlanUploadResult> {
  const profile = await requireProfile();

  const parsed = requestUploadSchema.safeParse({ projectId, ...file });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "El archivo no es válido." };
  }

  const db = getTenantPrisma(profile.organizationId);

  // Pertenencia: si el proyecto es de otra organización, la primitiva lo filtra
  // y esto devuelve null. Es el 404 del flujo, no un 403 que confirme que existe.
  const project = await db.project.findUnique({
    where: { id: parsed.data.projectId },
    select: { id: true },
  });

  if (!project) {
    return { ok: false, error: "El proyecto no existe." };
  }

  // El id se genera acá porque forma parte de la clave del objeto: la fila y el
  // archivo tienen que apuntarse desde el primer momento.
  const planId = randomUUID();
  const storagePath = `${profile.organizationId}/${project.id}/${planId}.pdf`;

  try {
    await db.plan.create({
      data: {
        id: planId,
        projectId: project.id,
        storagePath,
        originalFilename: parsed.data.filename,
        contentType: parsed.data.contentType,
        fileSizeBytes: parsed.data.sizeBytes,
        status: "PENDING",
      },
      select: { id: true },
    });
  } catch (error) {
    console.error("[plans] falló el alta del plano en PENDING:", error);

    return { ok: false, error: "No se pudo preparar la subida. Probá de nuevo." };
  }

  try {
    const { data, error } = await getSupabaseAdmin()
      .storage.from(PLANS_BUCKET)
      .createSignedUploadUrl(storagePath);

    if (error || !data) {
      throw error ?? new Error("createSignedUploadUrl no devolvió datos.");
    }

    return {
      ok: true,
      planId,
      path: data.path,
      token: data.token,
      signedUrl: data.signedUrl,
    };
  } catch (error) {
    // El mensaje del SDK puede traer detalle del proyecto: va al log, no al cliente.
    console.error("[plans] falló createSignedUploadUrl:", error);

    // Sin URL firmada no va a haber archivo nunca: la fila PENDING quedaría de
    // basura para siempre. Se limpia acá, y si la limpieza falla se deja anotado.
    try {
      await db.plan.delete({ where: { id: planId } });
    } catch (cleanupError) {
      console.error("[plans] quedó una fila PENDING huérfana:", planId, cleanupError);
    }

    return { ok: false, error: "No se pudo preparar la subida. Probá de nuevo." };
  }
}

/**
 * Paso 2: confirma que el objeto llegó y guarda el diagnóstico.
 *
 * Dos cosas importantes acá:
 *
 *  1. La existencia del archivo se verifica CONTRA STORAGE, no se le cree al
 *     cliente. Un plano en READY sin bytes atrás rompería el viewer más tarde y
 *     más lejos.
 *  2. El VEREDICTO vector/raster se recalcula server-side sobre los conteos que
 *     manda el cliente (`diagnosePlan`). Lo que se guarda es coherente con sus
 *     propios números por construcción; el `hasVectorGeometry` del cliente solo
 *     se usa para detectar drift entre las dos puntas.
 */
export async function finalizePlanUpload(
  planId: string,
  result: { pageCount: number; hasVectorGeometry: boolean; diagnosisJson: unknown }
): Promise<FinalizePlanUploadResult> {
  const profile = await requireProfile();

  const parsed = finalizeSchema.safeParse({ planId, ...result });

  if (!parsed.success) {
    console.error("[plans] diagnóstico inválido en finalizePlanUpload:", parsed.error.issues);

    return { ok: false, error: "El diagnóstico del PDF no es válido." };
  }

  const db = getTenantPrisma(profile.organizationId);

  const plan = await db.plan.findUnique({
    where: { id: parsed.data.planId },
    select: { id: true, storagePath: true },
  });

  if (!plan) {
    return { ok: false, error: "El plano no existe." };
  }

  try {
    const { data: info, error } = await getSupabaseAdmin()
      .storage.from(PLANS_BUCKET)
      .info(plan.storagePath);

    if (error || !info) {
      throw error ?? new Error("info() no devolvió datos.");
    }

    const size = info.size ?? 0;

    if (size <= 0 || size > PLAN_MAX_FILE_SIZE_BYTES) {
      console.error(`[plans] tamaño inesperado en Storage para ${plan.id}: ${size} bytes`);

      return { ok: false, error: "El archivo subido no es válido. Volvé a intentarlo." };
    }

    const diagnosis = diagnosePlan(parsed.data.diagnosisJson);

    if (diagnosis.hasVectorGeometry !== parsed.data.hasVectorGeometry) {
      // No es un error del usuario: es que cliente y servidor están aplicando
      // heurísticas distintas (deploy a medio camino, caché vieja del bundle).
      console.warn(
        `[plans] veredicto divergente para ${plan.id}: ` +
          `cliente=${parsed.data.hasVectorGeometry} servidor=${diagnosis.hasVectorGeometry}`
      );
    }

    await db.plan.update({
      where: { id: plan.id },
      data: {
        status: "READY",
        // El tamaño real lo dice Storage; el declarado al pedir la URL era una
        // promesa del cliente.
        fileSizeBytes: size,
        pageCount: diagnosis.pageCount,
        hasVectorGeometry: diagnosis.hasVectorGeometry,
        diagnosisJson: diagnosis,
      },
      select: { id: true },
    });

    return { ok: true };
  } catch (error) {
    console.error("[plans] falló la confirmación del upload:", error);

    return { ok: false, error: "No se pudo confirmar la subida. Probá de nuevo." };
  }
}

/**
 * ────────────────────────────────────────────────────────────────────────────
 * Calibración de escala.
 *
 * El cliente marca dos puntos sobre una cota conocida y tipea cuánto mide en la
 * realidad. Lo que llega son coordenadas en USER-SPACE del PDF —no píxeles— y
 * la cota con su unidad; el `scaleFactor` lo deriva ESTE lado con el motor
 * geométrico.
 *
 * Que el factor no venga del cliente es la decisión que sostiene todo lo demás:
 * un action es un POST alcanzable sin pasar por la UI, y un `scaleFactor`
 * declarado a mano se llevaría puestas todas las mediciones del plano sin que
 * nada quede raro a la vista.
 * ────────────────────────────────────────────────────────────────────────────
 */

export type CalibratePlanResult =
  | { ok: true; scaleFactor: number; pdfDistance: number }
  | { ok: false; error: string };

const calibrateSchema = z.object({
  planId: z.uuid("Plano inválido."),
  calibration: calibrationInputSchema,
});

export async function calibratePlan(
  planId: string,
  calibration: unknown
): Promise<CalibratePlanResult> {
  const profile = await requireProfile();

  const parsed = calibrateSchema.safeParse({ planId, calibration });

  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Los datos de la calibración no son válidos.",
    };
  }

  const { pageIndex, pdfPointA, pdfPointB, enteredValue, enteredUnit } = parsed.data.calibration;

  const db = getTenantPrisma(profile.organizationId);

  // Pertenencia: la primitiva inyecta el organizationId en el where, así que un
  // plano de otra organización no existe desde acá. No hace falta —ni conviene—
  // distinguir "no es tuyo" de "no existe".
  const plan = await db.plan.findUnique({
    where: { id: parsed.data.planId },
    select: { id: true, status: true, pageCount: true },
  });

  if (!plan) {
    return { ok: false, error: "El plano no existe." };
  }

  // Un plano PENDING no tiene bytes confirmados en Storage: calibrar contra algo
  // que todavía no está subido no significa nada.
  if (plan.status !== "READY") {
    return { ok: false, error: "El plano todavía se está subiendo." };
  }

  // El pageIndex viene del cliente, así que se valida contra el documento real.
  if (plan.pageCount !== null && pageIndex >= plan.pageCount) {
    return { ok: false, error: "Esa página no existe en el plano." };
  }

  try {
    // Las tres cuentas del TD, todas del motor puro y todas de este lado.
    const pdfDistance = distance(pdfPointA, pdfPointB);
    const realMeters = toMeters(enteredValue, enteredUnit);
    const scaleFactor = scaleFactorFromCalibration(pdfDistance, realMeters);

    const record: PlanCalibration = {
      version: CALIBRATION_VERSION,
      pageIndex,
      pdfPointA,
      pdfPointB,
      enteredValue,
      enteredUnit,
      pdfDistance,
      realMeters,
      calibratedAt: new Date().toISOString(),
    };

    // Recalibrar sobrescribe: hay un solo factor por plano (ver el límite
    // conocido de multi-escala en architecture.md), y el registro anterior
    // queda reemplazado por el nuevo, que es el que explica el factor vigente.
    await db.plan.update({
      where: { id: plan.id },
      data: { scaleFactor, calibrationJson: record },
      select: { id: true },
    });

    return { ok: true, scaleFactor, pdfDistance };
  } catch (error) {
    // Acá caen las guardas del motor (dos puntos en el mismo lugar, cota <= 0)
    // y cualquier fallo de la base. El detalle al log; al usuario, algo que
    // pueda accionar.
    console.error("[plans] falló la calibración:", error);

    return {
      ok: false,
      error: "No se pudo calibrar. Marcá dos puntos separados y revisá la medida.",
    };
  }
}
