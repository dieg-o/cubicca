/**
 * Constantes del upload de planos, compartidas por cliente y servidor.
 *
 * Este módulo lo importan client components: NADA de secretos ni de
 * `server-only` acá. Los límites se repiten en tres lugares a propósito —
 * el input del browser (UX), el server action (autoridad) y el bucket de
 * Supabase (última línea) — y los tres tienen que decir lo mismo.
 */

/** Único MIME aceptado. El bucket `plans` también lo restringe a esto. */
export const PLAN_CONTENT_TYPE = "application/pdf";

/** 50 MB. Idéntico al `file_size_limit` del bucket `plans`. */
export const PLAN_MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

/**
 * Vida de la URL firmada de lectura, en segundos.
 *
 * Corta a propósito: es una URL sin autenticación: quien la tenga, ve el PDF.
 * Alcanza para que pdf.js abra el documento y siga leyendo rangos mientras el
 * usuario navega las páginas.
 */
export const PLAN_DOWNLOAD_URL_TTL_SECONDS = 300;

export function formatFileSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);

  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
