import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";

const ICON_SIZES = [16, 32, 48, 96, 128, 256, 512];
const OUTPUT_DIR = "public/icons";

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const checksumInput = Buffer.concat([typeBuffer, data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(checksumInput), 0);

  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function writePng(path, width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    scanlines[rowStart] = 0;
    rgba.copy(scanlines, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    Buffer.concat([
      signature,
      pngChunk("IHDR", ihdr),
      pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
      pngChunk("IEND", Buffer.alloc(0))
    ])
  );
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function mix(a, b, t) {
  return a + (b - a) * clamp(t);
}

function mixColor(a, b, t, alpha = 255) {
  return [
    Math.round(mix(a[0], b[0], t)),
    Math.round(mix(a[1], b[1], t)),
    Math.round(mix(a[2], b[2], t)),
    alpha
  ];
}

function overPixel(buffer, index, color) {
  const sourceAlpha = color[3] / 255;
  const destAlpha = buffer[index + 3] / 255;
  const outputAlpha = sourceAlpha + destAlpha * (1 - sourceAlpha);

  if (outputAlpha === 0) {
    return;
  }

  buffer[index] = Math.round((color[0] * sourceAlpha + buffer[index] * destAlpha * (1 - sourceAlpha)) / outputAlpha);
  buffer[index + 1] = Math.round((color[1] * sourceAlpha + buffer[index + 1] * destAlpha * (1 - sourceAlpha)) / outputAlpha);
  buffer[index + 2] = Math.round((color[2] * sourceAlpha + buffer[index + 2] * destAlpha * (1 - sourceAlpha)) / outputAlpha);
  buffer[index + 3] = Math.round(outputAlpha * 255);
}

function isInRoundedRect(x, y, left, top, width, height, radius) {
  const right = left + width;
  const bottom = top + height;
  if (x < left || x > right || y < top || y > bottom) {
    return false;
  }

  const cornerX = x < left + radius ? left + radius : x > right - radius ? right - radius : x;
  const cornerY = y < top + radius ? top + radius : y > bottom - radius ? bottom - radius : y;
  const dx = x - cornerX;
  const dy = y - cornerY;
  return dx * dx + dy * dy <= radius * radius;
}

function isInCircle(x, y, cx, cy, radius) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function isInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const xi = points[i][0];
    const yi = points[i][1];
    const xj = points[j][0];
    const yj = points[j][1];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function distanceToSegment(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.hypot(x - x1, y - y1);
  }

  const t = clamp(((x - x1) * dx + (y - y1) * dy) / lengthSquared);
  const projectionX = x1 + t * dx;
  const projectionY = y1 + t * dy;
  return Math.hypot(x - projectionX, y - projectionY);
}

function drawShape(buffer, width, height, test, colorAt) {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      if (!test(px, py)) {
        continue;
      }
      overPixel(buffer, (y * width + x) * 4, colorAt(px, py));
    }
  }
}

function roundedRect(left, top, width, height, radius) {
  return (x, y) => isInRoundedRect(x, y, left, top, width, height, radius);
}

function circle(cx, cy, radius) {
  return (x, y) => isInCircle(x, y, cx, cy, radius);
}

function capsule(x1, y1, x2, y2, radius) {
  return (x, y) => distanceToSegment(x, y, x1, y1, x2, y2) <= radius;
}

function downsample(buffer, size, scale) {
  const sourceWidth = size * scale;
  const output = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const totals = [0, 0, 0, 0];
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const index = ((y * scale + sy) * sourceWidth + x * scale + sx) * 4;
          totals[0] += buffer[index];
          totals[1] += buffer[index + 1];
          totals[2] += buffer[index + 2];
          totals[3] += buffer[index + 3];
        }
      }
      const outputIndex = (y * size + x) * 4;
      const area = scale * scale;
      output[outputIndex] = Math.round(totals[0] / area);
      output[outputIndex + 1] = Math.round(totals[1] / area);
      output[outputIndex + 2] = Math.round(totals[2] / area);
      output[outputIndex + 3] = Math.round(totals[3] / area);
    }
  }

  return output;
}

