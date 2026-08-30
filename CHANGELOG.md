# Changelog

All notable user-facing changes will be recorded here. This project follows
semantic versioning for published tags and uses explicit prerelease suffixes for
alpha, beta, and release-candidate builds.

## 0.1.0-alpha.1 — published (prerelease, 2026-08-29)

Tag: [`v0.1.0-alpha.1`](https://github.com/SioYooo/poppet/releases/tag/v0.1.0-alpha.1).
Unsigned controlled alpha built and verified by the release workflow
(cross-platform manifests + SHA-256 before the protected publish).

### Added

- Articulated skeletons for distributed character packs (`schemaVersion` 3,
  `metadata.skeleton`). A pack may now carry a bone tree — parent, pivot,
  anchor, draw order, atlas frame — instead of a frame strip, and the runtime
  *computes* each pose rather than replaying drawn ones. The behaviour engine
  already produced the motion it needed (walk phase, breathing, hanging,
  landing impact, greeting), so those became named signals (`walkSwing`,
  `breathe`, `dangle`, `impact`, `wave`) that each bone subscribes to with a
  signed gain; mirroring a limb is a negative gain, which is why tails, wings,
  and ears need no new vocabulary. The practical difference from clips is where
  the work goes: an author draws the parts once and gets every behaviour,
  instead of drawing every frame of every behaviour.

  Joint angles quantize to a declared `angleStep` before use. That is not a
  stylistic choice — under nearest-neighbour sampling a limb drifting a
  fraction of a degree per frame shimmers, and an unquantized angle would hand
  the frame-skip policy a new key every frame, cancelling the measured idle
  saving. Skeletons and multi-frame strips are mutually exclusive and rejected
  fail-closed when both appear, because computed limb motion layered over drawn
  limb motion is two animations fighting. A skeletal character has no
  procedural blink or mouth, exactly as a multi-frame one does not: the
  expression overlay addresses fixed sprite coordinates that a moving head no
  longer occupies.

  Expression for a rigged character is a whole-part swap rather than an overlay:
  a bone may carry alternate atlas frames for `blink` and `talk`, and the
  renderer picks one from the same values the flat path uses. The alternate must
  match the base frame's size, because the pivot is measured against the base
  frame and a size change would jog the head a pixel on every blink. This is why
  a rigged character blinks and talks at all — the old overlay addresses fixed
  sprite coordinates that a moving head stops occupying.

  The Manager can edit an existing rig: a bone list, per-bone pivot / anchor /
  parent / draw order / driver gains, and a preview rendered under a chosen test
  signal, which is the only way to tell whether a gain is right. Clicking the
  preview selects the bone under the cursor; in pivot mode it moves the rotation
  centre without shifting the artwork, by translating the pivot and the anchor
  together. Saving reuses the existing metadata-update channel, whose write path
  already validates the merged result, so the editor adds no new privileged
  surface — and it refuses to attach a rig to a character that never had one,
  since such a character has no bone atlas for the frames to point into.

  The `.poppetpack` envelope is unchanged — bone artwork lives in the existing
  `parts.png`, so no new entry, no manifest field, and no version bump. Playback
  ships in free Core: a pack sells artwork, never the player. `tools/` gained a
  converter from an Aseprite `--split-layers` export plus an authored topology
  file, and a generator that emits a complete 16-bone example pack with a pose
  contact sheet. There is still no automatic route from a flat illustration to a
  bone tree; a skeleton is authored, not detected, and the editor edits rather
  than creates.

- Animation clips for multi-frame characters: `metadata.frames.clips` maps a
  behaviour name to an inclusive frame range (`{"idle":[0,3],"walk":[4,11],
  "greet":[12,19]}`), so a strip plays its walk frames while walking instead of
  cycling every frame regardless of what the pet is doing. Clip names are
  exactly the renderer's behaviour-state names, so nothing translates between
  them, and resolution falls back exact match -> `idle` -> whole strip: a
  character with no clips behaves exactly as before, and an author who draws
  only an idle loop still gets a valid character. Ranges are validated
  fail-closed at both metadata boundaries, because an out-of-range clip would
  make the renderer request a frame that does not exist. The Manager gained
  range fields for the four clips after a sheet is sliced; re-slicing clears
  them, since a new frame count no longer points at the same drawings. The
  `.poppetpack` envelope is unchanged — the strip is already `pet.png` and the
  clip table is metadata — so no version bump and no new archive entry.
  This is what lets a distributed character pack move arms and legs: each pose
  is drawn rather than inferred. A single flat illustration cannot do this, and
  the repository now says so plainly instead of leaving it implied — the pixels
  behind a limb and the order of what occludes it are absent, and every infill
  strategy measured on the bundled character fills the vacated region with a
  neighbouring colour, reading as a slab rather than a limb. Clip playback is
  part of free Core; a pack sells artwork, not the player.

- Display hot-unplug rescue: when a display is removed or its metrics change,
  every live pet is re-clamped onto the nearest visible work area (100 ms
  debounce, the existing `clampToDisplay()` semantics, one `persistPets()`
  afterwards), so the tray "都回到屏幕右下角" action is no longer the only
  recovery for a pet stranded on a vanished screen.
- Developer tooling, not part of the packaged app: `npm run dev:isolated`
  runs an interactive session on a throwaway temporary profile that never
  touches the real user-data directory (the legacy-profile guard is bypassed
  only by isolation, never weakened); `npm run test:file -- <file>` runs a
  single test file through the shared runner with directory semantics
  unchanged; `npm run preflight:release` replays the release workflow's
  validate gates locally and prints what local evidence cannot prove;
  `npm run inspect:pack -- [--json] <file>` is a read-only offline
  `.poppetpack` diagnoser that runs the app's exact import chain and reports
  sizes, digests, budget usage, and the stable error code; a new
  `test/tooling` suite covers these runners and is part of `npm test`.
- CI caches the Electron and electron-builder downloads across jobs
  (`actions/cache` pinned to a full commit SHA); `release.yml` deliberately
  keeps fresh, checksum-verified downloads.
- `.poppetpack` v1 character-package import/export: a bounded, fail-closed ZIP
  boundary (size/entry/hash/expansion budgets, local/central-header consistency,
  duplicate-JSON-key rejection), in-memory extraction through the normal import
  boundary, atomic export, Manager buttons, and a refusal to export the
  built-in brand character.
- A frame-rate setting (30/45/60 fps presets, custom 8–120 via settings.json)
  exposed in the Manager and applied to running pets immediately.
- Visible error dialogs on previously silent fatal paths: startup failure,
  legacy-profile-busy refusal, and the first-frame watchdog now opens the
  Manager when it reclaims the last pet.
- Release readiness now rejects any inventoried PNG that embeds a C2PA (caBX)
  manifest while its provenance record does not disclose generative-AI origin.
- A Windows CI smoke job running the end-to-end Electron manager regression
  (first hosted run passed on PR #8, CI run 32497570574 on 82239a3,
  2026-08-21; every later change needs its own run).
- Battery/memory improvements: pet renderers pause completely (zero wakeups)
  while the screen is locked or the system suspends, resuming fail-open on
  unlock/resume; the Manager frees up to ~128 MiB of full-resolution source
  pixels as soon as a character is durably saved; main-process settings reads
  are cached instead of hitting disk on hover-adjacent paths.
- The performance harness now samples GPU and utility processes (previously
  ~100–200 MiB of invisible footprint) and carries a skipped-frame counter for
  future render-on-demand comparisons (probe identity v4, harness v3).
- Render-on-demand: frames whose quantized pose is pixel-identical to the last
  drawn frame are skipped (measured: idle draws fall from 60/s to ~11/s, an
  ~81% skip rate, with pacing and first-frame acknowledgement unaffected), and
  a conservative idle frame-rate tier engages during true quiescence; both
  mechanisms always fail toward drawing and never run before the first-frame
  acknowledgement.
- Pre-release convenience batch: right-clicking a pet now pops the full menu
  at the cursor (it previously anchored to the tray icon at the top of the
  macOS screen); a one-time first-run moment opens the Manager and has the pet
  greet; a launch-at-login toggle (tray + Manager, system login item as the
  single source of truth, packaged builds only); a meeting-mode tray switch
  that hides and pauses every pet at once; an About dialog with the version
  and a copy-diagnostics button; Cmd+W/Cmd+Q now work in the Manager on
  macOS; .poppetpack files can be dropped straight onto the Manager (path
  handed to the main process, bytes never cross renderer IPC), and rejected
  drops now explain why instead of being silently ignored; Manager status
  titles and the success moment are now fully Chinese with next-step guidance.
- The manager smoke now includes a .poppetpack export -> path-import
  byte-identical round-trip scenario, closing the pack-IPC coverage gap.
- README demo media derived from the bundled default character.

- Public-repository legal, privacy, security, support, and contribution surface.
- Cross-platform GitHub Actions test and native unsigned-package validation.
- Fail-closed prerelease automation with exact artifact manifests and SHA-256
  checksums.
- The owner-generated (OpenAI gpt-image) blonde character now supplies the fixed application,
  macOS menu-bar, and Windows notification-area icons under the separate
  `LicenseRef-Poppet-Scoped-Artwork` licence.

### Fixed

- The legacy `KTT` -> `Poppet` user-data migration could never run. Electron
  creates the user-data directory before the main script is loaded (probed:
  the directory exists and is empty at module load), so
  `configureUserDataCompatibility` always saw a `Poppet` directory; beside a
  legacy directory that meant every start failed closed with
  `POPPET_USER_DATA_CONFLICT` and `migrateWithLegacyLock` was unreachable. A
  second copy of the same assumption sat in the publish step, which refused
  whenever the destination existed. The guard now decides on Poppet's own
  entries (`characters`, `settings.json` and its backup/temporary siblings, the
  migration marker) instead of on directory existence, and the publish step
  moves Electron's pre-created directory aside — composed name, never
  `mkdtemp`, because Windows rejects an existing rename destination — restoring
  it on any failure and dropping it only once the new profile is durable. Two
  genuine profiles with real data still refuse, now with a message that says
  what to do. The suite missed this because it only ever built the state where
  the Poppet directory was absent, which no running Electron produces.
- Publication-route defects found by a documentation-versus-artifact audit,
  all of which would have surfaced only during the real publication:
  the clean-history export step said to copy the working tree minus `.git`,
  which would have published every ignored tree beside it (build output,
  staged pre-rename binaries, logs carrying machine-local absolute paths, the
  private source anchor, internal character directories) in direct conflict
  with the same document's artifact contract — it now specifies `git archive`
  or a fresh clone, i.e. the tracked file set only; removing the black-haired
  root reference would have broken `npm test` because a packaging test hard
  asserted that file's existence with `fs.statSync`, so hosted CI on the new
  public repository would have started red — that inventory is now derived
  from the `repositoryArtwork` record itself, making the documented
  delete-file-plus-delete-record operation genuinely self-consistent; and
  `SECURITY.md` directed a reporter without private vulnerability reporting to
  open a plain issue while `blank_issues_enabled: false` made that impossible.
- Exporting a legacy-format character, the bundled built-in character, or a
  character without `icon.png` no longer touches any of that character's
  files: the previous strict metadata read could rename a legitimate
  `character.json` to `.corrupt-*` on validation failure, making the
  character disappear from the library. Refusals now return the stable
  `POPPET_PACK_NOT_EXPORTABLE` code (with a `reason`) or the existing
  `POPPET_PACK_BUILTIN_FORBIDDEN`, with a user-readable message.

### Changed

- The prerelease workflow now runs the cross-platform manifest and SHA-256
  verification in its own `verify` job before the protected `public-release`
  environment, instead of only inside the environment-gated publish job. The
  release contract told the approver to inspect those checks, but the
  environment key gates the whole job, so the verification structurally could
  not have run yet at approval time. The publish job still repeats the
  verification on its own download; that repetition is deliberate. The
  workflow has still never executed on hosted CI — it triggers only on a
  prerelease tag push, and no tag exists.
- `package.json` declares `repository.url` as the single source of truth for
  the public GitHub slug, and `test/packaging/public-surface.test.mjs` asserts
  every badge, clone command, advisory URL, and issue-template link against
  it. The clean-history route creates a new repository, so these strings were
  a rename away from pointing somewhere unreachable with nothing to catch it.
- A `Request a private security contact channel` issue form now provides the
  fallback `SECURITY.md` promises: coarse platform plus two required
  disclosure acknowledgements, and no field that invites technical detail.
- Character Manager: a non-built-in character that cannot be exported now
  shows a disabled export button whose tooltip explains why and what to do
  (legacy v0/v1 characters: recreate the character from the original image;
  characters without `icon.png`: missing icon file); the built-in brand
  character still shows no export control. `lib:list` items carry
  `exportBlockReason` (`'builtin' | 'legacy-schema' | 'missing-icon' |
  null`); the `exportable` boolean keeps its meaning.
- `package.json` `license` is now the composite SPDX expression
  `MIT AND LicenseRef-Poppet-Scoped-Artwork`, so SBOM tooling and the GitHub
  sidebar no longer present the separately licensed bundled artwork as MIT.
- The default-character provenance record now truthfully discloses that the
  blonde artwork was generated by the owner with OpenAI's gpt-image (ChatGPT),
  states the OpenAI-Terms rights basis, and retains the embedded signed C2PA
  manifest as provenance evidence. Earlier wording claiming personally-created
  artwork was corrected.
- The current product and package brand is now Poppet. The former working name
  remains only in dated historical evidence, an exact owner-authorization
  quotation, and the one-time legacy-profile compatibility path.
- On the first Poppet launch after an upgrade, legacy profile data is copied
  under single-instance protection into the Poppet profile. Unsafe or ambiguous
  directory states fail closed, and the legacy directory remains in place as a
  fallback; its application data is not merged or overwritten.
- The application identifier is now `com.sioyoo.poppet`. Windows deliberately
  retains the previous NSIS GUID so an installed alpha remains discoverable to
  the upgrade and uninstall chain; that compatibility identifier is not a
  current product name.
- Free Poppet Core uses the fixed bundled blonde icon. User-selectable brand
  icons are reserved for a future paid offering and are not implemented in the
  current product.
- Public positioning now targets a free, local-first GitHub alpha before any
  decision about Steam.
- Package metadata now carries the complete `0.1.0-alpha.1` prerelease version,
  so every future alpha/beta/rc tag maps to a distinct internal version.

### Blocked

- Repository publication requires explicit owner authorization.
- Public release requires authorization or removal of the unbundled black-haired
  root reference image. The exact bundled blonde artwork and its derived icons
  are already verified; any byte or licence change closes that gate again.
- GitHub Sponsors and any Ko-fi link require completed human onboarding.

No release has been published from this changelog entry.
