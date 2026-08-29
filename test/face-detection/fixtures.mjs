// Deterministic, code-generated fixtures for semantic face detection tests.
// No pixels are copied from user artwork. All expected boxes use the input
// image coordinate system consumed by detectFace().

const SKIN = [232, 211, 190];
const INK = [18, 20, 28];
const LIP = [205, 58, 72];
const HAIR = [82, 54, 38];
const CLOTH = [45, 76, 145];
const FRAME = [45, 50, 68];

export function blank(width, height) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function rect(image, x, y, width, height, color, alpha = 255) {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(image.width, Math.ceil(x + width));
  const y1 = Math.min(image.height, Math.ceil(y + height));
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      const offset = (yy * image.width + xx) * 4;
      image.data[offset] = color[0];
      image.data[offset + 1] = color[1];
      image.data[offset + 2] = color[2];
      image.data[offset + 3] = alpha;
    }
  }
}

export function ellipse(image, cx, cy, radiusX, radiusY, color, alpha = 255) {
  for (let y = Math.max(0, Math.floor(cy - radiusY)); y <= Math.min(image.height - 1, Math.ceil(cy + radiusY)); y++) {
    for (let x = Math.max(0, Math.floor(cx - radiusX)); x <= Math.min(image.width - 1, Math.ceil(cx + radiusX)); x++) {
      const dx = (x - cx) / radiusX;
      const dy = (y - cy) / radiusY;
      if (dx * dx + dy * dy <= 1) rect(image, x, y, 1, 1, color, alpha);
    }
  }
}

function strokeRect(image, x, y, width, height, thickness, color) {
  rect(image, x, y, width, thickness, color);
  rect(image, x, y + height - thickness, width, thickness, color);
  rect(image, x, y + thickness, thickness, height - thickness * 2, color);
  rect(image, x + width - thickness, y + thickness, thickness, height - thickness * 2, color);
}

function box(x, y, w, h) {
  return { x, y, w, h };
}

function portraitBase({ ears = false } = {}) {
  const image = blank(120, 160);
  rect(image, 35, 119, 50, 37, CLOTH);
  rect(image, 54, 108, 12, 18, SKIN);
  rect(image, 25, 30, 70, 83, SKIN);
  rect(image, 23, 24, 74, 13, HAIR);

  if (ears) {
    // The outer ears are connected to the same skin host as the face. Their
    // symmetric inner blocks are intentionally larger than the true eyes: this
    // is the exact structural trap that previously won the area-based score.
    rect(image, 12, 48, 18, 35, SKIN);
    rect(image, 90, 48, 18, 35, SKIN);
    rect(image, 16, 53, 10, 17, [220, 133, 137]);
    rect(image, 94, 53, 10, 17, [220, 133, 137]);
  }

  rect(image, 42, 67, 8, 10, INK);
  rect(image, 70, 67, 8, 10, INK);
  rect(image, 56, 91, 9, 5, LIP);
  return image;
}

function portraitTruth(name, image, extras = {}) {
  return {
    name,
    image,
    eyes: [box(42, 67, 8, 10), box(70, 67, 8, 10)],
    ...extras,
  };
}

export function canonicalPortrait() {
  return portraitTruth('existing canonical two-eye portrait', portraitBase());
}

export function innerEarTrap() {
  return portraitTruth('independent inner-ear blocks are not eyes', portraitBase({ ears: true }), {
    forbidden: [box(16, 53, 10, 17), box(94, 53, 10, 17)],
  });
}

export function mouthlessInnerEarTrap() {
  const fixture = innerEarTrap();
  rect(fixture.image, 56, 91, 9, 5, SKIN);
  return {
    ...fixture,
    name: 'mouthless face still rejects symmetric inner ears',
  };
}

export function thickFrames() {
  const image = portraitBase();
  // Redraw a skin patch before adding glasses so the fixture has exactly one
  // semantic eye per side under a thick, fully enclosing frame.
  rect(image, 36, 59, 49, 27, SKIN);
  strokeRect(image, 37, 60, 20, 23, 3, FRAME);
  strokeRect(image, 64, 60, 20, 23, 3, FRAME);
  rect(image, 56, 68, 9, 3, FRAME); // bridge
  rect(image, 43, 67, 8, 10, INK);
  rect(image, 70, 67, 8, 10, INK);
  return {
    name: 'thick frames preserve the true eyes',
    image,
    eyes: [box(43, 67, 8, 10), box(70, 67, 8, 10)],
  };
}

