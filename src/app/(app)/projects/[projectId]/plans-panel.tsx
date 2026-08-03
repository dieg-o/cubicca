"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  calibratePlan,
  createMeasurement,
  finalizePlanUpload,
  requestPlanUpload,
} from "@/app/(app)/projects/[projectId]/actions";
import { MeasurementList } from "@/app/(app)/projects/[projectId]/measurement-list";
import {
  PdfViewer,
  type PdfOverlayShape,
  type PdfSource,
} from "@/app/(app)/projects/[projectId]/pdf-viewer";
import {
  distance,
  LENGTH_UNITS,
  scaleFactorFromCalibration,
  toMeters,
  type LengthUnit,
  type Point,
} from "@/lib/geometry";
import { loadPdfjs } from "@/lib/pdf/pdfjs";
import { paperScaleDenominator } from "@/lib/plans/calibration";
import {
  formatFileSize,
  PLAN_CONTENT_TYPE,
  PLAN_MAX_FILE_SIZE_BYTES,
} from "@/lib/plans/constants";
import { diagnoseDocument } from "@/lib/plans/diagnose";
import { diagnosePlan, type PageDiagnosis } from "@/lib/plans/diagnosis";
import {
  computeMeasurementValue,
  formatMeasurement,
  MEASUREMENT_META,
  MEASUREMENT_TYPES,
  type MeasurementType,
} from "@/lib/plans/measurement";
import type { MeasurementSummary, PlanSummary } from "@/lib/plans/view";
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

/**
 * Lo que se está dibujando sobre el plano, si hay algo.
 *
 * Calibración y medición comparten el mismo mecanismo de captura de puntos y no
 * pueden estar activas a la vez: una sola variable evita el estado imposible de
 * dos herramientas peleándose los clicks.
 *
 * `finished` marca una medición ya cerrada (Enter o doble click): los puntos no
 * cambian más y se está completando el formulario.
 */
type Draft =
  | { kind: "calibration"; pageIndex: number; points: Point[] }
  | {
      kind: "measurement";
      type: MeasurementType;
      pageIndex: number;
      points: Point[];
      finished: boolean;
    };

/** Dos clicks en el mismo píxel dan el mismo punto: no es un vértice nuevo. */
const DUPLICATE_POINT_EPSILON = 1e-9;

