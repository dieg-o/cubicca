"use client";

import { useActionState } from "react";

import { createOrganization } from "@/app/onboarding/actions";

export function OnboardingForm() {
  const [state, formAction, pending] = useActionState(createOrganization, undefined);

  return (
    <form action={formAction} className="w-full max-w-sm space-y-4">
      <div className="space-y-2">
        <label htmlFor="name" className="text-sm font-medium">
          Nombre de la organización
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

      {state?.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {pending ? "Creando…" : "Crear organización"}
      </button>
    </form>
  );
}
