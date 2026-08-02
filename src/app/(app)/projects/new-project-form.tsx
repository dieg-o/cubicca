"use client";

import { useActionState, useState } from "react";

import { createProject } from "@/app/(app)/projects/actions";

const DEFAULT_ESCANTILLON = 2.4;

/**
 * Alta de proyecto, plegada hasta que hace falta.
 *
 * En éxito el action redirige al detalle, así que el form no tiene caso "listo":
 * o vuelve con error, o la página cambió.
 */
export function NewProjectForm() {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(createProject, undefined);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="self-start rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
      >
        Nuevo proyecto
      </button>
    );
  }

  return (
    <form action={formAction} className="w-full max-w-md space-y-4 rounded-lg border p-4">
      <div className="space-y-2">
        <label htmlFor="name" className="text-sm font-medium">
          Nombre del proyecto
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          maxLength={80}
          autoFocus
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
      </div>

      <div className="space-y-2">
        <label htmlFor="escantillonDefault" className="text-sm font-medium">
          Escantillón por defecto (m)
        </label>
        <input
          id="escantillonDefault"
          name="escantillonDefault"
          type="number"
          step="0.05"
          min={1}
          max={20}
          required
          defaultValue={DEFAULT_ESCANTILLON}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        <p className="text-xs text-muted-foreground">
          Altura de muro que se usa para computar, salvo que un plano diga otra cosa.
        </p>
      </div>

      {state?.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {pending ? "Creando…" : "Crear proyecto"}
        </button>

        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={pending}
          className="text-sm text-muted-foreground underline underline-offset-4"
        >
          Cancelar
        </button>
      </div>
    </form>
  );
}