export function PlansPanel({
  projectId,
  escantillonDefault,
  plans,
  measurements,
}: {
  projectId: string;
  escantillonDefault: number;
  plans: PlanSummary[];
  measurements: MeasurementSummary[];
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<ActivePlan | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pageIndex, setPageIndex] = useState(0);

  const activePlan = active ? (plans.find((plan) => plan.id === active.planId) ?? null) : null;
  const planMeasurements = activePlan
    ? measurements.filter((measurement) => measurement.planId === activePlan.id)
    : [];

  /**
   * Un click sobre la página suma un vértice.
   *
   * La calibración topea en dos puntos y el tercero reinicia: si el usuario
   * vuelve a clickear después de marcar los dos extremos, casi siempre es
   * porque se equivocó. Una medición, en cambio, suma vértices hasta que la
   * cierra a propósito.
   */
  function handlePickPoint(point: Point, pointPageIndex: number) {
    setDraft((current) => {
      if (!current) {
        return current;
      }

      if (current.kind === "calibration") {
        // Puntos de páginas distintas no forman una cota: la marca vieja se cae.
        if (current.pageIndex !== pointPageIndex || current.points.length >= 2) {
          return { kind: "calibration", pageIndex: pointPageIndex, points: [point] };
        }

        return { ...current, points: [...current.points, point] };
      }

      // Una medición vive en la página donde empezó (que es la calibrada), y
      // una vez cerrada no acepta más vértices.
      if (current.finished || current.pageIndex !== pointPageIndex) {
        return current;
      }

      const last = current.points[current.points.length - 1];

      // El doble click que cierra la figura dispara dos `click` en el mismo
      // píxel: el segundo no es un vértice, es el mismo.
      if (last && Math.abs(last.x - point.x) < DUPLICATE_POINT_EPSILON &&
        Math.abs(last.y - point.y) < DUPLICATE_POINT_EPSILON) {
        return current;
      }

      return { ...current, points: [...current.points, point] };
    });
  }

  /** Cierra la figura en curso si ya tiene vértices suficientes. */
  function finishDraft() {
    setDraft((current) => {
      if (!current || current.kind !== "measurement" || current.finished) {
        return current;
      }

      return current.points.length >= MEASUREMENT_META[current.type].minPoints
        ? { ...current, finished: true }
        : current;
    });
  }

  // Si el usuario navega en medio de una subida, cortamos el PUT: seguir
  // subiendo 40 MB para una pantalla que ya no existe no le sirve a nadie.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Enter cierra la figura, Esc la cancela. Va en `window` y no en el canvas
  // porque el canvas no tiene foco: el usuario viene de clickear sobre él, no
  // de tabular hasta él.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Enter dentro del input del alto o de la etiqueta es del formulario.
      const target = event.target;

      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      if (event.key === "Enter") {
        finishDraft();
      }

      if (event.key === "Escape") {
        setDraft(null);
      }
    }

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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

      {active && activePlan ? (
        <>
          <CalibrationBox
            plan={activePlan}
            draft={draft?.kind === "calibration" ? draft : null}
            onStart={() => setDraft({ kind: "calibration", pageIndex, points: [] })}
            onCancel={() => setDraft(null)}
            onSaved={() => {
              setDraft(null);
              router.refresh();
            }}
          />

          <MeasureBox
            plan={activePlan}
            pageIndex={pageIndex}
            escantillonDefault={escantillonDefault}
            draft={draft?.kind === "measurement" ? draft : null}
            onStart={(type) =>
              setDraft({ kind: "measurement", type, pageIndex, points: [], finished: false })
            }
            onFinish={finishDraft}
            onCancel={() => setDraft(null)}
            onCalibrate={() => setDraft({ kind: "calibration", pageIndex, points: [] })}
            onSaved={() => {
              setDraft(null);
              router.refresh();
            }}
          />

          {/* key: cambiar de plano tiene que reabrir el documento desde cero,
              no reusar el estado (página, zoom) del anterior. */}
          <PdfViewer
            key={active.planId}
            source={active.source}
            pickingPoints={draft !== null}
            overlays={buildOverlays(draft, planMeasurements)}
            onPickPoint={handlePickPoint}
            onFinishShape={finishDraft}
            onPageChange={setPageIndex}
          />

          <MeasurementList
            measurements={planMeasurements}
            onChanged={() => router.refresh()}
          />
        </>
      ) : null}
    </div>
  );
}

/**
 * Lo que se dibuja encima del plano: las mediciones ya guardadas (en azul) y lo
 * que se está marcando ahora (en rojo).
 */
