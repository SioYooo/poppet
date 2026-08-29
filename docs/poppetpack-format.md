# `.poppetpack` v1 format and threat model

Status: `V1_IMPLEMENTED` (importer + exporter, 2026-08-21)

This document defines the versioned exchange boundary for Poppet character
packages. Version 1 is implemented in `src/main/zip.js` (bounded fail-closed
archive layer) and `src/main/pack.js` (manifest/budget validation and payload
assembly), wired through the Manager. One deliberate strengthening relative to
the original draft sequence: extracted bytes are validated entirely in memory
and never touch disk until they pass the normal import boundary
(`validateImportPayload` -> `importCharacter`), whose own staging directory and
atomic rename provide the staged, durable publication step. There is no
intermediate extraction directory to attack or swap. Export refuses the
built-in brand character (`LicenseRef-Poppet-Scoped-Artwork` forbids standalone
extraction) and writes via temp file + fsync + rename.

## Version 1 layout

A v1 package is a ZIP archive containing only these normalized UTF-8 paths:

```text
manifest.json
character/character.json
character/pet.png
character/icon.png
character/parts.png          # present exactly when metadata declares an atlas
```

No other entry, directory entry, nested archive, link, device, encrypted entry,
or executable content is allowed. ZIP methods are limited to Store and Deflate.
All names use `/`, Unicode NFC, and the exact lower-case spelling above.

`manifest.json` is UTF-8 JSON with no BOM and this closed shape:

```json
{
  "format": "poppetpack",
  "version": 1,
  "files": [
    { "path": "character/character.json", "bytes": 1234, "sha256": "64 lowercase hex characters" }
  ]
}
```

The file list is sorted by path and covers every non-manifest regular entry
exactly once. `bytes` is the uncompressed byte count. Hashes cover exact stored
file bytes. Unknown manifest fields, missing entries, duplicate paths, duplicate
JSON keys, non-integer sizes, and unsupported versions fail closed.

## Hard ceilings

The implementation centralizes these ceilings with Core's existing import
limits rather than duplicating magic numbers:

| Budget | Maximum |
| --- | ---: |
| Archive bytes before parse | 32 MiB |
| Entries including manifest | 5 |
| Total uncompressed bytes | 48 MiB |
| Any PNG | 20 MiB |
| `character.json` | 2 MiB |
| `manifest.json` | 64 KiB |
| Expansion ratio, total or per entry | 100:1 |

Decoded PNG dimensions, frame/atlas consistency, total working pixels, icon
dimensions, metadata schema, and character compatibility still pass the normal
Core validators. Archive byte limits do not replace image-decode budgets.

## Required import sequence

```text
bounded regular-file read (O_NOFOLLOW, size-checked before allocation)
  -> central-directory and entry-name validation
  -> budget and collision validation before any extraction
  -> in-memory extraction with mid-stream output budgets
  -> per-entry CRC and manifest SHA-256 / exact-size verification
  -> reject links, unknown entries, and manifest mismatches
  -> validate PNG headers and character metadata
  -> hand owned bytes to the normal import boundary
     (validateImportPayload -> importCharacter: staging dir, durable write,
      atomic rename)
```

Extracted bytes never exist on disk outside the import boundary's own staging
directory, so there is no intermediate extraction directory to attack, swap,
or clean up. The v1 budgets (48 MiB total ceiling) are what make full
in-memory extraction safe.

Path validation rejects absolute paths, drive/UNC prefixes, `.`/`..`, empty
segments, backslashes, control characters, trailing dot/space aliases, and a
collision after Unicode normalization plus ASCII case folding. Extraction must
never follow links and must not write outside the fresh staging directory.
Failure preserves the user's original package and rejects it atomically; a
diagnostic is logged in development builds only, and no partial state is left
behind (in-memory extraction has no stage to clean).

Export must snapshot already-validated local bytes, write to a sibling temporary
file, sync, and rename. It must not include source artwork, settings, absolute
paths, timestamps that break reproducibility, user identifiers, credentials,
logs, Studio job data, or undeclared files.

## Animation clips

`character/character.json` may declare `frames.clips`, an inclusive frame range
per behaviour:

