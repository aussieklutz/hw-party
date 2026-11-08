// layer.mjs - an RGBA overlay turned into something that can be blended onto NV12
// video frames quickly, and the blend itself.
//
// A layer is a box (x, y, w, h; even numbers, so it lines up with the 2x2 chroma
// blocks) with, per pixel, the luma already multiplied by the alpha and the
// inverse alpha, and per chroma block the summed alpha and the alpha-weighted
// chroma. Blending a frame is then one multiply-add per sample, and rows (or the
// parts of rows) that are fully transparent are skipped. BT.709 limited range,
// the same as the engine's own conversion.

/** Builds a layer from straight RGBA pixels (width*height*4) placed at (x, y). */
export function buildLayer(rgba, width, height, x, y) {
  // the box must start on an even pixel and have an even size
  if ((x | y) & 1 || width & 1 || height & 1) throw new Error("layer box must be even-aligned");
  const w = width, h = height, cw = w >> 1, ch = h >> 1;
  const yp = new Uint16Array(w * h);        // Y * alpha
  const ia = new Uint8Array(w * h);         // 255 - alpha
  const sa = new Uint16Array(cw * ch);      // sum of the 4 alphas (0..1020)
  const scb = new Int32Array(cw * ch);      // sum of Cb * alpha
  const scr = new Int32Array(cw * ch);
  const rowFrom = new Int32Array(h).fill(w), rowTo = new Int32Array(h).fill(0);
  let any = false;
  for (let j = 0; j < h; j++) {
    const cj = j >> 1;
    for (let i = 0; i < w; i++) {
      const p = (j * w + i) * 4;
      const a = rgba[p + 3];
      ia[j * w + i] = 255 - a;
      if (!a) continue;
      any = true;
      if (i < rowFrom[j]) rowFrom[j] = i;
      rowTo[j] = i + 1;
      const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
      yp[j * w + i] = (((47 * r + 157 * g + 16 * b) >> 8) + 16) * a;
      const c = cj * cw + (i >> 1);
      sa[c] += a;
      scb[c] += (128 + ((-26 * r - 87 * g + 112 * b) >> 8)) * a;
      scr[c] += (128 + ((112 * r - 102 * g - 10 * b) >> 8)) * a;
    }
  }
  return { x, y, w, h, cw, ch, yp, ia, sa, scb, scr, rowFrom, rowTo, empty: !any };
}

const div255 = (v) => (v + 128 + ((v + 128) >> 8)) >> 8;

/** Blends the layer into an NV12 frame of the given width, in place. */
export function blendLayer(frame, W, H, L) {
  if (!L || L.empty) return;
  const { x, y, w, h, cw, ch, yp, ia, sa, scb, scr, rowFrom, rowTo } = L;
  if (x + w > W || y + h > H) return;
  const uv = W * H;
  for (let j = 0; j < h; j++) {
    const from = rowFrom[j], to = rowTo[j];
    if (from >= to) continue;
    const row = (y + j) * W + x;
    const o = j * w;
    for (let i = from; i < to; i++) {
      const k = o + i;
      const inv = ia[k];
      if (inv === 255) continue;
      frame[row + i] = div255(frame[row + i] * inv + yp[k]);
    }
  }
  const k1020 = 1 / 1020;
  for (let j = 0; j < ch; j++) {
    const row = uv + ((y >> 1) + j) * W + x;
    const o = j * cw;
    for (let i = 0; i < cw; i++) {
      const s = sa[o + i];
      if (!s) continue;
      const d = row + i * 2;
      const keep = 1020 - s;
      frame[d] = (frame[d] * keep + scb[o + i]) * k1020 + 0.5;
      frame[d + 1] = (frame[d + 1] * keep + scr[o + i]) * k1020 + 0.5;
    }
  }
}

/** A solid NV12 frame (y, u, v are the limited range sample values). */
export function solidNV12(W, H, yv, uv, vv) {
  const f = Buffer.alloc((W * H * 3) / 2);
  f.fill(yv, 0, W * H);
  for (let i = W * H; i < f.length; i += 2) { f[i] = uv; f[i + 1] = vv; }
  return f;
}

/** Limited range BT.709 Y, Cb, Cr of an 0xRRGGBB colour. */
export function rgbToYuv(hex) {
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  return [
    ((47 * r + 157 * g + 16 * b) >> 8) + 16,
    128 + ((-26 * r - 87 * g + 112 * b) >> 8),
    128 + ((112 * r - 102 * g - 10 * b) >> 8),
  ];
}