export function tintedLenses() {
  const image = portraitBase();
  rect(image, 36, 59, 49, 27, SKIN);
  strokeRect(image, 37, 60, 20, 23, 2, FRAME);
  strokeRect(image, 64, 60, 20, 23, 2, FRAME);
  rect(image, 56, 68, 9, 2, FRAME);
  rect(image, 39, 62, 16, 19, [126, 164, 186]);
  rect(image, 66, 62, 16, 19, [126, 164, 186]);
  rect(image, 43, 67, 8, 10, INK);
  rect(image, 70, 67, 8, 10, INK);
  return {
    name: 'tinted lenses do not replace visible eyes',
    image,
    eyes: [box(43, 67, 8, 10), box(70, 67, 8, 10)],
  };
}

export function thinBridgeFrames() {
  const image = portraitBase();
  rect(image, 36, 59, 49, 27, SKIN);
  strokeRect(image, 38, 61, 18, 21, 1, FRAME);
  strokeRect(image, 65, 61, 18, 21, 1, FRAME);
  rect(image, 55, 68, 11, 1, FRAME);
  rect(image, 43, 67, 8, 10, INK);
  rect(image, 70, 67, 8, 10, INK);
  return {
    name: 'thin frames and bridge preserve the true eyes',
    image,
    eyes: [box(43, 67, 8, 10), box(70, 67, 8, 10)],
  };
}

export function opaqueSunglasses() {
  const image = portraitBase();
  rect(image, 36, 59, 49, 27, SKIN);
  rect(image, 37, 61, 20, 20, [20, 23, 31]);
  rect(image, 64, 61, 20, 20, [20, 23, 31]);
  rect(image, 56, 67, 9, 4, [20, 23, 31]);
  // No visible eye pixels exist. Guessing a lens as an animatable eye would
  // erase/move the glasses during a blink, so the only safe answer is no eyes.
  return {
    name: 'opaque sunglasses without visible eyes degrade safely',
    image,
    eyes: [],
  };
}

export function separatedOpaqueLenses() {
  const image = opaqueSunglasses().image;
  // Removing the bridge leaves two perfect, symmetric 20px-class blobs. They
  // still carry no visible eye evidence and must not be animated as eyes.
  rect(image, 56, 67, 9, 4, SKIN);
  return {
    name: 'two opaque lenses without a bridge degrade safely',
    image,
    eyes: [],
  };
}

export function lightOpaqueLenses() {
  const image = separatedOpaqueLenses().image;
  rect(image, 37, 61, 20, 20, [245, 245, 245]);
  rect(image, 64, 61, 20, 20, [245, 245, 245]);
  return {
    name: 'two light opaque lenses without visible eyes degrade safely',
    image,
    eyes: [],
  };
}

export function cyanOpaqueLenses() {
  const image = separatedOpaqueLenses().image;
  rect(image, 37, 61, 20, 20, [160, 220, 240]);
  rect(image, 64, 61, 20, 20, [160, 220, 240]);
  return {
    name: 'two cyan opaque lenses without visible eyes degrade safely',
    image,
    eyes: [],
  };
}

export function robotLightEyes() {
  const image = blank(56, 88);
  rect(image, 14, 6, 28, 26, [170, 175, 185]);
  rect(image, 20, 32, 16, 6, [120, 125, 135]);
  rect(image, 10, 38, 36, 32, [140, 145, 160]);
  rect(image, 14, 70, 10, 16, [110, 115, 125]);
  rect(image, 32, 70, 10, 16, [110, 115, 125]);
  rect(image, 19, 14, 7, 7, [80, 220, 255]);
  rect(image, 31, 14, 7, 7, [80, 220, 255]);
  rect(image, 22, 25, 12, 3, [60, 60, 70]);
  return {
    name: 'robot retains its legitimate light cyan eyes',
    image,
    eyes: [box(19, 14, 7, 7), box(31, 14, 7, 7)],
  };
}

export function doubleHighlights() {
  const image = portraitBase();
  rect(image, 39, 63, 14, 17, INK);
  rect(image, 68, 63, 14, 17, INK);
  // Each 4x4 highlight independently clears the detector's minimum-region
  // threshold. A detector that merely rewards small symmetric pairs can pick
  // these four glints instead of their containing eyes.
  for (const x of [40, 47, 69, 76]) rect(image, x, 65, 4, 4, [250, 250, 246]);
  return {
    name: 'paired highlights do not replace the containing eyes',
    image,
    eyes: [box(39, 63, 14, 17), box(68, 63, 14, 17)],
  };
}

