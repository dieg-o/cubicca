"use client";

import { useState } from "react";

import {
  deleteMeasurement,
  updateMeasurementLabel,
} from "@/app/(app)/projects/[projectId]/actions";
import {
  formatMeasurement,
  MEASUREMENT_META,
  type MeasurementType,
} from "@/lib/plans/measurement";
import type { MeasurementSummary } from "@/lib/plans/view";

/**
 * Las mediciones guardadas del plano a la vista.
 *
 * Editar es crear + borrar + renombrar: mover vértices de una medición ya
 * guardada queda diferido. Es una limitación consciente — remarcar una figura
 * cuesta segundos y evita toda la complejidad de editar geometría.
 */
export function MeasurementList({
  measurements,
  onChanged,
}: {
  measurements: readonly MeasurementSummary[];
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (measurements.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Todavía no hay mediciones en este plano.
      </p>
    );
  }

  async function run(id: string, operation: () => Promise<{ ok: boolean; error?: string }>) {
    setBusyId(id);
    setError(null);

    try {
      const result = await operation();

      if (!result.ok) {
        setError(result.error ?? "No se pudo completar la operación.");

        return;
      }

      onChanged();
    } catch (cause) {
      console.error("[measurements] falló la operación sobre la medición:", cause);
      setError("No se pudo completar la operación. Probá de nuevo.");
    } finally {
      setBusyId(null);
    }
  }

  // Un total por tipo: sumar metros con metros cuadrados no significa nada, así
  // que se agrupa. Los totales por partida son TD-006.
  const totals = new Map<MeasurementType, number>();

  for (const measurement of measurements) {
    totals.set(
      measurement.type,
      (totals.get(measurement.type) ?? 0) + measurement.computedValue
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium">Mediciones ({measurements.length})</h3>

        <p className="text-xs text-muted-foreground">
          {[...totals.entries()]
            .map(([type, total]) => `${MEASUREMENT_META[type].label}: ${formatMeasurement(total, type)}`)
            .join(" · ")}
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <ul className="divide-y rounded-lg border">
        {measurements.map((measurement) => (
          <MeasurementRow
            key={measurement.id}
            measurement={measurement}
            busy={busyId === measurement.id}
            onRename={(label) =>
              run(measurement.id, () => updateMeasurementLabel(measurement.id, label))
            }
            onDelete={() => run(measurement.id, () => deleteMeasurement(measurement.id))}
          />
        ))}
      </ul>
    </section>
  );
}

function MeasurementRow({
  measurement,
  busy,
  onRename,
  onDelete,
}: {
  measurement: MeasurementSummary;
  busy: boolean;
  onRename: (label: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(measurement.label ?? "");

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0 space-y-0.5">
        {editing ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setEditing(false);
              onRename(label);
            }}
            className="flex items-center gap-2"
          >
            <input
              type="text"
              value={label}
              maxLength={120}
              autoFocus
              onChange={(event) => setLabel(event.target.value)}
              className="w-56 rounded-md border border-input bg-background px-2 py-1 text-sm"
            />

            <button type="submit" className="text-sm underline underline-offset-4">
              Guardar
            </button>

            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setLabel(measurement.label ?? "");
              }}
              className="text-sm text-muted-foreground underline underline-offset-4"
            >
              Cancelar
            </button>
          </form>
        ) : (
          <p className="truncate text-sm font-medium">
            {measurement.label ?? <span className="text-muted-foreground">Sin etiqueta</span>}
          </p>
        )}

        <p className="text-xs text-muted-foreground">
          {MEASUREMENT_META[measurement.type].label}
          {measurement.alto === null ? null : ` · alto ${measurement.alto} m`}
          {` · ${measurement.points?.length ?? 0} vértices`}
          {` · página ${measurement.pageIndex + 1}`}
        </p>
      </div>

      <div className="flex items-center gap-3">
        <span className="text-sm font-medium tabular-nums">
          {formatMeasurement(measurement.computedValue, measurement.type)}
        </span>

        {editing ? null : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={busy}
            className="text-sm underline underline-offset-4 disabled:opacity-40"
          >
            Renombrar
          </button>
        )}

        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="text-sm text-destructive underline underline-offset-4 disabled:opacity-40"
        >
          {busy ? "…" : "Borrar"}
        </button>
      </div>
    </li>
  );
}
