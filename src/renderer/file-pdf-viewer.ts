import { GlobalWorkerOptions, getDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

export interface ProjectPdfViewer {
  destroy(): void;
}

interface ProjectPdfViewerOptions {
  parent: HTMLElement;
  dataBase64: string;
  filename: string;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.2;

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function button(label: string, text: string): HTMLButtonElement {
  const control = document.createElement('button');
  control.type = 'button';
  control.className = 'file-pdf-control';
  control.setAttribute('aria-label', label);
  control.title = label;
  control.textContent = text;
  return control;
}

/**
 * Bounded, project-scoped PDF viewer. It receives bytes already authorised by main and renders
 * only the selected page to canvas: no native path, PDF URL, annotation layer or embedded action
 * is exposed to the renderer.
 */
export async function createProjectPdfViewer(options: ProjectPdfViewerOptions): Promise<ProjectPdfViewer> {
  GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

  const root = document.createElement('div');
  root.className = 'file-pdf-viewer';
  root.setAttribute('aria-label', `PDF preview: ${options.filename}`);
  const toolbar = document.createElement('div');
  toolbar.className = 'file-pdf-toolbar';
  const previous = button('Previous page', '‹');
  const page = document.createElement('span');
  page.className = 'file-pdf-page';
  page.setAttribute('aria-live', 'polite');
  const next = button('Next page', '›');
  const spacer = document.createElement('span');
  spacer.className = 'file-pdf-toolbar-spacer';
  const zoomOut = button('Zoom out', '−');
  const fit = button('Fit to width', 'Fit');
  const zoomIn = button('Zoom in', '+');
  toolbar.append(previous, page, next, spacer, zoomOut, fit, zoomIn);

  const viewport = document.createElement('div');
  viewport.className = 'file-pdf-viewport';
  const status = document.createElement('div');
  status.className = 'file-pdf-status';
  status.textContent = 'Loading PDF…';
  const canvas = document.createElement('canvas');
  canvas.className = 'file-pdf-canvas';
  canvas.hidden = true;
  viewport.append(status, canvas);
  root.append(toolbar, viewport);
  options.parent.replaceChildren(root);

  let loadingTask: PDFDocumentLoadingTask | null = null;
  let documentProxy: PDFDocumentProxy | null = null;
  let renderTask: RenderTask | null = null;
  let pageNumber = 1;
  let zoom = 1;
  let fitWidth = true;
  let destroyed = false;
  let renderToken = 0;
  let resizeTimer = 0;
  let hasRenderedPage = false;
  let lastFitClientWidth = -1;

  const refreshControls = (): void => {
    const pages = documentProxy?.numPages ?? 0;
    previous.disabled = !pages || pageNumber <= 1;
    next.disabled = !pages || pageNumber >= pages;
    zoomOut.disabled = !pages || (!fitWidth && zoom <= MIN_ZOOM);
    zoomIn.disabled = !pages || (!fitWidth && zoom >= MAX_ZOOM);
    fit.classList.toggle('is-active', fitWidth);
    page.textContent = pages ? `${pageNumber} / ${pages}` : '– / –';
  };
  refreshControls();

  const renderPage = async (): Promise<void> => {
    const pdf = documentProxy;
    if (!pdf || destroyed) return;
    const token = ++renderToken;
    renderTask?.cancel();
    renderTask = null;
    // Once a page exists, keep it visible until the replacement is completely rendered. PDF.js
    // paints progressively into its target canvas, so rendering into the visible canvas makes a
    // resize/page change flash white even when nothing has gone wrong.
    if (!hasRenderedPage) {
      status.hidden = false;
      status.textContent = `Rendering page ${pageNumber}…`;
      canvas.hidden = true;
    }
    try {
      const pdfPage = await pdf.getPage(pageNumber);
      if (destroyed || token !== renderToken) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const clientWidth = viewport.clientWidth;
      if (fitWidth) lastFitClientWidth = clientWidth;
      const available = Math.max(120, clientWidth - 28);
      const scale = fitWidth
        ? Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, available / Math.max(1, base.width)))
        : zoom;
      const pageViewport = pdfPage.getViewport({ scale });
      const outputScale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      const nextCanvas = document.createElement('canvas');
      nextCanvas.width = Math.max(1, Math.floor(pageViewport.width * outputScale));
      nextCanvas.height = Math.max(1, Math.floor(pageViewport.height * outputScale));
      const transform = outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0];
      renderTask = pdfPage.render({ canvas: nextCanvas, viewport: pageViewport, transform });
      await renderTask.promise;
      if (destroyed || token !== renderToken) return;
      renderTask = null;

      // Commit the completed frame into the one persistent visible canvas. Resizing a canvas
      // clears its backing store, but this whole resize + draw happens inside one animation-frame
      // callback, before Chromium is allowed to paint. That removes the last occasional blank
      // frame caused by replacing the visible canvas node after a completed PDF.js render.
      await new Promise<void>((resolve) => requestAnimationFrame(() => {
        if (!destroyed && token === renderToken) {
          canvas.width = nextCanvas.width;
          canvas.height = nextCanvas.height;
          canvas.style.width = `${Math.floor(pageViewport.width)}px`;
          canvas.style.height = `${Math.floor(pageViewport.height)}px`;
          const context = canvas.getContext('2d');
          if (context) context.drawImage(nextCanvas, 0, 0);
        }
        resolve();
      }));
      if (destroyed || token !== renderToken) return;
      canvas.hidden = false;
      hasRenderedPage = true;
      status.hidden = true;
      viewport.scrollTo({ top: 0, left: 0 });
      refreshControls();
    } catch (error) {
      if (destroyed || token !== renderToken) return;
      renderTask = null;
      const name = (error as { name?: string }).name;
      if (name === 'RenderingCancelledException') return;
      if (!hasRenderedPage) {
        canvas.hidden = true;
        status.hidden = false;
        status.textContent = error instanceof Error ? `PDF preview failed: ${error.message}` : 'PDF preview failed.';
      }
    }
  };

  previous.addEventListener('click', () => {
    if (!documentProxy || pageNumber <= 1) return;
    pageNumber--;
    refreshControls();
    void renderPage();
  });
  next.addEventListener('click', () => {
    if (!documentProxy || pageNumber >= documentProxy.numPages) return;
    pageNumber++;
    refreshControls();
    void renderPage();
  });
  zoomOut.addEventListener('click', () => {
    const baseZoom = fitWidth ? 1 : zoom;
    fitWidth = false;
    zoom = Math.max(MIN_ZOOM, baseZoom - ZOOM_STEP);
    refreshControls();
    void renderPage();
  });
  zoomIn.addEventListener('click', () => {
    const baseZoom = fitWidth ? 1 : zoom;
    fitWidth = false;
    zoom = Math.min(MAX_ZOOM, baseZoom + ZOOM_STEP);
    refreshControls();
    void renderPage();
  });
  fit.addEventListener('click', () => {
    fitWidth = true;
    refreshControls();
    void renderPage();
  });

  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    if (!fitWidth || !documentProxy || destroyed) return;
    // Page height and scrollbar/content changes are consequences of rendering, not reasons to
    // render again. Only a real width change can alter fit-to-width scale, and even that is
    // intentionally settled before rendering so panel drags never compete with PDF.js work.
    const width = viewport.clientWidth;
    if (Math.abs(width - lastFitClientWidth) < 1) return;
    if (resizeTimer) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      resizeTimer = 0;
      if (!fitWidth || !documentProxy || destroyed) return;
      const settledWidth = viewport.clientWidth;
      if (Math.abs(settledWidth - lastFitClientWidth) < 1) return;
      void renderPage();
    }, 120);
  }) : null;
  resizeObserver?.observe(viewport);

  try {
    loadingTask = getDocument({
      data: decodeBase64(options.dataBase64),
      enableXfa: false,
      useSystemFonts: true
    });
    documentProxy = await loadingTask.promise;
    if (destroyed) {
      await loadingTask.destroy();
      documentProxy = null;
    } else {
      refreshControls();
      await renderPage();
    }
  } catch (error) {
    if (!destroyed) {
      status.hidden = false;
      status.textContent = error instanceof Error ? `PDF preview failed: ${error.message}` : 'PDF preview failed.';
    }
  }

  return {
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      renderToken++;
      if (resizeTimer) window.clearTimeout(resizeTimer);
      resizeTimer = 0;
      resizeObserver?.disconnect();
      renderTask?.cancel();
      renderTask = null;
      documentProxy = null;
      if (loadingTask) void loadingTask.destroy();
      loadingTask = null;
      root.remove();
    }
  };
}
