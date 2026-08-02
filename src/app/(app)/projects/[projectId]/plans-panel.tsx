"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  finalizePlanUpload,
  requestPlanUpload,
} from "@/app/(app)/projects/[projectId]/actions";
import { PdfViewer, type PdfSource } from "@/app/(app)/projects/[projectId]/pdf-viewer";
import { loadPdfjs } from "@/lib/pdf/pdfjs";
import {
  formatFileSize,
  PLAN_CONTENT_TYPE,
  PLAN_MAX_FILE_SIZE_BYTES,
} from "@/lib/plans/constants";
import { diagnoseDocument } from "@/lib/plans/diagnose";
import { diagnosePlan, type PageDiagnosis } from "@/lib/plans/diagnosis";
import type { PlanSummary } from "@/lib/plans/view";
import { uploadToSignedUrl } from "@/lib/plans/upload";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * Planos de un proyecto: subida, diagnóstico y viewer.
 *
 * Es un client component porque el archivo nunca toca el servidor: el browser
 * lo sube a Storage con una URL firmada y lo abre con pdf.js sin volver a
 * bajarlo. La lista viene renderizada del server (`plans`), y después de cada
 * subida se refresca con `router.refresh()`.
 * ────────────────────────────────────────────────────────────────────────────
 */

type UploadPhase = "idle" | "requesting" | "uploading" | "diagnosing" | "finalizing";

const PHASE_LABEL: Record<Exclude<UploadPhase, "idle">, string> = {
  requesting: "Preparando la subida…",
  uploading: "Subiendo el PDF…",
  diagnosing: "Analizando el PDF…",
  finalizing: "Guardando el diagnóstico…",
};

/** Lo que el viewer está mostrando. Se guarda entero para no recrear el objeto
 * `source` en cada render: el viewer reabre el documento si cambia. */
type ActivePlan = { planId: string; source: PdfSource };

export function PlansPanel({ projectId, plans }: { projectId: string; plans: PlanSummary[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<ActivePlan | null>(null);

  // Si el usuario navega en medio de una subida, cortamos el PUT: seguir
  // subiendo 40 MB para una pantalla que ya no existe no le sirve a nadie.
  useEffect(() => () => abortRef.current?.abort(), []);

  async function handleFile(file: File) {
    setError(null);
    setProgress(0);

    // Validación de cortesía: la que manda es la del server action (y la del
    // bucket). Sirve para no gastar un round-trip en un .dwg arrastrado de más.
    if (file.type !== PLAN_CONTENT_TYPE) {
      setError("El plano tiene que ser un PDF.");

      return;
    }

    if (file.size > PLAN_MAX_FILE_SIZE_BYTES) {
      setError(`El PDF supera el máximo de ${formatFileSize(PLAN_MAX_FILE_SIZE_BYTES)}.`);

      return;
    }

    const controller = new AbortController();

    abortRef.current = controller;

    try {
      setPhase("requesting");

      const authorization = await requestPlanUpload(projectId, {
        filename: file.name,
        sizeBytes: file.size,
        contentType: file.type,
      });

      if (!authorization.ok) {
        setError(authorization.error);

        return;
      }

      setPhase("uploading");

      await uploadToSignedUrl({
        signedUrl: authorization.signedUrl,
        file,
        contentType: PLAN_CONTENT_TYPE,
        onProgress: setProgress,
        signal: controller.signal,
      });

      setPhase("diagnosing");

      const diagnosis = await diagnoseFile(file);

      setPhase("finalizing");

      const finalized = await finalizePlanUpload(authorization.planId, {
        pageCount: diagnosis.pageCount,
        hasVectorGeometry: diagnosePlan(diagnosis).hasVectorGeometry,
        diagnosisJson: diagnosis,
      });

      if (!finalized.ok) {
        setError(finalized.error);

        return;
      }

      // El File sigue en memoria: el viewer lo abre sin volver a bajarlo.
      setActive({ planId: authorization.planId, source: { kind: "file", file } });
      router.refresh();
    } catch (cause) {
      console.error("[plans] falló la subida del plano:", cause);
      setError("No se pudo subir el plano. Probá de nuevo.");
    } finally {
      setPhase("idle");
      abortRef.current = null;

      // Sin esto, volver a elegir el mismo archivo no dispara `change`.
      if (inputRef.current) {
        inputRef.current.value = "";
      }
    }
  }

  const busy = phase !== "idle";

  return (
    <div className="flex flex-col gap-6">
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Planos</h2>

        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed p-4">
          <input
            ref={inputRef}
            id="plan-file"
            type="file"
            accept="application/pdf,.pdf"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];

              if (file) {
                void handleFile(file);
              }
            }}
            className="text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1.5 file:text-sm"
          />

          <span className="text-xs text-muted-foreground">
            PDF, hasta {formatFileSize(PLAN_MAX_FILE_SIZE_BYTES)}. Va directo a Storage: no pasa
            por el servidor.
          </span>
        </div>

        {busy ? (
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">{PHASE_LABEL[phase]}</p>

            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={phase === "uploading" ? Math.round(progress * 100) : undefined}
              className="h-2 w-full max-w-md overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full bg-primary transition-[width] duration-200"
                style={{ width: phase === "uploading" ? `${progress * 100}%` : "100%" }}
              />
            </div>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </section>

      {plans.length === 0 ? (
        <p className="text-sm text-muted-foreground">Todavía no hay planos en este proyecto.</p>
      ) : (
        <ul className="space-y-3">
          {plans.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              isActive={active?.planId === plan.id}
              onOpen={() =>
                setActive({ planId: plan.id, source: { kind: "plan", planId: plan.id } })
              }
            />
          ))}
        </ul>
      )}

      {active ? (
        // key: cambiar de plano tiene que reabrir el documento desde cero, no
        // reusar el estado (página, zoom) del anterior.
        <PdfViewer key={active.planId} source={active.source} />
      ) : null}
    </div>
  );
}

