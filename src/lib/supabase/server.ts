import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { getSupabaseEnv } from "@/lib/supabase/env";

/**
 * Cliente de Supabase para el servidor (Server Components, Server Actions,
 * Route Handlers).
 *
 * Se crea uno NUEVO por request: el cliente lleva la sesión adentro, así que
 * compartirlo entre requests sería filtrar la sesión de un usuario a otro.
 * Por eso es una función y no un singleton, al revés que el cliente de Prisma.
 */
export async function createSupabaseServerClient() {
  // `cookies()` va PRIMERO, antes de leer el env. Es lo que marca la ruta como
  // dinámica: si validáramos el env antes, `next build` intentaría prerenderizar
  // y explotaría por falta de vars en vez de bailar a render en request time.
  // Mismo criterio que la instanciación diferida del cliente de Prisma.
  const cookieStore = await cookies();
  const { url, anonKey } = getSupabaseEnv();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Durante el render de un Server Component las cookies son de solo
          // lectura (documentado en la API de `cookies()` de Next 16): escribir
          // ahí tira. Lo tragamos porque las escrituras que importan —login,
          // signup, logout— pasan por Server Actions, donde sí se puede.
        }
      },
    },
  });
}
