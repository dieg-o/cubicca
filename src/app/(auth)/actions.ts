"use server";

import { redirect } from "next/navigation";

import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Server Actions de autenticación.
 *
 * Van acá y no en el cliente porque las cookies de sesión solo se pueden
 * escribir del lado del servidor: en un Server Component el store de cookies es
 * de solo lectura, y desde el browser serían manipulables.
 */

export type AuthFormState = { error?: string; notice?: string } | undefined;

const MIN_PASSWORD_LENGTH = 8;

/**
 * Sanea el `next` del login.
 *
 * Solo se acepta una ruta interna: tiene que empezar con una sola `/`. Un
 * `//evil.com` es una URL protocol-relative y un `https://...` es absoluta —
 * cualquiera de las dos convertiría el login en un open redirect.
 */
function safeNextPath(value: FormDataEntryValue | null): string {
  const path = typeof value === "string" ? value : "";

  return path.startsWith("/") && !path.startsWith("//") ? path : "/";
}

function readCredentials(formData: FormData): {
  email: string;
  password: string;
  error?: string;
} {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { email, password, error: "Completá email y contraseña." };
  }

  return { email, password };
}

export async function login(_state: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const { email, password, error: invalid } = readCredentials(formData);

  if (invalid) {
    return { error: invalid };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    // Mensaje genérico a propósito: distinguir "no existe" de "contraseña
    // incorrecta" le regala al atacante un enumerador de cuentas.
    console.error("[login] falló signInWithPassword:", error.message);

    return { error: "Email o contraseña incorrectos." };
  }

  // Fuera del try: redirect() corta el flujo tirando una excepción de control,
  // así que atraparla la rompería.
  redirect(safeNextPath(formData.get("next")));
}

export async function signup(_state: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const { email, password, error: invalid } = readCredentials(formData);

  if (invalid) {
    return { error: invalid };
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    return { error: `La contraseña tiene que tener al menos ${MIN_PASSWORD_LENGTH} caracteres.` };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp({ email, password });

  if (error) {
    console.error("[signup] falló signUp:", error.message);

    return { error: "No se pudo crear la cuenta. Probá de nuevo." };
  }

  // Si el proyecto tiene confirmación de email activada, signUp no abre sesión:
  // devuelve user sin session. No hay a dónde redirigir todavía.
  if (!data.session) {
    return { notice: "Te mandamos un mail para confirmar la cuenta." };
  }

  redirect("/onboarding");
}

export async function logout(): Promise<void> {
  const supabase = await createSupabaseServerClient();

  await supabase.auth.signOut();

  redirect("/login");
}
