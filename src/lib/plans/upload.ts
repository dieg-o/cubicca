"use client";

/**
 * PUT del archivo a la URL firmada de Supabase Storage. Solo browser.
 *
 * ¿Por qué XHR y no `supabase.storage.uploadToSignedUrl()`? Porque esa función
 * usa `fetch`, y `fetch` no reporta progreso de subida. Para un PDF de 40 MB
 * eso es la diferencia entre una barra que avanza y una pantalla congelada.
 * El destino es exactamente el mismo endpoint que usa el SDK: la `signedUrl`
 * que devolvió `createSignedUploadUrl` (el token va adentro de la URL).
 */

type UploadOptions = {
  signedUrl: string;
  file: File;
  contentType: string;
  onProgress: (fraction: number) => void;
  signal: AbortSignal;
};

export function uploadToSignedUrl({
  signedUrl,
  file,
  contentType,
  onProgress,
  signal,
}: UploadOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();

    request.open("PUT", signedUrl, true);
    request.setRequestHeader("content-type", contentType);
    // Mismo valor que manda el SDK por defecto. El objeto es privado y solo se
    // sirve por URL firmada, así que la caché es del browser y de nadie más.
    request.setRequestHeader("cache-control", "max-age=3600");

    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(event.loaded / event.total);
      }
    });

    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress(1);
        resolve();

        return;
      }

      // El cuerpo del error puede traer detalle del bucket: al log, no a la UI.
      console.error(`[plans] Storage respondió ${request.status}:`, request.responseText);
      reject(new Error("Storage rechazó el archivo."));
    });

    request.addEventListener("error", () => {
      reject(new Error("Se cortó la conexión durante la subida."));
    });

    request.addEventListener("abort", () => {
      reject(new Error("Subida cancelada."));
    });

    signal.addEventListener("abort", () => request.abort(), { once: true });

    request.send(file);
  });
}
