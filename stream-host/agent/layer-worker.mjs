// layer-worker.mjs - decodes a screenshot into a blendable layer off the main thread, so a
// big overlay (a full-screen slate page) never holds up the frame clock.
import { parentPort } from "node:worker_threads";
import { decodePng } from "./pngdec.mjs";
import { buildLayer } from "./layer.mjs";

parentPort.on("message", ({ id, png, x, y }) => {
  const t0 = performance.now();
  try {
    const img = decodePng(Buffer.from(png.buffer, png.byteOffset, png.byteLength));
    const layer = buildLayer(img.rgba, img.width, img.height, x, y);
    const transfer = [layer.yp.buffer, layer.ia.buffer, layer.sa.buffer, layer.scb.buffer, layer.scr.buffer, layer.rowFrom.buffer, layer.rowTo.buffer];
    parentPort.postMessage({ id, layer, ms: performance.now() - t0 }, transfer);
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
