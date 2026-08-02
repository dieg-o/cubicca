"use client";

import type { PDFDocumentProxy } from "pdfjs-dist";
import { useCallback, useEffect, useRef, useState } from "react";

import { loadPdfjs } from "@/lib/pdf/pdfjs";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * Viewer de PDF. Render + navegación + zoom, nada más.
 *
 * Sin herramientas de dibujo, sin medición, sin calibración: eso es TD-004/005.
 *
 * Dos orígenes posibles, y la diferencia importa:
 *  - `file`: el File que el usuario acaba de subir, todavía en memoria. No se
 *    vuelve a bajar lo que ya está en la máquina.
 *  - `plan`: un plano de una visita anterior. Se pide una URL firmada de vida
 *    corta a /api/plans/[planId]/file y pdf.js lee de ahí (con range requests,
 *    así que una planta de 30 MB empieza a mostrarse sin bajarse entera).
 * ────────────────────────────────────────────────────────────────────────────
 */

export type PdfSource = { kind: "file"; file: File } | { kind: "plan"; planId: string };

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const ZOOM_STEP = 1.25;

type ZoomMode = { mode: "fit" } | { mode: "manual"; scale: number };

type Status = "loading" | "ready" | "error";

async function fetchSignedUrl(planId: string): Promise<string> {
  const response = await fetch(`/api/plans/${planId}/file`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`El servidor respondió ${response.status} al pedir el plano.`);
  }

  const payload: unknown = await response.json();

  if (
    typeof payload !== "object" ||
    payload === null ||
    !("url" in payload) ||
    typeof payload.url !== "string"
  ) {
    throw new Error("La respuesta del servidor no trae la URL del plano.");
  }

  return payload.url;
}

export function PdfViewer({ source }: { source: PdfSource }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Escala realmente aplicada en el último render: el origen de los +/−. */
  const appliedScaleRef = useRef(1);

  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState<ZoomMode>({ mode: "fit" });
  /** Cambia con cada resize para reejecutar el render en modo "ajustar". */
  const [containerWidth, setContainerWidth] = useState(0);

  // ── Apertura del documento ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let loadingTask: { destroy: () => Promise<void> } | null = null;

    // Sin reseteos de estado acá: el padre remonta el viewer con `key` al
    // cambiar de plano, así que este efecto siempre arranca con el estado
    // inicial (status "loading", página 1). Escribir estado sincrónicamente en
    // el cuerpo de un efecto además dispara renders en cascada.
    async function open() {
      const pdfjs = await loadPdfjs();

      // El File se lee acá y no se guarda: pdf.js se queda con los bytes.
      const parameters =
        source.kind === "file"
          ? { data: new Uint8Array(await source.file.arrayBuffer()) }
          : { url: await fetchSignedUrl(source.planId) };

      const task = pdfjs.getDocument(parameters);

      loadingTask = task;

      const document = await task.promise;

      if (cancelled) {
        return;
      }

      setPdf(document);
      setStatus("ready");
    }

    open().catch((error: unknown) => {
      // El detalle técnico (worker que no carga, URL vencida, PDF corrupto) va
      // al log; al usuario le llega algo accionable.
      console.error("[viewer] no se pudo abrir el PDF:", error);

      if (!cancelled) {
        setStatus("error");
        setErrorMessage("No se pudo abrir el PDF. Probá recargar la página.");
      }
    });

    return () => {
      cancelled = true;
      // Cierra el worker y aborta las descargas en curso. Sin esto, cambiar de
      // plano rápido deja workers vivos bajando PDFs que ya nadie mira.
      void loadingTask?.destroy();
    };
  }, [source]);

  // ── Ancho disponible, para el modo "ajustar" ──────────────────────────────
  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    setContainerWidth(container.clientWidth);

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;

      setContainerWidth(Math.floor(width));
    });

    observer.observe(container);

    return () => observer.disconnect();
  }, [status]);

  // ── Render de la página ───────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;

    if (!pdf || !canvas) {
      return;
    }

    let cancelled = false;
    let renderTask: { cancel: () => void } | null = null;

    async function render(document: PDFDocumentProxy, target: HTMLCanvasElement) {
      const page = await document.getPage(pageNumber);

      if (cancelled) {
        return;
      }

      const base = page.getViewport({ scale: 1 });
      const fitScale = containerWidth > 0 ? containerWidth / base.width : 1;
      const scale = clampScale(zoom.mode === "fit" ? fitScale : zoom.scale);

      appliedScaleRef.current = scale;

      // El canvas se dibuja a resolución de dispositivo y se muestra a tamaño
      // CSS: sin esto, en una pantalla retina las líneas del plano salen
      // borrosas. Se topea en 2 para no pedir un canvas de 100 megapíxeles.
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: scale * ratio });

      target.width = Math.floor(viewport.width);
      target.height = Math.floor(viewport.height);
      target.style.width = `${Math.floor(viewport.width / ratio)}px`;
      target.style.height = `${Math.floor(viewport.height / ratio)}px`;

      const task = page.render({ canvas: target, viewport });

      renderTask = task;

      await task.promise;
    }

    render(pdf, canvas).catch((error: unknown) => {
      // Cancelar un render es normal (zoom rápido, cambio de página): pdf.js lo
      // reporta como excepción y no es un fallo que mostrarle a nadie.
      if (cancelled) {
        return;
      }

      console.error("[viewer] falló el render de la página:", error);
      setErrorMessage("No se pudo dibujar esta página.");
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdf, pageNumber, zoom, containerWidth]);

  const changeZoom = useCallback((factor: number) => {
    setZoom({ mode: "manual", scale: clampScale(appliedScaleRef.current * factor) });
  }, []);

  const pageCount = pdf?.numPages ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ToolbarButton
          onClick={() => setPageNumber((current) => Math.max(1, current - 1))}
          disabled={status !== "ready" || pageNumber <= 1}
        >
          ← Anterior
        </ToolbarButton>

        <span className="text-sm tabular-nums text-muted-foreground">
          {status === "ready" ? `Página ${pageNumber} de ${pageCount}` : "…"}
        </span>

        <ToolbarButton
          onClick={() => setPageNumber((current) => Math.min(pageCount, current + 1))}
          disabled={status !== "ready" || pageNumber >= pageCount}
        >
          Siguiente →
        </ToolbarButton>

        <span className="mx-2 h-4 w-px bg-border" aria-hidden />

        <ToolbarButton onClick={() => changeZoom(1 / ZOOM_STEP)} disabled={status !== "ready"}>
          − Zoom
        </ToolbarButton>

        <ToolbarButton onClick={() => changeZoom(ZOOM_STEP)} disabled={status !== "ready"}>
          + Zoom
        </ToolbarButton>

        <ToolbarButton onClick={() => setZoom({ mode: "fit" })} disabled={status !== "ready"}>
          Ajustar al ancho
        </ToolbarButton>
      </div>

      <div
        ref={containerRef}
        className="max-h-[70vh] overflow-auto rounded-md border bg-muted/30 p-3"
      >
        {status === "loading" ? (
          <p className="text-sm text-muted-foreground">Abriendo el PDF…</p>
        ) : null}

        {status === "error" ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage}
          </p>
        ) : null}

        <canvas ref={canvasRef} className={status === "ready" ? "bg-white" : "hidden"} />
      </div>

      {status === "ready" && errorMessage ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}

function clampScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) {
    return 1;
  }

  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

function ToolbarButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border px-2 py-1 text-sm disabled:opacity-40"
    >
      {children}
    </button>
  );
}
