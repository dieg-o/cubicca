import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { safeNextPath } from "@/lib/auth/redirects";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * Callback de auth: donde termina el link del mail de confirmación.
 *
 * `@supabase/ssr` crea los clientes con `flowType: "pkce"` (no es opcional, lo
 * fija la librería). En PKCE el mail no devuelve una sesión: devuelve un `code`
 * de un solo uso que hay que canjear contra el servidor de auth junto con el
 * *code verifier*, que quedó guardado en una cookie cuando se hizo el signUp.
 * Ese canje es `exchangeCodeForSession()` y solo puede pasar acá.
 *
 * ⚠️ Tiene que ser un Route Handler, no una página: el canje escribe las
 * cookies de sesión, y durante el render de un Server Component el store de
 * cookies es de solo lectura (mismo motivo por el que login y signup son server
 * actions). En un Route Handler `cookies().set()` sí funciona, así que el
 * `createSupabaseServerClient()` del proyecto sirve tal cual está.
 *
 * ⚠️ Va FUERA del gate del proxy (`PUBLIC_PATHS` en `src/proxy.ts`). Quien llega
 * acá todavía NO tiene sesión — esa es justamente la razón de existir de la
 * ruta. Si el proxy la mandara a `/login`, el code nunca se canjearía.
 *
 * No hace falta chequear profile: al terminar manda a `/`, y de ahí el gate real
 * (`requireProfile()`) deriva a `/onboarding` si todavía no hay organización.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** Mensaje único para el usuario: el detalle técnico va al log, no a la URL. */
const FAILURE_PATH = "/login?error=auth";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");

  // Supabase puede rebotar acá con un error en vez de un code: link vencido, ya
  // usado, o confirmación cancelada.
  const authError = searchParams.get("error_description") ?? searchParams.get("error");

  if (authError) {
    console.error("[auth/callback] Supabase devolvió un error en el callback:", authError);

    return NextResponse.redirect(new URL(FAILURE_PATH, origin));
  }

  if (!code) {
    console.error("[auth/callback] llegó un request sin `code` ni `error`.");

    return NextResponse.redirect(new URL(FAILURE_PATH, origin));
  }

  /*
   * `sb_flow_id` es de esta versión de auth-js: identifica CUÁL de los verifiers
   * pendientes usar cuando hay varios flujos abiertos a la vez. Solo llega si el
   * proyecto activa `experimental.appendPkceFlowIdToRedirects` (acá no está
   * activado), y en el servidor no se puede leer solo de `window.location`, así
   * que hay que pasarlo a mano. Sin flow id se usa el verifier más reciente, que
   * es el comportamiento clásico.
   */
  const flowId = searchParams.get("sb_flow_id");

  const supabase = await createSupabaseServerClient();

  try {
    const { error } = await supabase.auth.exchangeCodeForSession(
      code,
      flowId ? { flowId } : undefined
    );

    if (error) {
      // El caso más común no es un ataque: el usuario abrió el mail en otro
      // browser o dispositivo, así que la cookie con el code verifier no está
      // y el canje no puede completarse.
      console.error("[auth/callback] falló exchangeCodeForSession:", error.message);

      return NextResponse.redirect(new URL(FAILURE_PATH, origin));
    }
  } catch (cause) {
    // `exchangeCodeForSession` devuelve los AuthError por `error`, pero cualquier
    // otra cosa (red caída, respuesta ilegible) sí se propaga como excepción.
    console.error("[auth/callback] excepción inesperada al canjear el code:", cause);

    return NextResponse.redirect(new URL(FAILURE_PATH, origin));
  }

  // A esta altura las cookies de sesión ya quedaron escritas en la respuesta.
  return NextResponse.redirect(new URL(safeNextPath(searchParams.get("next")), origin));
}
