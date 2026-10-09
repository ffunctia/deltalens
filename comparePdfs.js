import { createCanvas } from "skia-canvas";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.js";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "./node_modules/pdfjs-dist/legacy/build/pdf.worker.min.js";

const SCALE = 4; // ~300 DPI

async function renderPageToPng(page) {
  const viewport = page.getViewport({ scale: SCALE });

  const canvas = createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext("2d");

  await page.render({
    canvasContext: ctx,
    viewport
  }).promise;

  return PNG.sync.read(canvas.toBuffer());
}
