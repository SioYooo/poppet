# Poppet architecture and engineering notes

This document preserves the reusable design rationale that used to live in the
project README. It describes the current source tree, but it is not release or
platform-qualification evidence. Exact benchmark counts and historical local
paths are intentionally excluded because they can drift or depend on
non-redistributable inputs.

## System shape

Poppet has three runtime layers:

```text
Electron main process
  ├─ window/tray/platform lifecycle
  ├─ validated IPC and local character storage
  └─ one PetWindow per visible character
          ↓ narrow preload APIs
renderer/manager                 renderer/pet
  image decode + calibration       brain + sprite composition + canvas
          ↓                              ↑
             shared image/parts modules
```

Pet and manager renderers use `contextIsolation: true` and
`nodeIntegration: false`; preload exposes explicit APIs rather than the whole
`ipcRenderer`. The preloads currently need access to project-local channel
definitions, so Electron sandboxing is disabled. That makes main-process IPC
validation—not normal UI behavior—the security boundary.

Development capture and test controls are enabled only for an unpackaged
`--dev` run. The builder excludes `src/main/dev-capture.js`, renderer development
modules, tests, tools, source images, environment files, and common signing-key
formats. Its publish configuration is explicitly `null`, which prevents
electron-builder from inferring an updater provider from the Git remote even
when the command uses `--publish never`. A tested `afterPack` hook removes the
generic Electron camera, microphone, audio-capture, Bluetooth, and permissive
network declarations that Core does not use. `npm run verify:package` inspects the built `app.asar`, compares current
production source bytes, verifies the external Poppet license/notice files, and
rejects updater metadata; reviewing only the builder allowlist is insufficient.

## Animation from one source image

The core constraint is that Poppet may reuse only pixels present in the imported
artwork. It therefore combines three techniques:

- **Body motion uses whole-sprite deformation.** Breathing, dragging, landing,
  jumping, and walking scale, rotate, translate, or horizontally shear the
  existing sprite. Anchoring deformation near the feet avoids revealing holes
  where separated limbs would require new pixels.
- **Expressions use additive overlays.** The pipeline creates a clean patch for
  each detected eye or mouth region, covers the original feature, and composites
  a cropped or scaled version back on top. A retained outline row makes a closed
  eye read as an eyelid instead of a disappearing eye.
- **Limb motion requires artwork that was authored as limbs.** A single flat
  illustration does not contain the pixels behind an arm, nor which pixels
  occlude it, so cutting a limb out and rotating it cannot be reconstructed —
  measured on the bundled character, every infill strategy fills the vacated
  region with whichever colour borders it, and the result reads as a slab, not
  a limb. That measurement rules out *deriving* limbs from a flat image; it says
  nothing about artwork drawn as separate limbs in the first place. There are
  therefore two supported routes, and a character takes exactly one of them:
  multi-frame artwork where each pose is drawn and animation clips select the
  frames a behaviour plays, or a v3 articulated skeleton where the parts are
  drawn once and the poses are computed.

That split is also the product boundary: a character a user imports from one
pixel illustration breathes, blinks, sways, and walks by deformation, while
distributed character packs carry authored frames and can move arms and legs.
Core plays both; nothing about clip playback is withheld from free Core.

Walking combines vertical lift, landing compression, weight shift, and a
height-dependent horizontal strip offset. Canvas affine transforms cannot
express that nonlinear lower-body shear directly, so the renderer draws fixed-
height horizontal strips. Motion amplitudes scale with sprite dimensions and
the main process preserves floating-point position between integer window
updates; both choices prevent small sprites from clipping or stalling.

## Image import pipeline

The shared pipeline in `src/shared/pipeline.js` is used by the manager and
command-line asset tools:

1. Validate frame count, dimensions, per-frame pixels, total pixels, and output
   sheet width. Image headers—and GIF frame structure—are probed before full
   decode where possible, and file/data budgets are enforced at both main and
   renderer boundaries. Animated GIF import fails closed if the browser cannot
   confirm and decode all frames; it is never silently reduced to one frame.
2. Run the owned `SubjectExtractor` contract. The default adapter hardens an
   existing alpha channel or removes a flood-fillable edge background. A complex
   background is preserved and reported as `needs-advanced-extraction` rather
   than destructively guessed.
3. Keep the largest opaque component for a single frame, find the union content
   box, and crop.
