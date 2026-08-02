"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { safeNextPath } from "@/lib/auth/redirects";
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
 * A dónde tiene que volver el link del mail de confirmación.
 *
 * En PKCE el mail no trae una sesión sino un `code` que hay que canjear, y eso
 * solo puede pasar en `/auth/callback`. Sin este parámetro Supabase usa el Site
 * URL del dashboard —la raíz— y el code cae en una página que no sabe canjearlo.
 *
 * `NEXT_PUBLIC_SITE_URL` manda si está seteada: en prod el dominio es fijo y no
 * conviene que dependa de un header. Si no está, se usa el `Origin` del request,
 * que en un Server Action Next ya valida contra el Host. Como último recurso se
 * devuelve `undefined` y Supabase cae al Site URL: el proxy redirige `/?code=…`
 * al callback, así que el flujo sigue funcionando igual.
 */
async function getEmailRedirectTo(): Promise<string | undefined> {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  const origin = configured ? configured.replace(/\/+$/, "") : (await headers()).get("origin");

  if (!origin) {
    console.error("[signup] no se pudo resolver el origin: se manda el mail sin emailRedirectTo.");

    return undefined;
  }

  return `${origin}/auth/callback`;
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
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: await getEmailRedirectTo() },
  });

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
