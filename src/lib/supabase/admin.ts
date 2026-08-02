import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * Cliente de Supabase con la service_role key. BYPASSEA RLS Y TODA POLÍTICA.
 *
 * `import "server-only"` arriba de todo no es decorativo: si algún día un
 * client component importa este módulo (directo o por una cadena de imports),
 * el build FALLA en vez de mandar la llave al browser.
 *
 * Reglas, todas innegociables:
 *   - `SUPABASE_SERVICE_ROLE_KEY` NUNCA lleva el prefijo NEXT_PUBLIC_ (esas se
 *     inlinean en el bundle del cliente en build time).
 *   - La llave no se loguea, no se devuelve desde un server action, no viaja en
 *     una respuesta. Lo único que sale de acá son URLs firmadas de corta vida.
 *   - Toda operación de Storage se mintea SOLO después de haber validado la
 *     pertenencia de la fila vía getTenantPrisma(orgId). Este cliente no sabe
 *     nada de tenants: el aislamiento lo pone la app, no Storage.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** Bucket privado de los PDFs de planos. MIME application/pdf, tope 50 MB. */
export const PLANS_BUCKET = "plans";

let client: SupabaseClient | null = null;

/**
 * El cliente admin, instanciado a demanda.
 *
 * Diferido igual que el cliente de Prisma: leer el env en el tope del módulo
 * haría explotar `next build` en cualquier ruta que importe esto, aunque no
 * llegue a ejecutarse.
 */
export function getSupabaseAdmin(): SupabaseClient {
  if (client) {
    return client;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    // El mensaje nombra la variable, nunca su valor.
    throw new Error(
      "Faltan NEXT_PUBLIC_SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY. " +
        "La service_role va solo server-side (ver .env.example)."
    );
  }

  client = createClient(url, serviceRoleKey, {
    auth: {
      // No hay usuario detrás de este cliente: es una llave de servicio. Sin
      // sesión que persistir ni token que refrescar.
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return client;
}