4. Either retain the byte-compatible Original path or apply an explicitly
   selected deterministic low-resolution preset, then quantize to one palette
   shared by every frame. Pixelization provenance is stored in metadata.
5. Detect facial regions or apply user-calibrated rectangles.
6. Build the sprite, clean-patch atlas, icon, rig metadata, and processing
   report.

Multi-frame sprite-sheet inputs must have consistent frame dimensions. Every
frame shares one crop box and one palette to prevent position and color jitter.
Because those frames already carry their own expression, Poppet does not overlay
blink or mouth modulation on them. Animated GIF import is deliberately refused:
the decoder path accepts a GIF only when it confirms a single static frame, so
the supported multi-frame entry point is grid slicing in the Manager.

### Articulated skeletons (v3)

`metadata.skeleton` describes a bone tree whose poses the runtime *computes*
rather than replays. `src/shared/skeleton.js` owns the vocabulary, the
normalizer, the pose solver, and the parent-chain transform:

```json
"skeleton": {
  "angleStep": 15,
  "bones": [
    { "id": "pelvis", "parent": null, "pivot": {"x":9,"y":5},
      "anchor": {"x":64,"y":84}, "z": 10,
      "frame": {"sx":2,"sy":2,"sw":18,"sh":10}, "drivers": {} },
    { "id": "thighL", "parent": "pelvis", "pivot": {"x":5,"y":2},
      "anchor": {"x":5,"y":5}, "z": 16,
      "frame": {"sx":48,"sy":2,"sw":10,"sh":20},
      "drivers": { "walkSwing": 1, "dangle": 1 }, "limit": [-70, 70] }
  ]
}
```

`pivot` is the rotation centre inside the bone's own artwork; `anchor` is where
that pivot attaches, expressed in the parent's local frame; `z` is draw order.
Bone artwork lives in the existing `parts.png` atlas, so the package envelope is
unchanged.

The runtime does not know anatomy. `brain` exports a small set of **motion
signals** it was already computing — `walkSwing`, `breathe`, `dangle`, `impact`,
`wave` — and each bone declares which signals drive it and with what gain.
Mirroring a limb is a negative gain; tails, wings, and ears need no new
enumeration. Because the pose is computed, an author draws the parts once
instead of drawing every frame of every behaviour.

Three properties are load-bearing rather than incidental:

- **Angles are quantized** to `angleStep` before use. Nearest-neighbour sampling
  makes a limb that drifts a fraction of a degree per frame shimmer, and an
  unquantized angle would also give `poseDrawKey` a new value every frame,
  nullifying the measured idle frame-skip. The solver therefore emits integer
  notches, and `poseKey` turns them into the render key directly.
- **Skeletons and frame strips are mutually exclusive.** Computed limb motion
  layered on top of drawn limb motion produces two animations fighting each
  other, so `src/main/security.js` rejects metadata declaring both, and
  `isSkeletal` returns false rather than guessing.
- **Expression swaps whole parts rather than compositing overlays.** The
  `parts` overlay path addresses fixed sprite coordinates, which stop pointing
  at the face the moment the head bone moves. A bone therefore declares optional
  `expr` frames — an alternate atlas rect for `blink` and for `talk` — and the
  renderer picks one by the same `blink`/`mouthOpen` the flat path uses. The
  alternate must match the base frame's size, because `pivot` is measured
  against the base frame and a size change would make the head jump a pixel each
  blink. A bone uses one alternate at a time, `blink` before `talk`; an author
  wanting them independent parents an eyes bone and a mouth bone to the head.
  A skeleton that declares no `expr` frames simply reports no blink capability,
  the same as an illustration with no detected eyes.

Because a raised arm reaches outside the bind-pose bounding box, `sprite.width`
and `sprite.height` must be declared with headroom for the widest pose.

The Manager can edit an existing rig: opening a saved skeletal character shows a
bone list, the per-bone pivot/anchor/parent/z/driver fields, and a preview that
renders the skeleton under a chosen test signal, which is the only way to tell
whether a gain is right — the numbers alone do not show it. Clicking the preview
selects the bone under the cursor, and in pivot mode it moves the rotation centre
by translating `pivot` and `anchor` together, so the artwork does not shift.
Saving reuses `lib:update-meta`, whose write path already validates the merged
metadata through `assertSkeleton`; the editor adds no new privileged channel and
refuses to attach a rig to a character that never had one, since such a
character has no bone atlas for the frames to point into.

### Animation clips