function buildOverlays(
  draft: Draft | null,
  measurements: readonly MeasurementSummary[]
): PdfOverlayShape[] {
  const shapes: PdfOverlayShape[] = [];

  for (const measurement of measurements) {
    // Sin geometría legible no hay nada que dibujar; la medición igual se lista.
    if (!measurement.points) {
      continue;
    }

    shapes.push({
      id: measurement.id,
      pageIndex: measurement.pageIndex,
      points: measurement.points,
      closed: MEASUREMENT_META[measurement.type].closed,
      tone: "saved",
      label: formatMeasurement(measurement.computedValue, measurement.type),
    });
  }

  if (draft) {
    shapes.push({
      id: "draft",
      pageIndex: draft.pageIndex,
      points: draft.points,
      // El polígono se muestra cerrado recién cuando el usuario lo cerró: antes
      // sería mostrarle un lado que todavía no dibujó.
      closed: draft.kind === "measurement" && draft.type === "AREA" && draft.finished,
      tone: "draft",
    });
  }

  return shapes;
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

/**
 * ────────────────────────────────────────────────────────────────────────────
 * Calibración de escala del plano a la vista.
 *
 * El usuario marca los dos extremos de una cota que ya conoce (una pared
 * acotada, la línea de escala gráfica) y tipea cuánto mide de verdad. Lo que se
 * manda son los dos puntos en user-space y la cota con su unidad: el
 * `scaleFactor` lo deriva el servidor.
 *
 * El número que se muestra acá antes de guardar es una previsualización con las
 * mismas funciones puras del motor — sirve para pescar un dedazo antes de
 * persistir, pero el que queda guardado es el que calcula el server.
 * ────────────────────────────────────────────────────────────────────────────
 */
function CalibrationBox({
  plan,
  draft,
  onStart,
  onCancel,
  onSaved,
}: {
  plan: PlanSummary | null;
  draft: Extract<Draft, { kind: "calibration" }> | null;
  onStart: () => void;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState<LengthUnit>("m");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!plan) {
    return null;
  }

  const points = draft?.points ?? [];
  const pdfDistance = points.length === 2 ? distance(points[0], points[1]) : null;
  // Coma o punto: en es-AR se tipean las dos.
  const enteredValue = Number.parseFloat(value.replace(",", "."));
  // Las mismas funciones del motor que va a usar el server, con las guardas ya
  // satisfechas por el `if` — así la previsualización no puede tirar.
  const previewFactor =
    pdfDistance !== null && pdfDistance > 0 && Number.isFinite(enteredValue) && enteredValue > 0
      ? scaleFactorFromCalibration(pdfDistance, toMeters(enteredValue, unit))
      : null;

  async function save() {
    if (!plan || !draft || draft.points.length !== 2) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const result = await calibratePlan(plan.id, {
        pageIndex: draft.pageIndex,
        pdfPointA: draft.points[0],
        pdfPointB: draft.points[1],
        enteredValue,
        enteredUnit: unit,
      });

      if (!result.ok) {
        setError(result.error);

        return;
      }

      setValue("");
      onSaved();
    } catch (cause) {
      console.error("[plans] falló la calibración:", cause);
      setError("No se pudo calibrar. Probá de nuevo.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Escala</h3>
          <ScaleSummary plan={plan} />
        </div>

        {draft === null ? (
          <button type="button" onClick={onStart} className="rounded-md border px-3 py-1.5 text-sm">
            {plan.scaleFactor === null ? "Calibrar escala" : "Recalibrar"}
          </button>
        ) : (
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="text-sm text-muted-foreground underline underline-offset-4"
          >
            Cancelar
          </button>
        )}
      </div>

      {draft !== null ? (
        <div className="space-y-3 border-t pt-3">
          <p className="text-sm text-muted-foreground">
            {points.length === 0
              ? "Clickeá el primer extremo de una cota conocida sobre el plano."
              : points.length === 1
                ? "Ahora clickeá el otro extremo."
                : `Cota marcada en la página ${draft.pageIndex + 1}: ${pdfDistance?.toFixed(2)} unidades del PDF. Un click más vuelve a empezar.`}
          </p>

          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label htmlFor="calibration-value" className="text-xs font-medium">
                ¿Cuánto mide en la realidad?
              </label>
              <input
                id="calibration-value"
                type="number"
                inputMode="decimal"
                step="any"
                min={0}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                disabled={saving}
                className="w-32 rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="calibration-unit" className="text-xs font-medium">
                Unidad
              </label>
              <select
                id="calibration-unit"
                value={unit}
                onChange={(event) => setUnit(toLengthUnit(event.target.value))}
                disabled={saving}
                className="rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {LENGTH_UNITS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || points.length !== 2 || previewFactor === null}
              className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {saving ? "Guardando…" : "Guardar calibración"}
            </button>
          </div>

          {previewFactor !== null ? (
            <p className="text-xs text-muted-foreground">
              Quedaría en {formatScaleFactor(previewFactor)}.
            </p>
          ) : null}

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * ────────────────────────────────────────────────────────────────────────────
 * Las tres herramientas de medición.
 *
 * Dos condiciones para poder medir, y las dos son duras:
 *  1. El plano tiene que estar CALIBRADO. Sin `scaleFactor` no hay metros, hay
 *     unidades de PDF disfrazadas de metros.
 *  2. Hay que estar parado en la PÁGINA CALIBRADA. Un factor derivado de la
 *     planta no dice nada de un detalle dibujado en otra hoja a otra escala:
 *     medir ahí daría un número creíble y equivocado.
 *
 * El valor que se ve mientras se dibuja es preview: se calcula con la misma
 * función pura que va a usar el servidor, pero el que se guarda es el que
 * recomputa el servidor.
 * ────────────────────────────────────────────────────────────────────────────
 */
function MeasureBox({
  plan,
  pageIndex,
  escantillonDefault,
  draft,
  onStart,
  onFinish,
  onCancel,
  onCalibrate,
  onSaved,
}: {
  plan: PlanSummary;
  pageIndex: number;
  escantillonDefault: number;
  draft: Extract<Draft, { kind: "measurement" }> | null;
  onStart: (type: MeasurementType) => void;
  onFinish: () => void;
  onCancel: () => void;
  onCalibrate: () => void;
  onSaved: () => void;
}) {
  const [alto, setAlto] = useState(String(escantillonDefault));
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Gate 1: sin calibrar no se mide ──────────────────────────────────────
  if (plan.scaleFactor === null) {
    return (
      <section className="space-y-2 rounded-lg border border-dashed p-4">
        <h3 className="text-sm font-medium">Mediciones</h3>

        <p className="text-sm text-muted-foreground">
          Este plano todavía no está calibrado: sin escala no hay metros que calcular.
        </p>

        <button
          type="button"
          onClick={onCalibrate}
          className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
        >
          Calibrá primero
        </button>
      </section>
    );
  }

  const scaleFactor = plan.scaleFactor;
  const calibratedPage = plan.calibration?.pageIndex ?? null;
  // Sin calibración legible no se sabe sobre qué página vale el factor: no se
  // mide, y el mensaje empuja a recalibrar (que es lo que lo arregla).
  const wrongPage = calibratedPage === null || calibratedPage !== pageIndex;

  const parsedAlto = Number.parseFloat(alto.replace(",", "."));
  const altoForType =
    draft?.type === "MURO" ? (Number.isFinite(parsedAlto) ? parsedAlto : null) : null;
  const previewValue = draft ? previewMeasurement(draft, scaleFactor, altoForType) : null;
  const canSave =
    draft !== null && draft.finished && previewValue !== null && previewValue > 0 && !saving;

  async function save() {
    if (!draft || previewValue === null) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const result = await createMeasurement(plan.id, {
        type: draft.type,
        pageIndex: draft.pageIndex,
        points: draft.points,
        alto: draft.type === "MURO" ? altoForType : null,
        label: label.trim().length > 0 ? label.trim() : null,
        previewValue,
      });

      if (!result.ok) {
        setError(result.error);

        return;
      }

      // La otra mitad del chequeo que hace el servidor: si el número que vio el
      // usuario no es el que se guardó, queda en la consola del browser además
      // del log del server.
      if (Math.abs(result.computedValue - previewValue) / result.computedValue > 1e-9) {
        console.warn(
          `[measurements] el valor guardado (${result.computedValue}) no coincide con el ` +
            `preview (${previewValue})`
        );
      }

      setLabel("");
      onSaved();
    } catch (cause) {
      console.error("[measurements] falló el guardado:", cause);
      setError("No se pudo guardar la medición. Probá de nuevo.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Mediciones</h3>

          <p className="text-xs text-muted-foreground">
            Escala: {formatScaleFactor(scaleFactor)}
            {calibratedPage !== null ? ` · calibrado sobre la página ${calibratedPage + 1}` : null}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {MEASUREMENT_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => onStart(type)}
              disabled={wrongPage || saving}
              aria-pressed={draft?.type === type}
              className={`rounded-md border px-3 py-1.5 text-sm disabled:opacity-40 ${
                draft?.type === type ? "border-primary bg-primary/10" : ""
              }`}
            >
              {MEASUREMENT_META[type].label}
            </button>
          ))}

          {draft ? (
            <button
              type="button"
              onClick={onCancel}
              disabled={saving}
              className="text-sm text-muted-foreground underline underline-offset-4"
            >
              Cancelar
            </button>
          ) : null}
        </div>
      </div>

      {wrongPage ? (
        <p className="text-sm text-amber-700 dark:text-amber-400">
          {calibratedPage === null
            ? "La calibración de este plano no se puede leer. Recalibralo para poder medir."
            : `Estás en la página ${pageIndex + 1} y el plano está calibrado sobre la ${calibratedPage + 1}. Andá a esa página para medir, o recalibrá sobre esta.`}
        </p>
      ) : null}

      {draft ? (
        <div className="space-y-3 border-t pt-3">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-muted-foreground">
              {draft.finished
                ? `${MEASUREMENT_META[draft.type].label} cerrada con ${draft.points.length} vértices.`
                : `Clickeá los vértices sobre el plano (${draft.points.length} marcados). Enter o doble click para cerrar, Esc para cancelar.`}
            </p>

            {previewValue !== null ? (
              <p className="text-sm font-medium tabular-nums">
                {draft.finished ? "" : "Va "}
                {formatMeasurement(previewValue, draft.type)}
              </p>
            ) : null}

            {!draft.finished &&
            draft.points.length >= MEASUREMENT_META[draft.type].minPoints ? (
              <button
                type="button"
                onClick={onFinish}
                className="rounded-md border px-2 py-1 text-sm"
              >
                Cerrar figura
              </button>
            ) : null}
          </div>

          {draft.finished ? (
            <div className="flex flex-wrap items-end gap-3">
              {draft.type === "MURO" ? (
                <div className="space-y-1">
                  <label htmlFor="measurement-alto" className="text-xs font-medium">
                    Alto del muro (m)
                  </label>
                  <input
                    id="measurement-alto"
                    type="number"
                    inputMode="decimal"
                    step="any"
                    min={0}
                    value={alto}
                    onChange={(event) => setAlto(event.target.value)}
                    disabled={saving}
                    className="w-28 rounded-md border border-input bg-background px-3 py-2 text-sm"
                  />
                </div>
              ) : null}

              <div className="space-y-1">
                <label htmlFor="measurement-label" className="text-xs font-medium">
                  Etiqueta (opcional)
                </label>
                <input
                  id="measurement-label"
                  type="text"
                  maxLength={120}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  disabled={saving}
                  placeholder="Muro norte, contrapiso living…"
                  className="w-64 rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </div>

              <button
                type="button"
                onClick={() => void save()}
                disabled={!canSave}
                className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {saving ? "Guardando…" : "Guardar medición"}
              </button>
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * El valor en vivo mientras se dibuja. Devuelve null cuando todavía no hay
 * geometría suficiente — el motor tira en ese caso, y acá no es un error: es
 * que el usuario marcó un vértice y va por el segundo.
 */
function previewMeasurement(
  draft: Extract<Draft, { kind: "measurement" }>,
  scaleFactor: number,
  alto: number | null
): number | null {
  if (draft.points.length < MEASUREMENT_META[draft.type].minPoints) {
    return null;
  }

  try {
    // Mientras se dibuja un muro todavía no se pidió el alto: se previsualiza
    // con el escantillón que ya está en el input.
    return computeMeasurementValue(draft.type, draft.points, scaleFactor, alto);
  } catch {
    // Geometría degenerada (todos los vértices encimados): no hay preview que
    // mostrar, y el guardado lo va a rechazar con su propio mensaje.
    return null;
  }
}

/** El `select` devuelve string; esto lo vuelve a meter en el tipo sin castear. */
function toLengthUnit(value: string): LengthUnit {
  return LENGTH_UNITS.find((unit) => unit === value) ?? "m";
}

/**
 * "1 unidad PDF = 0,0500 m · escala ≈ 1:142".
 *
 * La escala de arquitecto es una comodidad de lectura, no un dato del sistema:
 * sirve para cruzarla contra el cajetín del plano y darse cuenta al toque si se
 * marcó cualquier cosa.
 */
function formatScaleFactor(scaleFactor: number): string {
  const denominator = paperScaleDenominator(scaleFactor);

  return `1 unidad PDF = ${scaleFactor.toFixed(4)} m · escala ≈ 1:${Math.round(denominator)}`;
}

function ScaleSummary({ plan }: { plan: PlanSummary }) {
  if (plan.scaleFactor === null) {
    return (
      <p className="text-xs text-amber-700 dark:text-amber-400">
        Sin calibrar ⚠️ — todavía no se puede medir en metros.
      </p>
    );
  }

  return (
    <div className="space-y-0.5">
      <p className="text-xs text-emerald-700 dark:text-emerald-400">
        Calibrado ✅ — {formatScaleFactor(plan.scaleFactor)}
      </p>

      {plan.calibration ? (
        <p className="text-xs text-muted-foreground">
          Cota de referencia: {plan.calibration.enteredValue} {plan.calibration.enteredUnit} sobre
          la página {plan.calibration.pageIndex + 1} ({plan.calibration.pdfDistance.toFixed(2)}{" "}
          unidades del PDF).
        </p>
      ) : null}
    </div>
  );
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

          {plan.status === "READY" ? <ScaleBadge scaleFactor={plan.scaleFactor} /> : null}

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

/** El estado de calibración a la vista en la lista, sin abrir el plano. */
function ScaleBadge({ scaleFactor }: { scaleFactor: number | null }) {
  return scaleFactor === null ? (
    <span className="rounded-full border border-amber-600/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
      Sin calibrar ⚠️
    </span>
  ) : (
    <span className="rounded-full border border-emerald-600/40 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-400">
      Calibrado ✅ 1:{Math.round(paperScaleDenominator(scaleFactor))}
    </span>
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
