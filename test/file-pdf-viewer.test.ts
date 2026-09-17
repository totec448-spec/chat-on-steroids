import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const getDocument = vi.hoisted(() => vi.fn());
const globalWorkerOptions = vi.hoisted(() => ({ workerSrc: '' }));

vi.mock('pdfjs-dist', () => ({
  getDocument,
  GlobalWorkerOptions: globalWorkerOptions
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/assets/pdf.worker.test.mjs' }));

import { createProjectPdfViewer } from '../src/renderer/file-pdf-viewer.js';

let dom: JSDOM;
let requestedPages: number[];
let renderedScales: number[];
let resizeCallback: (() => void) | null;
let deferNextRender: boolean;
let finishDeferredRender: (() => void) | null;
let drawImageCalls: number;

beforeEach(() => {
  dom = new JSDOM('<body><div id="viewer"></div></body>', {
    url: 'https://cos.local/',
    pretendToBeVisual: true
  });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('HTMLCanvasElement', dom.window.HTMLCanvasElement);
  vi.stubGlobal('atob', (value: string) => Buffer.from(value, 'base64').toString('binary'));
  vi.stubGlobal('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  vi.stubGlobal('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  resizeCallback = null;
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resizeCallback = callback; }
    observe(): void {}
    disconnect(): void {}
  });
  drawImageCalls = 0;
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({ drawImage: () => { drawImageCalls++; } })
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: () => undefined
  });

  requestedPages = [];
  renderedScales = [];
  deferNextRender = false;
  finishDeferredRender = null;
  getDocument.mockReset();
  globalWorkerOptions.workerSrc = '';
  getDocument.mockImplementation(() => ({
    promise: Promise.resolve({
      numPages: 2,
      getPage: async (pageNumber: number) => {
        requestedPages.push(pageNumber);
        return {
          getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
          render: ({ viewport }: { viewport: { width: number } }) => {
            renderedScales.push(viewport.width / 600);
            if (deferNextRender) {
              deferNextRender = false;
              let resolve!: () => void;
              const promise = new Promise<void>((done) => { resolve = done; });
              finishDeferredRender = resolve;
              return { promise, cancel: vi.fn() };
            }
            return { promise: Promise.resolve(), cancel: vi.fn() };
          }
        };
      }
    }),
    destroy: vi.fn(async () => undefined)
  }));
});

afterEach(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

it('loads bounded PDF bytes and renders the first page with navigation controls', async () => {
  const parent = document.getElementById('viewer')!;
  Object.defineProperty(parent, 'clientWidth', { configurable: true, value: 620 });
  const viewer = await createProjectPdfViewer({
    parent,
    filename: 'paper.pdf',
    dataBase64: Buffer.from('%PDF-1.4\n%%EOF').toString('base64')
  });

  expect(globalWorkerOptions.workerSrc).toBe('/assets/pdf.worker.test.mjs');
  expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.any(Uint8Array),
    enableXfa: false,
    useSystemFonts: true
  }));
  expect(parent.querySelector('.file-pdf-page')?.textContent).toBe('1 / 2');
  expect(requestedPages).toEqual([1]);
  expect(parent.querySelector<HTMLCanvasElement>('.file-pdf-canvas')?.hidden).toBe(false);

  parent.querySelector<HTMLButtonElement>('[aria-label="Next page"]')!.click();
  await Promise.resolve(); await Promise.resolve();
  expect(parent.querySelector('.file-pdf-page')?.textContent).toBe('2 / 2');
  expect(requestedPages.at(-1)).toBe(2);
  viewer.destroy();
});

it('supports zoom and returning to fit-to-width without leaving the PDF surface', async () => {
  const parent = document.getElementById('viewer')!;
  const viewer = await createProjectPdfViewer({
    parent,
    filename: 'paper.pdf',
    dataBase64: Buffer.from('%PDF-1.4\n%%EOF').toString('base64')
  });

  const initialRenders = renderedScales.length;
  parent.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click();
  await Promise.resolve(); await Promise.resolve();
  expect(renderedScales.length).toBeGreaterThan(initialRenders);
  expect(parent.querySelector<HTMLButtonElement>('[aria-label="Fit to width"]')?.classList.contains('is-active')).toBe(false);

  parent.querySelector<HTMLButtonElement>('[aria-label="Fit to width"]')!.click();
  await Promise.resolve(); await Promise.resolve();
  expect(parent.querySelector<HTMLButtonElement>('[aria-label="Fit to width"]')?.classList.contains('is-active')).toBe(true);
  viewer.destroy();
});

