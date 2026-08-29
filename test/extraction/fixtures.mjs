// Deterministic, generated-only fixtures for subject extraction.  These contain
// no user artwork and deliberately stay small enough to make byte-level
// assertions cheap.

export function blank(width, height, rgba = [0, 0, 0, 0]) {
  const image = {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
  };
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = rgba[0];
    image.data[i + 1] = rgba[1];
    image.data[i + 2] = rgba[2];
    image.data[i + 3] = rgba[3];
  }
  return image;
}

export function clone(image) {
  return {
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(image.data),
  };
}

export function fill(image, x, y, width, height, rgba) {
  for (let yy = Math.max(0, y); yy < Math.min(image.height, y + height); yy++) {
    for (let xx = Math.max(0, x); xx < Math.min(image.width, x + width); xx++) {
      const offset = (yy * image.width + xx) * 4;
      image.data[offset] = rgba[0];
      image.data[offset + 1] = rgba[1];
      image.data[offset + 2] = rgba[2];
      image.data[offset + 3] = rgba[3];
    }
  }
  return image;
}

export function setPixel(image, x, y, rgba) {
  const offset = (y * image.width + x) * 4;
  image.data[offset] = rgba[0];
  image.data[offset + 1] = rgba[1];
  image.data[offset + 2] = rgba[2];
  image.data[offset + 3] = rgba[3];
  return image;
}

export function alphaSubject() {
  const image = blank(18, 18, [0, 0, 0, 0]);
  fill(image, 4, 3, 10, 12, [90, 130, 210, 255]);
  // Exercise hard-alpha thresholding on both sides of the default threshold.
  fill(image, 4, 3, 1, 12, [90, 130, 210, 120]);
  fill(image, 13, 3, 1, 12, [90, 130, 210, 210]);
  return image;
}

export function chromaSubject(background = [248, 248, 248, 255]) {
  const image = blank(20, 20, background);
  fill(image, 5, 4, 10, 13, [55, 100, 180, 255]);
  fill(image, 8, 7, 2, 3, [20, 20, 30, 255]);
  fill(image, 11, 7, 2, 3, [20, 20, 30, 255]);
  return image;
}

export function complexBackgroundSubject() {
  const image = blank(20, 20, [0, 0, 0, 255]);
  // Different corners intentionally violate the simple-background contract.
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      setPixel(image, x, y, [
        (x * 19 + y * 7) & 255,
        (x * 5 + y * 23) & 255,
        (x * 13 + y * 11) & 255,
        255,
      ]);
    }
  }
  fill(image, 6, 4, 8, 13, [235, 190, 150, 255]);
  return image;
}
