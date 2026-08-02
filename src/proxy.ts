import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * Proxy (lo que hasta Next 15 se llamaba middleware).
 *
 * Hace UNA sola cosa: mirar si hay cookie de sesión y redirigir. Sin queries a
 * la base, sin llamadas a Supabase, sin Prisma. Corre en CADA request —
 * incluidos los prefetch del router— así que cualquier I/O acá se paga en todas
 * las navegaciones.
 *
 * Es un chequeo OPTIMISTA: "hay una cookie con pinta de sesión". No valida la
 * firma del JWT ni si expiró, y no puede saber si el usuario tiene profile.
 * La verificación real vive en `requireSession()` / `requireProfile()`
 * (src/lib/auth/session.ts), que sí hablan con Supabase y con la base, y por
 * las que pasan todas las páginas y server actions.
 *
 * ⚠️ Los Server Actions son POST a la ruta donde se usan, no rutas aparte: si
 * el matcher deja afuera un path, también deja afuera sus actions. Por eso
 * ningún action confía en este archivo — cada uno valida por su cuenta.
 *
 * ⚠️ En Next 16 el proxy corre en Node por defecto y `export const runtime`
 * acá tira error. No agregarlo.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** Único lugar donde se puede canjear un `code` de PKCE por una sesión. */
const AUTH_CALLBACK_PATH = "/auth/callback";

/**
 * Rutas que se ven sin sesión. Todo lo demás requiere estar logueado.
 *
 * `/auth/callback` está acá por obligación, no por comodidad: es donde se canjea
 * el `code` del mail de confirmación por una sesión, así que por definición
 * llega SIN sesión. Mandarlo a `/login` dejaría el code sin canjear y el signup
 * nunca terminaría. Sigue dentro del matcher —el proxy corre— pero no se
 * redirige.
 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set(["/login", "/signup", AUTH_CALLBACK_PATH]);

/**
 * Nombre de la cookie de sesión de Supabase: `sb-<project-ref>-auth-token`,
 * donde el ref es la primera etiqueta del hostname del proyecto. Si el token no
 * entra en una cookie, la librería lo parte en `...-auth-token.0`, `.1`, etc.
 *
 * Se arma acá, sin importar `@supabase/ssr`, para que el proxy no cargue el SDK
 * entero por un chequeo de existencia de cookie.
 */
function getAuthCookiePrefix(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;

  if (!url) {
    throw new Error("Falta NEXT_PUBLIC_SUPABASE_URL: el proxy no puede ubicar la cookie de sesión.");
  }

  const projectRef = new URL(url).hostname.split(".")[0];

  return `sb-${projectRef}-auth-token`;
}

function hasSessionCookie(request: NextRequest): boolean {
  const prefix = getAuthCookiePrefix();

  return request.cookies
    .getAll()
    .some((cookie) => cookie.name === prefix || cookie.name.startsWith(`${prefix}.`));
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname, searchParams } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.has(pathname);
  const hasSession = hasSessionCookie(request);

  /*
   * Red de contención para el `code` huérfano: si el Site URL del dashboard de
   * Supabase apunta a la raíz —o si algún mail viejo sigue apuntando ahí— el
   * code aterriza en `/` en vez del callback. Sin sesión todavía, `/` no puede
   * hacer nada con él más que fallar, así que se lo pasamos al único lugar que
   * sabe canjearlo, con la query intacta.
   *
   * El `!hasSession` no es un detalle: con sesión, `/` renderiza bien y el code
   * sobrante se ignora; mandarlo igual al callback sería un rebote de más por un
   * code que casi seguro ya está usado.
   */
  if (!hasSession && pathname === "/" && searchParams.has("code")) {
    const callback = new URL(AUTH_CALLBACK_PATH, request.nextUrl);

    callback.search = request.nextUrl.search;

    return NextResponse.redirect(callback);
  }

  if (!hasSession && !isPublic) {
    const login = new URL("/login", request.nextUrl);

    // Para volver a donde iba después de loguearse. Se guarda solo el path
    // relativo: un `next` con host ajeno sería un open redirect.
    login.searchParams.set("next", `${pathname}${request.nextUrl.search}`);

    return NextResponse.redirect(login);
  }

  // A propósito NO se hace lo simétrico ("tiene cookie y está en /login -> a la
  // app"): la cookie puede estar presente pero vencida o inválida, y entonces
  // el proxy mandaría /login -> / mientras la verificación real de / manda
  // / -> /login. Loop infinito. Esa redirección vive en la propia página de
  // login, que sí puede preguntarle a Supabase si la sesión sirve.
  return NextResponse.next();
}

export const config = {
  /*
   * Todo menos los assets. Sin matcher el proxy correría también sobre
   * `_next/static`, imágenes y `public/`, y el redirect a /login rompería el
   * CSS y el JS de la propia pantalla de login.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
