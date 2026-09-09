/**
 * Radiance RGBE (.hdr) reading, resampling and writing, enough to shrink a
 * sky for the single-file build without leaving node.
 */

/** Parses a Radiance file into { width, height, data: Float32Array(RGB) }. */
export function decodeRGBE(bytes) {
  let pos = 0;
  const line = () => {
    let end = pos;
    while (end < bytes.length && bytes[end] !== 0x0a) end++;
    const s = Buffer.from(bytes.subarray(pos, end)).toString('latin1');
    pos = end + 1;
    return s;
  };
  if (!line().startsWith('#?')) throw new Error('not a Radiance file');
  let header = line();
  while (header !== '') {
    if (header.startsWith('FORMAT=') && header !== 'FORMAT=32-bit_rle_rgbe') throw new Error(`unsupported ${header}`);
    header = line();
  }
  const m = /^-Y (\d+) \+X (\d+)$/.exec(line());
  if (!m) throw new Error('unsupported orientation');
  const height = +m[1];
  const width = +m[2];

  const data = new Float32Array(width * height * 3);
  const scan = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    const rle = bytes[pos] === 2 && bytes[pos + 1] === 2 && ((bytes[pos + 2] << 8) | bytes[pos + 3]) === width;
    if (rle) {
      pos += 4;
      for (let c = 0; c < 4; c++) {
        let x = 0;
        while (x < width) {
          let count = bytes[pos++];
          if (count > 128) {
            count -= 128;
            const v = bytes[pos++];
            for (let k = 0; k < count; k++) scan[(x++) * 4 + c] = v;
          } else {
            for (let k = 0; k < count; k++) scan[(x++) * 4 + c] = bytes[pos++];
          }
        }
      }
    } else {
      scan.set(bytes.subarray(pos, pos + width * 4));
      pos += width * 4;
    }
    for (let x = 0; x < width; x++) {
      const e = scan[x * 4 + 3];
      const f = e ? 2 ** (e - 136) : 0;
      const o = (y * width + x) * 3;
      data[o] = scan[x * 4] * f;
      data[o + 1] = scan[x * 4 + 1] * f;
      data[o + 2] = scan[x * 4 + 2] * f;
    }
  }
  return { width, height, data };
}

/** Area-weighted resample of an RGB float image, one axis at a time. */
export function resampleRGB({ width, height, data }, outW, outH) {
  const pass = (src, w, h, ow) => {
    const out = new Float32Array(ow * h * 3);
    const scale = w / ow;
    for (let x = 0; x < ow; x++) {
      const s0 = x * scale;
      const s1 = s0 + scale;
      for (let y = 0; y < h; y++) {
        let r = 0, g = 0, b = 0, wsum = 0;
        for (let sx = Math.floor(s0); sx < Math.min(Math.ceil(s1), w); sx++) {
          const wgt = Math.min(s1, sx + 1) - Math.max(s0, sx);
          if (wgt <= 0) continue;
          const i = (y * w + sx) * 3;
          r += src[i] * wgt;
          g += src[i + 1] * wgt;
          b += src[i + 2] * wgt;
          wsum += wgt;
        }
        const o = (y * ow + x) * 3;
        out[o] = r / wsum;
        out[o + 1] = g / wsum;
        out[o + 2] = b / wsum;
      }
    }
    return out;
  };
  const transpose = (src, w, h) => {
    const out = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        const o = (x * h + y) * 3;
        out[o] = src[i];
        out[o + 1] = src[i + 1];
        out[o + 2] = src[i + 2];
      }
    }
    return out;
  };
  const horizontal = pass(data, width, height, outW);
  const columns = pass(transpose(horizontal, outW, height), height, outW, outH);
  return { width: outW, height: outH, data: transpose(columns, outH, outW) };
}

/** Writes an RGB float image as a run-length encoded Radiance file. */
export function encodeRGBE({ width, height, data }) {
  const chunks = [Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`, 'latin1')];
  const scan = new Uint8Array(width * 4);
  const out = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const v = Math.max(r, g, b);
      const o = x * 4;
      if (v < 1e-32) {
        scan[o] = scan[o + 1] = scan[o + 2] = scan[o + 3] = 0;
        continue;
      }
      const e = Math.floor(Math.log2(v)) + 1;
      const scale = 256 / 2 ** e;
      scan[o] = Math.min(255, r * scale);
      scan[o + 1] = Math.min(255, g * scale);
      scan[o + 2] = Math.min(255, b * scale);
      scan[o + 3] = e + 128;
    }
    out.push(2, 2, width >> 8, width & 255);
    for (let c = 0; c < 4; c++) {
      let x = 0;
      while (x < width) {
        // A run of at least four identical bytes is worth encoding as one.
        let run = 1;
        while (x + run < width && run < 127 && scan[(x + run) * 4 + c] === scan[x * 4 + c]) run++;
        if (run >= 4) {
          out.push(128 + run, scan[x * 4 + c]);
          x += run;
          continue;
        }
        let end = x;
        while (end < width && end - x < 128) {
          let ahead = 1;
          while (end + ahead < width && ahead < 4 && scan[(end + ahead) * 4 + c] === scan[end * 4 + c]) ahead++;
          if (ahead >= 4) break;
          end++;
        }
        out.push(end - x);
        for (let k = x; k < end; k++) out.push(scan[k * 4 + c]);
        x = end;
      }
    }
  }
  chunks.push(Buffer.from(out));
  return Buffer.concat(chunks);
}
