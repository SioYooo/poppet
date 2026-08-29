export function blank(width, height) {
  return {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
  };
}

export function clone(image) {
  return {
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(image.data),
  };
}

export function setPixel(image, x, y, rgba) {
  const offset = (y * image.width + x) * 4;
  image.data[offset] = rgba[0];
  image.data[offset + 1] = rgba[1];
  image.data[offset + 2] = rgba[2];
  image.data[offset + 3] = rgba[3];
}

export function gradientSubject(width = 96, height = 128, tint = [0, 0, 0]) {
  const image = blank(width, height);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = (x - cx) / Math.max(1, width * 0.38);
      const ny = (y - cy) / Math.max(1, height * 0.43);
      const distance = nx * nx + ny * ny;
      if (distance > 1) continue;
      const edge = distance > 0.90;
      setPixel(image, x, y, [
        (x * 9 + y * 3 + tint[0]) & 255,
        (x * 2 + y * 7 + tint[1]) & 255,
        (x * 5 + y * 11 + tint[2]) & 255,
        edge ? ((x + y) % 2 ? 120 : 210) : 255,
      ]);
    }
  }
  return image;
}
export function wideSubject() {
  const image = blank(320, 20);
  for (let y = 3; y < 17; y++) for (let x = 2; x < 318; x++) {
    setPixel(image, x, y, [(x * 5) & 255, (y * 17) & 255, 120, 255]);
  }
  return image;
}

export function tinySubject() {
  const image = blank(3, 4);
  setPixel(image, 1, 1, [220, 80, 100, 255]);
  setPixel(image, 1, 2, [90, 130, 220, 255]);
  return image;
}

export function flatFrame(rgb) {
  const image = blank(32, 48);
  for (let y = 4; y < 44; y++) for (let x = 5; x < 27; x++) {
    const shade = (x + y) % 2 ? 0 : 18;
    setPixel(image, x, y, [
      Math.min(255, rgb[0] + shade),
      Math.min(255, rgb[1] + shade),
      Math.min(255, rgb[2] + shade),
      255,
    ]);
  }
  return image;
}
