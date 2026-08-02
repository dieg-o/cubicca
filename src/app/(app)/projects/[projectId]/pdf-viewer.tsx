"use client";

import type { PageViewport, PDFDocumentProxy } from "pdfjs-dist";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Point } from "@/lib/geometry";
import { loadPdfjs } from "@/lib/pdf/pdfjs";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * Viewer de PDF. Render + navegación + zoom + captura de puntos.
 *
 * Sin herramientas de medición: las de largo/área con persistencia son TD-005.
 * Lo único que se marca acá es la calibración de escala.
 *
 * Dos orígenes posibles, y la diferencia importa:
 *  - `file`: el File que el usuario acaba de subir, todavía en memoria. No se
 *    vuelve a bajar lo que ya está en la máquina.
 *  - `plan`: un plano de una visita anterior. Se pide una URL firmada de vida
 *    corta a /api/plans/[planId]/file y pdf.js lee de ahí (con range requests,
 *    así que una planta de 30 MB empieza a mostrarse sin bajarse entera).
 *
 * ⚠️ LA REGLA DE COORDENADAS: hacia afuera de este componente los puntos salen
 * SIEMPRE en user-space del PDF, nunca en píxeles. Un píxel depende del zoom,
 * del ancho de la ventana y del DPR; el user-space es del documento. La
 * conversión en las dos direcciones vive acá y en ningún otro lado.
 * ────────────────────────────────────────────────────────────────────────────
 */

export type PdfSource = { kind: "file"; file: File } | { kind: "plan"; planId: string };

/** Puntos a dibujar sobre una página concreta, en user-space. */
export type PdfOverlay = {
  /** 0-based, como se persiste. Si no coincide con la página a la vista, no se dibuja. */
  pageIndex: number;
  points: readonly Point[];
};

type PdfViewerProps = {
  source: PdfSource;
  /** Con esto en true, cada click sobre la página emite un punto. */
  pickingPoints?: boolean;
  overlay?: PdfOverlay | null;
  /**
   * Recibe el punto YA convertido a user-space, junto con la página donde se
   * marcó. El pageIndex viaja con cada punto para que el padre no tenga que
   * seguir en paralelo qué página está a la vista.
   */
  onPickPoint?: (point: Point, pageIndex: number) => void;
};

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

/**
 * Lee un punto de los que devuelve pdf.js.
 *
 * `convertToPdfPoint` / `convertToViewportPoint` están tipados como `any[]` en
 * pdfjs-dist. Entra por `unknown` y se estrecha a mano: es la forma de que ese
 * `any` de la librería no se cuele adentro nuestro, que es justo lo que la regla
 * "prohibido any" quiere evitar.
 */
function readPair(converted: unknown, context: string): Point {
  if (
    !Array.isArray(converted) ||
    typeof converted[0] !== "number" ||
    typeof converted[1] !== "number"
  ) {
    throw new Error(`${context} devolvió algo que no es un par de números.`);
  }

  return { x: converted[0], y: converted[1] };
}

export function PdfViewer({
  source,
  pickingPoints = false,
  overlay = null,
  onPickPoint,
}: PdfViewerProps) {
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
  /**
   * El viewport de la página a la vista, en unidades CSS (escala SIN el
   * devicePixelRatio). Es el traductor entre lo que ve el usuario y el
   * user-space, en las dos direcciones: clicks hacia adentro, marcas hacia
   * afuera. Va en estado y no en un ref porque el overlay se dibuja con él.
   *
   * ⚠️ Tiene que ser el CSS, no el del render: ese va multiplicado por el DPR,
   * y usarlo para los clicks daría puntos corridos por 2 en cualquier pantalla
   * retina — un error que en un monitor común no se ve nunca.
   */
  const [cssViewport, setCssViewport] = useState<PageViewport | null>(null);

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

      if (cancelled) {
        return;
      }

      // Después del render, no antes: el overlay se dibuja recién cuando hay
      // página abajo. Es un setState dentro de un callback async, no en el
      // cuerpo del efecto: no encadena renders.
      setCssViewport(page.getViewport({ scale }));
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

  /**
   * Click en píxeles CSS → punto en user-space.
   *
   * `getBoundingClientRect()` da la caja del canvas ya resuelta (scroll,
   * layout), así que la resta contra `clientX/Y` da coordenadas relativas al
   * canvas — que es exactamente el espacio del viewport CSS. De ahí,
   * `convertToPdfPoint` hace el resto, incluida la rotación de la página y el
   * hecho de que el eje Y del PDF va para arriba y el de la pantalla para abajo.
   *
   * Consecuencia buscada: el punto que sale NO depende del zoom ni del DPR.
   */
  function handleCanvasClick(event: React.MouseEvent<HTMLCanvasElement>) {
    if (!pickingPoints || !onPickPoint || !cssViewport) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();

    try {
      const point = readPair(
        cssViewport.convertToPdfPoint(event.clientX - rect.left, event.clientY - rect.top),
        "convertToPdfPoint"
      );

      onPickPoint(point, pageNumber - 1);
    } catch (error) {
      console.error("[viewer] no se pudo convertir el click a user-space:", error);
      setErrorMessage("No se pudo tomar ese punto. Probá de nuevo.");
    }
  }

  const pageCount = pdf?.numPages ?? 0;

  // La vuelta del mismo viaje: los puntos guardados en user-space se proyectan
  // a píxeles CSS para dibujarlos. Por eso las marcas quedan pegadas al plano
  // al hacer zoom, en vez de flotar donde se clickeó.
  const overlayPoints =
    cssViewport && overlay && overlay.pageIndex === pageNumber - 1
      ? projectPoints(overlay.points, cssViewport)
      : [];

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

        {/* `relative` + `w-fit`: el overlay se posiciona contra el canvas, no
            contra el contenedor scrolleable. */}
        <div className={status === "ready" ? "relative w-fit" : "hidden"}>
          <canvas
            ref={canvasRef}
            onClick={handleCanvasClick}
            className={`block bg-white ${pickingPoints ? "cursor-crosshair" : ""}`}
          />

          {overlayPoints.length > 0 && cssViewport ? (
            <svg
              // pointer-events-none: el SVG tapa el canvas, y sin esto se comería
              // el segundo click de la calibración.
              className="pointer-events-none absolute left-0 top-0"
              width={cssViewport.width}
              height={cssViewport.height}
              aria-hidden
            >
              {overlayPoints.length > 1 ? (
                <polyline
                  points={overlayPoints.map((point) => `${point.x},${point.y}`).join(" ")}
                  fill="none"
                  stroke="#dc2626"
                  strokeWidth={2}
                />
              ) : null}

              {overlayPoints.map((point, index) => (
                <circle
                  key={index}
                  cx={point.x}
                  cy={point.y}
                  r={5}
                  fill="#dc2626"
                  stroke="white"
                  strokeWidth={1.5}
                />
              ))}
            </svg>
          ) : null}
        </div>
      </div>

      {status === "ready" && errorMessage ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}

/**
 * user-space → píxeles CSS, para dibujar.
 *
 * Si algo viene mal (un punto corrupto en la base, una conversión que no
 * devuelve un par), no se dibuja nada y queda el log: una marca torcida en un
 * plano es peor que ninguna marca, porque se le cree.
 */
function projectPoints(points: readonly Point[], viewport: PageViewport): Point[] {
  try {
    return points.map((point) =>
      readPair(viewport.convertToViewportPoint(point.x, point.y), "convertToViewportPoint")
    );
  } catch (error) {
    console.error("[viewer] no se pudieron proyectar los puntos del overlay:", error);

    return [];
  }
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