/** Abre el File con pdf.js y cuenta operadores. Los bytes no salen del browser. */
async function diagnoseFile(file: File) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });

  try {
    const pdf = await task.promise;

    return await diagnoseDocument(pdf, pdfjs.OPS, `pdfjs-dist@${pdfjs.version}`);
  } finally {
    // Cierra el worker aunque el diagnóstico haya fallado.
    await task.destroy();
  }
}

function PlanCard({
  plan,
  isActive,
  onOpen,
}: {
  plan: PlanSummary;
  isActive: boolean;
  onOpen: () => void;
}) {
  const [showBreakdown, setShowBreakdown] = useState(false);

  return (
    <li className={`rounded-lg border p-4 ${isActive ? "border-primary" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="truncate text-sm font-medium">{plan.originalFilename}</p>

          <p className="text-xs text-muted-foreground">
            {formatFileSize(plan.fileSizeBytes)}
            {plan.pageCount === null
              ? null
              : ` · ${plan.pageCount === 1 ? "1 página" : `${plan.pageCount} páginas`}`}
            {" · "}
            {new Date(plan.createdAt).toLocaleDateString("es-AR")}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <PlanBadge plan={plan} />

          {plan.status === "READY" ? (
            <button
              type="button"
              onClick={onOpen}
              className="rounded-md border px-2 py-1 text-sm"
              aria-pressed={isActive}
            >
              {isActive ? "Viendo" : "Ver"}
            </button>
          ) : null}
        </div>
      </div>

      {plan.diagnosis ? (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowBreakdown((current) => !current)}
            className="text-xs text-muted-foreground underline underline-offset-4"
          >
            {showBreakdown ? "Ocultar desglose" : "Ver desglose por página"}
          </button>

          {showBreakdown ? (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[34rem] text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-3 font-medium">Página</th>
                    <th className="py-1 pr-3 font-medium">Segmentos</th>
                    <th className="py-1 pr-3 font-medium">Pintados</th>
                    <th className="py-1 pr-3 font-medium">Imágenes</th>
                    <th className="py-1 pr-3 font-medium">Texto</th>
                    <th className="py-1 pr-3 font-medium">Cobertura img.</th>
                    <th className="py-1 font-medium">Veredicto</th>
                  </tr>
                </thead>

                <tbody className="tabular-nums">
                  {plan.diagnosis.pages.map((page) => (
                    <PageRow key={page.page} page={page} />
                  ))}
                </tbody>
              </table>

              {plan.diagnosis.analyzedPageCount < plan.diagnosis.pageCount ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Se analizaron las primeras {plan.diagnosis.analyzedPageCount} páginas de{" "}
                  {plan.diagnosis.pageCount}.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

const REASON_LABEL: Record<PageDiagnosis["reason"], string> = {
  vector: "vectorial",
  "sin-geometria": "sin geometría",
  "imagen-dominante": "imagen a página completa",
};

function PageRow({ page }: { page: PageDiagnosis }) {
  return (
    <tr className="border-t">
      <td className="py-1 pr-3">{page.page}</td>
      <td className="py-1 pr-3">{page.vectorSegments}</td>
      <td className="py-1 pr-3">{page.paintOps}</td>
      <td className="py-1 pr-3">{page.imageOps}</td>
      <td className="py-1 pr-3">{page.textOps}</td>
      <td className="py-1 pr-3">{Math.round(page.maxImageCoverage * 100)}%</td>
      <td className="py-1">
        {page.isVector ? "✅ vectorial" : `⚠️ raster (${REASON_LABEL[page.reason]})`}
      </td>
    </tr>
  );
}

function PlanBadge({ plan }: { plan: PlanSummary }) {
  if (plan.status !== "READY") {
    return (
      <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
        Subiendo…
      </span>
    );
  }

  if (plan.hasVectorGeometry === null) {
    return (
      <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
        Sin diagnóstico
      </span>
    );
  }

  return plan.hasVectorGeometry ? (
    <span className="rounded-full border border-emerald-600/40 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-400">
      Vectorial ✅
    </span>
  ) : (
    <span className="rounded-full border border-amber-600/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
      Raster ⚠️
    </span>
  );
}