function drawBrowserPanel(pixels, canvasSize, unit, size) {
  const x = size * 0.265 * unit;
  const y = size * 0.24 * unit;
  const width = size * 0.43 * unit;
  const height = size * 0.36 * unit;
  const radius = size * 0.072 * unit;

  drawShape(
    pixels,
    canvasSize,
    canvasSize,
    roundedRect(x + size * 0.018 * unit, y + size * 0.032 * unit, width, height, radius),
    () => [0, 0, 0, 70]
  );
  drawShape(
    pixels,
    canvasSize,
    canvasSize,
    roundedRect(x, y, width, height, radius),
    (px, py) => {
      const t = clamp((py - y) / height);
      return mixColor([249, 251, 253], [202, 211, 220], t, 246);
    }
  );
  drawShape(
    pixels,
    canvasSize,
    canvasSize,
    roundedRect(x, y, width, size * 0.08 * unit, radius),
    () => [226, 232, 238, 245]
  );

  if (size >= 32) {
    for (const dotX of [0.33, 0.375]) {
      drawShape(
        pixels,
        canvasSize,
        canvasSize,
        circle(size * dotX * unit, size * 0.28 * unit, size * 0.014 * unit),
        () => [104, 112, 123, 215]
      );
    }
    drawShape(
      pixels,
      canvasSize,
      canvasSize,
      capsule(size * 0.445 * unit, size * 0.28 * unit, size * 0.61 * unit, size * 0.28 * unit, size * 0.012 * unit),
      () => [119, 130, 142, 205]
    );
    drawShape(
      pixels,
      canvasSize,
      canvasSize,
      capsule(size * 0.33 * unit, size * 0.37 * unit, size * 0.45 * unit, size * 0.37 * unit, size * 0.014 * unit),
      () => [68, 74, 82, 205]
    );
    drawShape(
      pixels,
      canvasSize,
      canvasSize,
      capsule(size * 0.33 * unit, size * 0.445 * unit, size * 0.52 * unit, size * 0.445 * unit, size * 0.013 * unit),
      () => [101, 111, 123, 145]
    );
  }
}

function drawCenteredOrb(pixels, canvasSize, unit, size) {
  const cx = size * 0.5 * unit;
  const cy = size * 0.5 * unit;
  const radius = size * 0.43 * unit;

  drawShape(
    pixels,
    canvasSize,
    canvasSize,
    circle(cx, cy + size * 0.045 * unit, radius * 1.05),
    () => [0, 0, 0, 82]
  );
  drawShape(
    pixels,
    canvasSize,
    canvasSize,
    circle(cx, cy, radius),
    (x, y) => {
      const diagonal = clamp((x + y - size * 0.58 * unit) / (size * 0.72 * unit));
      return mixColor([128, 246, 222], [77, 160, 255], diagonal, 255);
    }
  );
  drawShape(
    pixels,
    canvasSize,
    canvasSize,
    circle(cx - size * 0.075 * unit, cy - size * 0.078 * unit, radius * 0.54),
    (x, y) => {
      const fade = clamp(1 - Math.hypot(x - (cx - size * 0.075 * unit), y - (cy - size * 0.078 * unit)) / (radius * 0.54));
      return [255, 255, 255, Math.round(fade * 120)];
    }
  );
  drawShape(
    pixels,
    canvasSize,
    canvasSize,
    circle(cx, cy, radius * 0.4),
    () => [249, 252, 255, 178]
  );
}

