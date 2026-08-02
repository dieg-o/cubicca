import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";

import { safeNextPath } from "@/lib/auth/redirects";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * Confirmación de email por `token_hash` + `verifyOtp`.
 *
 * Es el reemplazo del flujo PKCE para el mail de alta. La diferencia que importa:
 * `exchangeCodeForSession()` necesita el *code verifier* que quedó en una cookie
 * al hacer el signUp, así que **solo funciona en el mismo browser**. Abrir el
 * mail en el teléfono, o en otro navegador, dejaba el canje sin verifier y la
 * confirmación fallaba. `verifyOtp()` no depende de ninguna cookie previa: el
 * `token_hash` del link se verifica solo, desde donde sea.
 *
 * ⚠️ El mail lo arma el template del dashboard de Supabase, no este código
 * (Authentication -> Email Templates):
 *
 *     {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email
 *
 * Por eso el ORDEN DE DEPLOY no es negociable: primero tiene que existir esta
 * ruta en producción, recién después se cambia el template. Al revés, los links
 * nuevos apuntan a una ruta que todavía no existe y dan 404.
 *
 * ⚠️ `/auth/callback` (PKCE) sigue vivo y no se toca: lo va a necesitar OAuth y
 * los magic links. Lo que se mudó acá es el mail de confirmación, nada más.
 *
 * ⚠️ Va FUERA del gate del proxy (`PUBLIC_PATHS` en `src/proxy.ts`): quien llega
 * acá todavía no tiene sesión, esa es la razón de existir de la ruta.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** Falla técnica: link sin parámetros, o `verifyOtp` que devolvió error crudo. */
const FAILURE_PATH = "/login?error=auth";

/**
 * Link vencido o ya usado — incluye el caso "ya confirmé y volví a clickear".
 * Es el desenlace esperado de un re-clic, no un error del sistema: se responde
 * con un mensaje amable en `/login`, nunca con un 500.
 */
const USED_PATH = "/login?error=used";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = request.nextUrl;
  const tokenHash = searchParams.get("token_hash");

  /*
   * El `type` se pasa TAL CUAL viene en la query, sin lista blanca. Es a
   * propósito: si Supabase rechaza `email` y hay que mandar `signup`, el ajuste
   * es editar el template del dashboard y nada más — sin tocar código ni
   * redeployar. `EmailOtpType` acepta cualquier string por diseño, y quien
   * valida de verdad es el servidor de auth.
   */
  const type = searchParams.get("type") as EmailOtpType | null;

  if (!tokenHash || !type) {
    console.error("[auth/confirm] llegó un request sin `token_hash` y/o sin `type`.");

    return NextResponse.redirect(new URL(FAILURE_PATH, origin));
  }

  const supabase = await createSupabaseServerClient();

  try {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });

    if (error) {
      // No se puede distinguir con certeza "ya usado" de "vencido": Supabase
      // devuelve el mismo error para los dos, a propósito (decirle a un
      // desconocido que un token existió es de más). Por eso el mensaje cubre
      // los dos casos y empuja a la acción útil, que es iniciar sesión.
      console.error("[auth/confirm] falló verifyOtp:", error.message);

      return NextResponse.redirect(new URL(USED_PATH, origin));
    }
  } catch (cause) {
    // `verifyOtp` devuelve los AuthError por `error`, pero relanza cualquier
    // otra cosa (red caída, respuesta ilegible). Mismo criterio que
    // `getSessionUser`: un fallo de auth nunca escala a 500.
    console.error("[auth/confirm] excepción inesperada al verificar el token:", cause);

    return NextResponse.redirect(new URL(FAILURE_PATH, origin));
  }

  /*
   * Sesión escrita. El destino por defecto es `/onboarding` y no `/`: quien
   * viene de confirmar el mail es, por definición, alguien que recién se dio de
   * alta y todavía no tiene organización. Si igual ya la tuviera, el gate real
   * de `/onboarding` lo reacomoda — este redirect es conveniencia, no frontera.
   */
  const next = searchParams.get("next");

  return NextResponse.redirect(new URL(next ? safeNextPath(next) : "/onboarding", origin));
}
