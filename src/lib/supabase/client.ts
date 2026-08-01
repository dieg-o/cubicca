"use client";

import { createBrowserClient } from "@supabase/ssr";

import { getSupabaseEnv } from "@/lib/supabase/env";

/**
 * Cliente de Supabase para el browser.
 *
 * Hoy la app no lo usa: login, signup y logout son Server Actions, que es donde
 * las cookies de sesión se pueden escribir de verdad. Existe para lo que sí
 * necesita correr en el cliente (escuchar `onAuthStateChange`, OAuth con
 * redirect, realtime). Si algún día no aparece ningún uso, se borra.
 */
export function createSupabaseBrowserClient() {
  const { url, anonKey } = getSupabaseEnv();

  return createBrowserClient(url, anonKey);
}