function drawChatBubble(pixels, canvasSize, unit, size) {
  const bubbleX = size * 0.31 * unit;
  const bubbleY = size * 0.405 * unit;
  const bubbleW = size * 0.4 * unit;
  const bubbleH = size * 0.285 * unit;
  const bubbleRadius = size * 0.072 * unit;
  const tail = [
    [size * 0.455 * unit, size * 0.675 * unit],
    [size * 0.415 * unit, size * 0.79 * unit],
    [size * 0.54 * unit, size * 0.68 * unit]
  ];

  drawShape(
    pixels,
    canvasSize,
    canvasSize,
    (x, y) => isInPolygon(x, y, tail.map(([px, py]) => [px + size * 0.018 * unit, py + size * 0.028 * unit])),
    () => [0, 0, 0, 66]
  );
  drawShape(
    pixels,
    canvasSize,
    canvasSize,
    roundedRect(bubbleX + size * 0.018 * unit, bubbleY + size * 0.028 * unit, bubbleW, bubbleH, bubbleRadius),
    () => [0, 0, 0, 66]
  );
  drawShape(
    pixels,
    canvasSize,
    canvasSize,
    (x, y) => isInPolygon(x, y, tail),
    (px, py) => {
      const t = clamp((py - bubbleY) / bubbleH);
      return mixColor([255, 255, 255], [231, 237, 244], t, 255);
    }
  );
  drawShape(
    pixels,
    canvasSize,
    canvasSize,
    roundedRect(bubbleX, bubbleY, bubbleW, bubbleH, bubbleRadius),
    (px, py) => {
      const t = clamp((py - bubbleY) / bubbleH);
      return mixColor([255, 255, 255], [231, 237, 244], t, 255);
    }
  );

  drawShape(
    pixels,
    canvasSize,
    canvasSize,
    capsule(size * 0.42 * unit, size * 0.5 * unit, size * 0.6 * unit, size * 0.5 * unit, size * 0.021 * unit),
    () => [29, 34, 40, 224]
  );

  if (size >= 24) {
    drawShape(
      pixels,
      canvasSize,
      canvasSize,
      capsule(size * 0.42 * unit, size * 0.59 * unit, size * 0.545 * unit, size * 0.59 * unit, size * 0.019 * unit),
      () => [29, 34, 40, 190]
    );
  }

  drawShape(
    pixels,
    canvasSize,
    canvasSize,
    circle(size * 0.635 * unit, size * 0.59 * unit, size * 0.032 * unit),
    () => [105, 232, 200, 255]
  );
}

function buildIcon(size) {
  const scale = 4;
  const canvasSize = size * scale;
  const pixels = Buffer.alloc(canvasSize * canvasSize * 4);
  const unit = scale;

  const badgeMargin = size * 0.005 * unit;
  const badgeSize = canvasSize - badgeMargin * 2;
  const badgeRadius = size * 0.19 * unit;

  drawShape(
    pixels,
    canvasSize,
    canvasSize,
    roundedRect(badgeMargin - size * 0.02 * unit, badgeMargin - size * 0.02 * unit, badgeSize + size * 0.04 * unit, badgeSize + size * 0.04 * unit, badgeRadius * 1.04),
    () => [255, 255, 255, 45]
  );
  drawShape(
    pixels,
    canvasSize,
    canvasSize,
    roundedRect(badgeMargin, badgeMargin, badgeSize, badgeSize, badgeRadius),
    (x, y) => {
      const diagonal = clamp((x + y - badgeMargin * 2) / (badgeSize * 2));
      const topLight = clamp(1 - (x + y) / (canvasSize * 0.94)) * 0.35;
      const base = mixColor([48, 52, 58], [13, 15, 18], diagonal, 255);
      return [
        Math.round(mix(base[0], 255, topLight * 0.12)),
        Math.round(mix(base[1], 255, topLight * 0.12)),
        Math.round(mix(base[2], 255, topLight * 0.12)),
        255
      ];
    }
  );
  drawShape(
    pixels,
    canvasSize,
    canvasSize,
    roundedRect(badgeMargin + size * 0.024 * unit, badgeMargin + size * 0.024 * unit, badgeSize - size * 0.048 * unit, badgeSize - size * 0.048 * unit, badgeRadius * 0.86),
    (x, y) => {
      const nearTopLeft = clamp(1 - (x + y) / (canvasSize * 0.78));
      return [255, 255, 255, Math.round(nearTopLeft * 28)];
    }
  );

  drawCenteredOrb(pixels, canvasSize, unit, size);

  return downsample(pixels, size, scale);
}

for (const size of ICON_SIZES) {
  writePng(join(OUTPUT_DIR, `icon-${size}.png`), size, size, buildIcon(size));
}

console.log(`Generated ${ICON_SIZES.length} extension icons in ${OUTPUT_DIR}/`);