export function profileEye() {
  const image = blank(92, 150);
  rect(image, 30, 116, 38, 30, CLOTH);
  rect(image, 22, 28, 58, 88, SKIN);
  rect(image, 18, 22, 56, 16, HAIR);
  rect(image, 22, 35, 13, 62, HAIR);
  rect(image, 60, 65, 9, 12, INK);
  rect(image, 71, 91, 7, 4, LIP);
  return {
    name: 'profile with one visible eye',
    image,
    eyes: [box(60, 65, 9, 12)],
  };
}

export function profileWithInnerEar() {
  const fixture = profileEye();
  rect(fixture.image, 25, 49, 9, 18, [220, 133, 137]);
  return {
    ...fixture,
    name: 'profile eye is not paired with an inner-ear block',
    forbidden: [box(25, 49, 9, 18)],
  };
}

export function legalWideEyes() {
  const image = portraitBase();
  rect(image, 42, 67, 8, 10, SKIN);
  rect(image, 70, 67, 8, 10, SKIN);
  rect(image, 34, 67, 16, 8, INK);
  rect(image, 70, 67, 16, 8, INK);
  return {
    name: 'legitimate wide eyes remain semantic eyes',
    image,
    eyes: [box(34, 67, 16, 8), box(70, 67, 16, 8)],
  };
}

export function tiltedEyes() {
  const image = portraitBase();
  rect(image, 70, 67, 8, 10, SKIN);
  rect(image, 70, 75, 8, 10, INK);
  return {
    name: 'mildly tilted eye line remains a two-eye face',
    image,
    eyes: [box(42, 67, 8, 10), box(70, 75, 8, 10)],
  };
}

export function wideHorizontalFace() {
  const image = blank(120, 48);
  rect(image, 10, 14, 100, 28, [220, 120, 140]);
  rect(image, 26, 21, 16, 6, INK);
  rect(image, 76, 21, 16, 6, INK);
  rect(image, 52, 34, 14, 4, LIP);
  return {
    name: 'wide horizontal face retains its real wide eyes',
    image,
    eyes: [box(26, 21, 16, 6), box(76, 21, 16, 6)],
  };
}

export function compactMouthOnly() {
  const image = portraitBase();
  rect(image, 42, 67, 8, 10, SKIN);
  rect(image, 70, 67, 8, 10, SKIN);
  rect(image, 56, 91, 9, 5, SKIN);
  rect(image, 56, 78, 9, 7, LIP);
  return {
    name: 'compact mouth without eyes is not a single eye',
    image,
    eyes: [],
  };
}

export function candidateExplosion() {
  const image = blank(400, 400);
  rect(image, 25, 25, 350, 350, [220, 200, 180]);
  const colors = [[20, 20, 30], [45, 25, 55], [20, 45, 55]];
  let count = 0;
  for (let y = 70; y <= 214; y += 16) {
    for (let x = 50; x <= 338; x += 16) {
      rect(image, x, y, 14, 14, colors[count % colors.length]);
      count++;
    }
  }
  return { image, candidateCount: count };
}

export function cyclopsEye() {
  const image = blank(96, 128);
  ellipse(image, 48, 61, 36, 49, [139, 198, 123]);
  ellipse(image, 48, 55, 15, 17, [246, 245, 237]);
  ellipse(image, 48, 55, 8, 10, INK);
  rect(image, 39, 89, 18, 5, INK);
  return {
    name: 'cyclops with one semantic eye',
    image,
    // The whole visible eye, not merely the inner pupil, is the blink region.
    eyes: [box(33, 38, 31, 35)],
  };
}

export const FACE_CASES = [
  canonicalPortrait,
  innerEarTrap,
  mouthlessInnerEarTrap,
  thickFrames,
  tintedLenses,
  thinBridgeFrames,
  opaqueSunglasses,
  separatedOpaqueLenses,
  lightOpaqueLenses,
  cyanOpaqueLenses,
  robotLightEyes,
  doubleHighlights,
  profileEye,
  profileWithInnerEar,
  cyclopsEye,
  legalWideEyes,
  tiltedEyes,
  wideHorizontalFace,
  compactMouthOnly,
];