it('ignores resize churn until fit-to-width actually sees a new width', async () => {
  const parent = document.getElementById('viewer')!;
  const viewer = await createProjectPdfViewer({
    parent,
    filename: 'paper.pdf',
    dataBase64: Buffer.from('%PDF-1.4\n%%EOF').toString('base64')
  });
  const viewport = parent.querySelector<HTMLElement>('.file-pdf-viewport')!;
  Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 600 });

  // A real width change rerenders once.
  resizeCallback!();
  await new Promise((resolve) => setTimeout(resolve, 140));
  await Promise.resolve(); await Promise.resolve();
  const afterWidthChange = renderedScales.length;
  expect(afterWidthChange).toBeGreaterThan(1);

  // ResizeObserver also reports descendant/height changes. Same width must be a no-op.
  resizeCallback!();
  await new Promise((resolve) => setTimeout(resolve, 140));
  await Promise.resolve(); await Promise.resolve();
  expect(renderedScales).toHaveLength(afterWidthChange);
  viewer.destroy();
});

it('keeps one visible canvas and commits a replacement frame only after rendering finishes', async () => {
  const parent = document.getElementById('viewer')!;
  const viewer = await createProjectPdfViewer({
    parent,
    filename: 'paper.pdf',
    dataBase64: Buffer.from('%PDF-1.4\n%%EOF').toString('base64')
  });
  const firstCanvas = parent.querySelector<HTMLCanvasElement>('.file-pdf-canvas')!;
  expect(firstCanvas.hidden).toBe(false);

  deferNextRender = true;
  parent.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click();
  await Promise.resolve(); await Promise.resolve();
  expect(finishDeferredRender).not.toBeNull();
  expect(parent.querySelector('.file-pdf-canvas')).toBe(firstCanvas);
  expect(firstCanvas.hidden).toBe(false);

  finishDeferredRender!();
  await Promise.resolve(); await Promise.resolve();
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  await Promise.resolve(); await Promise.resolve();
  const nextCanvas = parent.querySelector<HTMLCanvasElement>('.file-pdf-canvas')!;
  expect(nextCanvas).toBe(firstCanvas);
  expect(nextCanvas.hidden).toBe(false);
  expect(drawImageCalls).toBeGreaterThan(1);
  viewer.destroy();
});

it('bounds the backing canvas even for an enormous declared PDF page', async () => {
  const sizes: Array<[number, number]> = [];
  getDocument.mockReturnValueOnce({ promise: Promise.resolve({ numPages: 1, getPage: async () => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 1_000_000 * scale, height: 1_000_000 * scale }),
    render: ({ canvas }: { canvas: HTMLCanvasElement }) => {
      sizes.push([canvas.width, canvas.height]);
      return { promise: Promise.resolve(), cancel: vi.fn() };
    }
  }) }), destroy: vi.fn(async () => undefined) });
  const viewer = await createProjectPdfViewer({ parent: document.getElementById('viewer')!, filename: 'large.pdf', dataBase64: 'JVBERg==' });
  expect(sizes).toHaveLength(1);
  expect(sizes[0]![0]).toBeLessThanOrEqual(8192);
  expect(sizes[0]![1]).toBeLessThanOrEqual(8192);
  expect(sizes[0]![0] * sizes[0]![1]).toBeLessThanOrEqual(16 * 1024 * 1024);
  viewer.destroy();
});

it('cancels a PDF loader as soon as its preview is retired', async () => {
  let finish!: (pdf: unknown) => void;
  const destroy = vi.fn(async () => undefined), getPage = vi.fn();
  getDocument.mockReturnValueOnce({ promise: new Promise(resolve => { finish = resolve; }), destroy });
  const controller = new AbortController();
  const parent = document.getElementById('viewer')!;
  const pending = createProjectPdfViewer({ parent, filename: 'pending.pdf', dataBase64: 'JVBERg==', signal: controller.signal });
  controller.abort();
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(parent.querySelector('.file-pdf-viewer')).toBeNull();
  finish({ numPages: 1, getPage });
  await pending;
  expect(getPage).not.toHaveBeenCalled();
});
