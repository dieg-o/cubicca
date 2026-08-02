/**
 * Las dos vars de Supabase que la app necesita, leídas en un solo lugar.
 *
 * Son `NEXT_PUBLIC_` a propósito: viajan al browser y son seguras de exponer.
 * La anon key no da acceso a nada por sí sola — la autorización real la imponen
 * la sesión y (cuando exista) RLS.
 *
 * ⚠️ La `service_role` NO pasa por acá y NUNCA lleva prefijo NEXT_PUBLIC_: vive
 * en `src/lib/supabase/admin.ts`, detrás de `import "server-only"`.
 *
 * ⚠️ No se puede desestructurar `process.env` ni leerlo con una clave dinámica:
 * Next reemplaza `process.env.NEXT_PUBLIC_*` textualmente en el bundle del
 * cliente, así que la referencia tiene que estar escrita completa.
 */
export function getSupabaseEnv(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Faltan NEXT_PUBLIC_SUPABASE_URL y/o NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
        "Ver .env.example (Project Settings -> API en el dashboard de Supabase)."
    );
  }

  return { url, anonKey };
}
