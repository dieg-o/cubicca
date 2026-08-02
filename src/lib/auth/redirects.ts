/**
 * Sanea un destino de redirección que vino del request (`?next=`, campo oculto
 * de un form).
 *
 * Solo se acepta una ruta interna: tiene que empezar con una sola `/`. Un
 * `//evil.com` es una URL protocol-relative y un `https://...` es absoluta —
 * cualquiera de las dos convertiría el login o el callback de auth en un open
 * redirect.
 *
 * Vive acá y no en `(auth)/actions.ts` porque lo usan los dos lados del flujo:
 * los server actions de login/signup y el route handler de `/auth/callback`.
 */
export function safeNextPath(value: FormDataEntryValue | string | null | undefined): string {
  const path = typeof value === "string" ? value : "";

  return path.startsWith("/") && !path.startsWith("//") ? path : "/";
}