`metadata.frames.clips` maps a behaviour name to an inclusive frame range, so a
strip can hold a walk cycle, an idle loop, and a wave without the runtime
cycling through all of them indiscriminately:

```json
"frames": { "count": 20, "fps": 12,
            "clips": { "idle": [0, 3], "walk": [4, 11], "greet": [12, 19] } }
```

`src/shared/parts.js` owns the vocabulary. Clip names are exactly the behaviour
state names the renderer asks for, so no translation table sits between them and
`brain.state`; the resolution order is exact match, then `idle`, then the whole
strip. A character with no `clips` therefore behaves exactly as before, and an
author who draws only an idle loop still gets a valid character.

Ranges are validated fail-closed at both metadata boundaries in
`src/main/security.js`: an out-of-range clip would make the renderer request a
frame that does not exist. At runtime the same rules only discard the offending
entry, because that path is per-frame and the import boundary has already
rejected the shape. `src/main/security.js` keeps its own copy of the clip names
because the main process is CommonJS and `src/shared/` is ESM; a test asserts the
two lists stay identical.

Import limits are defense in depth, not a promise that arbitrary images are
safe or fast. Processing can be cancelled/timed out by the manager—including
inside subject and face analysis—and
`buildCharacter` repeats the decisive budgets instead of trusting decoded
renderer input.

## Face and part model

Face detection works from local color-difference regions rather than fixed skin,
eye, or mouth colors. It first ranks compact upper-body surfaces as possible
faces, then segments contrast regions inside each surface. Eye-pair scoring uses
alignment, relative position, spacing, a non-monotonic size prior, face quality,
and supporting mouth evidence; raw area alone cannot win. Nested regions on both
sides provide explicit eyewear evidence: visible inner eyes can win over lenses
or frames, while an opaque pair with no visible eyes is rejected instead of
being animated. Close rivals reduce the heuristic detection score, and unsafe or
low-scoring input degrades to no automatic blink. Mouth candidates are evaluated as openings below
the selected eyes. Automatic detection remains correctable in the manager.

Parts are stored as a role-tagged array:

```json
{
  "role": "eye",
  "id": "eye0",
  "source": "auto",
  "src": { "x": 10, "y": 20, "w": 8, "h": 6 },
  "frame": { "sx": 0, "sy": 0, "sw": 12, "sh": 10 },
  "cleanFrame": { "sx": 12, "sy": 0, "sw": 12, "sh": 10 }
}
```

- `role` selects a runtime capability such as blink or mouth movement without
  requiring exactly two eyes.
- `id` remains stable because atlas frames and eyelid row data use it as a key.
- `source` distinguishes a human-drawn calibration from an automatic result, so
  reprocessing does not silently overwrite user intent.
- `src` is the unpadded original rectangle; runtime frame rectangles include the
  mask padding. Feeding the padded rectangle back into calibration would grow a
  part on every reprocess.

`normalizeParts()` reads the current role array and earlier `eyes` or
`eyeL`/`eyeR` shapes, choosing by structure rather than trusting a version field.
Multi-frame capability negotiation disables expression overlays even if old
metadata contains facial parts.

Outline protrusion detection can nominate appendage-like regions, but its output
lives in `meta.suggestions`, never directly in runtime `parts`. Real artwork
showed that position and orientation cannot reliably distinguish tails, ears,
wings, clothing edges, and legs. The product rule is therefore
**candidate + visible human confirmation**, not automatic semantic naming.

## Conservative rig inference

Poppet infers only properties with a defensible signal:

- a single or strongly off-centre eye configuration disables horizontal
  direction flipping;
- very wide art disables lower-body sway.

Standing, floating, and idle behavior otherwise remain user choices. A dense
lower edge was tested as a floating/standing signal and rejected: robes and
wave-shaped floating silhouettes make it ambiguous. When a heuristic cannot
separate real forms, the UI asks rather than manufacturing certainty.

## Window, input, and multi-pet behavior

Each visible character owns a `PetWindow`. IPC that originates in a pet renderer
is routed back through `event.sender`; a single global “active pet” would make an
action in one window move another. Saved positions are likewise per character.

The main process owns screen coordinates and clamps each window to the nearest
display work area. It stores floating-point position internally and rounds only
when calling Electron, so sub-pixel motion accumulates instead of disappearing.
Default multi-pet offsets are applied after clamping to avoid stacking pets at a
screen edge.