```json
"frames": { "count": 20, "fps": 12,
            "clips": { "idle": [0, 3], "walk": [4, 11], "greet": [12, 19] } }
```

This is one of the two ways a distributed pack moves arms and legs: each pose is
drawn into the strip rather than inferred from a flat illustration, and the clip
tells the runtime which frames a behaviour plays. The other is an articulated
skeleton (below); a pack uses exactly one of them. Names are the closed set owned by
`src/shared/parts.js` (`idle`, `walk`, `drag`, `greet`) and resolve exact match
-> `idle` -> whole strip, so a pack that labels only an idle loop is valid and a
pack with no `clips` behaves exactly as v1 always did.

The envelope does not change: the frame strip is `character/pet.png` and the
clip table is metadata, so clips need no new entry and no version bump. Ranges
must fall inside `frames.count`; both metadata validators reject an out-of-range
or unknown clip fail-closed, because such a range would make the renderer
request a frame that does not exist.

Clip playback is part of free Core. A pack must stay importable and playable
without a paid runtime.

## Articulated skeletons

`character/character.json` may instead declare `skeleton`, a bone tree whose
poses the runtime computes from the behaviour state. Such a character sets
`schemaVersion` to `3`; `schemaVersion` and the presence of `skeleton` are
mutually implying, so there is no "v3 without a rig" or "v2 with a rig" state
for a reader to interpret.

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

Bone artwork lives in the existing `character/parts.png`, so **the envelope does
not change**: no new entry, no manifest field, no version bump — the same
property that let clips ship. `character/pet.png` still carries the bind pose as
a flat sprite, which is what the Manager thumbnail and any reader without
skeleton support will show.

Rules a pack must satisfy, all enforced fail-closed by both metadata validators
in `src/main/security.js`:

- exactly one root bone (`parent: null`); every other `parent` must name a bone
  in the same table; no cycles; depth at most 8; at most 64 bones;
- `angleStep` an integer in 1..90; every bone `frame` inside the declared
  `atlas` bounds; every `pivot` inside its own bone frame;
- driver names from the closed set owned by `src/shared/skeleton.js`
  (`walkSwing`, `breathe`, `dangle`, `impact`, `wave`) with gains in -2..2;
- optional `expr` frames keyed only by `blink` or `talk`, each inside the atlas
  and **the same size as the bone's base frame** — `pivot` is measured against
  the base frame, so a differently sized alternate would jog the part a pixel
  every time the expression changed;
- `skeleton` and a multi-frame `frames.count` must not both appear.

Authoring notes:

- declare `sprite.width`/`sprite.height` with headroom — a raised arm reaches
  outside the bind-pose bounding box and would otherwise be clipped;
- draw hidden overlap at every joint: the pixels covered in the bind pose that
  a rotation exposes;
- expression is a whole-part swap, not an overlay: give the head bone an `expr`
  entry with a closed-eye frame and, if it should talk, an open-mouth one. A
  bone shows one alternate at a time (`blink` wins over `talk`), so eyes and
  mouth that must move independently belong on two bones parented to the head.
  A pack that declares no `expr` frames simply does not blink.

`tools/rig-from-aseprite.mjs` merges an Aseprite `--split-layers --data` export
with an authored topology file, and `tools/make-rig-demo.mjs` emits a complete
16-bone example pack. As with clips, the playback runtime is free Core: a pack
sells artwork, never the player.

## Compatibility and trust

The manifest version controls only the archive envelope. Character metadata
continues to normalize v0/v1/v2 structures through `src/shared/parts.js`.
Importers reject unknown envelope versions; future versions need fixtures for
old readers and an explicit migration policy.

Packages are untrusted data, not plugins. A SHA-256 digest proves integrity
against the manifest, not authorship. Signing, marketplace identity, remote
fetching, Studio delivery, and public package distribution are separate future
decisions.

## Offline diagnosis

`node tools/inspect-pack.mjs [--json] <file.poppetpack>` runs the same bounded
read -> `parsePoppetpack` -> `validateImportPayload` chain as the application
against a package on disk, prints manifest fields, per-entry sizes and SHA-256
digests, and budget usage versus `PACK_LIMITS`, and exits non-zero with the
stable `POPPET_*` code on rejection. It never writes files, never extracts to
disk, and never touches the network.
