// pngdec.mjs - a small PNG decoder for what headless Chrome writes: 8 bit RGBA
// (colour type 6) or RGB (2), not interlaced. Returns straight (not premultiplied)
// RGBA. Nothing else is needed, so there are no dependencies.
import { inflateSync } from "node:zlib";

export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString("latin1", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = body.readUInt32BE(0); h = body.readUInt32BE(4);
      depth = body[8]; ctype = body[9]; interlace = body[12];
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (depth !== 8 || (ctype !== 6 && ctype !== 2) || interlace) {
    throw new Error(`unsupported PNG (depth ${depth}, type ${ctype}, interlace ${interlace})`);
  }
  const bpp = ctype === 6 ? 4 : 3;
  const stride = w * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.allocUnsafe(w * h * 4);
  // unfilter into a plain scanline buffer, then widen to RGBA
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    switch (ft) {
      case 0: cur.set(src); break;
      case 1:
        for (let i = 0; i < stride; i++) cur[i] = src[i] + (i >= bpp ? cur[i - bpp] : 0);
        break;
      case 2:
        for (let i = 0; i < stride; i++) cur[i] = src[i] + prev[i];
        break;
      case 3:
        for (let i = 0; i < stride; i++) cur[i] = src[i] + (((i >= bpp ? cur[i - bpp] : 0) + prev[i]) >> 1);
        break;
      case 4:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          cur[i] = src[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
        break;
      default: throw new Error("bad PNG filter " + ft);
    }
    const o = y * w * 4;
    if (bpp === 4) out.set(cur, o);
    else for (let x = 0; x < w; x++) {
      out[o + x * 4] = cur[x * 3]; out[o + x * 4 + 1] = cur[x * 3 + 1];
      out[o + x * 4 + 2] = cur[x * 3 + 2]; out[o + x * 4 + 3] = 255;
    }
    [prev, cur] = [cur, prev];
  }
  return { width: w, height: h, rgba: out };
}