Click-through is based on the alpha of the already-rendered canvas, which
naturally includes breathing, rotation, and flipping. Electron receives
`setIgnoreMouseEvents(..., { forward: true })`; forwarding is necessary so the
renderer can notice when the pointer re-enters an opaque pixel. Interactive
state starts as unknown rather than `false`, ensuring the first transition
actually configures the native window.

Dragging is driven by main-process cursor polling. A renderer mousemove becomes
unreliable while the whole window follows the cursor, and native draggable
regions can lose a fast throw. The main process sends cursor motion back to the
renderer for pose feedback and clamps the final drop position.

## Persistence and recovery

All renderer-supplied IDs, settings, metadata, and file payloads are validated in
the main process. Character paths use a safe child resolver and reject unsafe
IDs, traversal, symbolic-link directories, unknown filenames, and excessive
payloads.

Settings and metadata use durable temporary writes, file/directory sync, atomic
rename, and backup recovery. Character import first writes and validates an
owned `.staging/<uuid>` directory, then atomically renames it into the library.
Deletion moves a character into an application-owned trash directory instead of
recursively deleting its live directory. Built-in seeding follows the same
staging/publish discipline.

Create success is stronger than persistence alone. After the durable publish,
the main process loads the exact saved character into its `PetWindow` and waits
for both a visible window and that renderer's trusted, no-argument acknowledgement
that it has drawn a first non-empty frame. Only then does the Manager report
success. Load, timeout, destroy, or roster-sync failure returns a stable
`POPPET_*` cause while retaining the saved character ID, so the Manager can retry
persistence finalization or activation without importing a duplicate.

These mechanisms have local regression coverage. They reduce partial-write and
path-boundary failure modes, but do not replace real crash, disk-full, upgrade,
and native-user qualification.

## Testing and diagnostics

Useful commands are intentionally split by evidence type:

```bash
npm test              # portable source, pipeline, packaging-policy, and security tests
npm run test:extraction  # subject-extractor contract and pipeline integration
npm run test:pixelize    # deterministic pixelizer and manager wiring
npm run test:persistence # atomic storage and library recovery boundaries
npm run test:studio      # disabled future-provider contract
npm run survey        # synthetic morphology survey; diagnostic, not real-world coverage proof
npm run test:click    # inject real mouse events into an unpackaged dev run
npm run test:multi    # verify that actions route to the correct pet window
npm run verify        # render expression frames for visual inspection
npm run demo          # exercise actions and save development screenshots
npm run verify:package  # inspect an actual packaged app.asar
```

Transparent-window interaction tests should use isolated temporary user-data
directories so Electron's single-instance lock cannot collide with a running
personal copy. State-machine commands alone are weak interaction evidence:
click/drag regressions require actual input events, and render pacing needs frame
sampling that begins before an action transition.

Synthetic fixtures deliberately cover forms such as one-eyed, side-facing,
floating, quadruped, wide, tiny, and faceless characters, plus independent inner
ears, thick and thin glasses, tinted lenses, opaque sunglasses, and eye
highlights. Face tests assert spatial overlap with semantic eye boxes and reject
known distractor regions; merely returning the expected number of parts is not
enough. These fixtures lock down known shape assumptions but do not represent
the distribution of real user art. Downloaded external corpora are optional
research inputs and are neither committed nor packaged.

## Known limitations

- Complex backgrounds are not general-purpose segmentation; remove them first.
- Very small faces may have too few pixels for automatic feature detection;
  manual calibration remains necessary.
- Fully opaque glasses provide no pixels from which to infer the hidden eyes, so
  Poppet intentionally leaves blink disabled. For visible eyes behind glasses,
  manual rectangles should stay inside the frame: every pixel inside a manual
  eye rectangle participates in the blink overlay. The manager's blink preview
  is the final check before saving.
- Multi-frame inputs do not receive extra blink or mouth overlays.
- Animation of a single imported illustration deforms the whole sprite rather
  than separating limbs. Appendage detection produces suggestions, not
  independently animated parts, and there is no automatic route from one flat
  image to a pivoted bone tree: a v3 skeleton is authored, not detected.
- Sprite-sheet rows and columns are entered manually; grid detection is not a
  release feature.
- Non-integer Windows display scaling may make nearest-neighbor pixel sizes look
  uneven and still needs real-device qualification.

Distribution and publication gates live in
[`.github/release-policy.json`](../.github/release-policy.json) and
[`.github/workflows/release.yml`](../.github/workflows/release.yml).
