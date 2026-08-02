"use client";

import Link from "next/link";
import { useActionState } from "react";

import type { AuthFormState } from "@/app/(auth)/actions";

type CredentialsFormProps = {
  action: (state: AuthFormState, formData: FormData) => Promise<AuthFormState>;
  title: string;
  submitLabel: string;
  /** A dónde volver después de loguearse; se manda como campo oculto. */
  next?: string;
  /** Mensaje ya presente al pintar el form (ej. el callback de auth falló). */
  initialState?: AuthFormState;
  footer: { question: string; linkLabel: string; href: string };
};

/**
 * El formulario de login y el de signup son el mismo: dos campos, un submit y
 * un mensaje de error. Cambia el server action que reciben por prop.
 */
export function CredentialsForm({
  action,
  title,
  submitLabel,
  next,
  initialState,
  footer,
}: CredentialsFormProps) {
  // El estado inicial lo pisa la primera respuesta del action, así que un
  // mensaje que venía de la URL no queda pegado después de intentar entrar.
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <div className="w-full max-w-sm space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>

      <form action={formAction} className="space-y-4">
        {next ? <input type="hidden" name="next" value={next} /> : null}

        <div className="space-y-2">
          <label htmlFor="email" className="text-sm font-medium">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="password" className="text-sm font-medium">
            Contraseña
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </div>

        {state?.error ? (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        ) : null}

        {state?.notice ? <p className="text-sm text-muted-foreground">{state.notice}</p> : null}

        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {pending ? "Un momento…" : submitLabel}
        </button>
      </form>

      <p className="text-sm text-muted-foreground">
        {footer.question}{" "}
        <Link href={footer.href} className="font-medium underline underline-offset-4">
          {footer.linkLabel}
        </Link>
      </p>
    </div>
  );
}
