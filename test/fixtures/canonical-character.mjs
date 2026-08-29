// Deterministic, code-generated pipeline fixture. It contains no external image
// or user asset and is redistributed under the repository's source-code license.

const blank = (width, height) => ({
  width,
  height,
  data: new Uint8ClampedArray(width * height * 4),
});

function fill(image, x, y, width, height, [red, green, blue], alpha = 255) {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(image.width, x + width);
  const y1 = Math.min(image.height, y + height);

  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      const offset = (yy * image.width + xx) * 4;
      image.data[offset] = red;
      image.data[offset + 1] = green;
      image.data[offset + 2] = blue;
      image.data[offset + 3] = alpha;
    }
  }
}

export function makeCanonicalCharacter({
  withFace = true,
  skin = [235, 220, 200],
  ink = [20, 20, 30],
} = {}) {
  const image = blank(64, 96);
  fill(image, 20, 60, 24, 30, [40, 90, 200]);
  fill(image, 16, 8, 32, 48, skin);
  fill(image, 14, 4, 36, 8, [90, 60, 30]);

  if (withFace) {
    fill(image, 22, 24, 7, 9, ink);
    fill(image, 36, 24, 7, 9, ink);
    fill(image, 29, 42, 8, 5, [210, 60, 70]);
  }

  return image;
}
