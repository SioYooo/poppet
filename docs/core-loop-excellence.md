# Poppet Core Loop Excellence contract

Status: preregistered on 2026-08-20, before the Manager information-architecture
change.

This is the canonical scope, measurement, and evidence contract for the Core
Loop Excellence milestone. Dated reports under `docs/reports/` are historical
evidence for their own milestones; they do not redefine this
contract. Current executable code and tests outrank prose when they disagree.

The 2026-08-21 Poppet rename is an explicit evidence-protocol cutover. New runs
use the current probe identity (see the dated addenda below for the exact
version in force) and version-2 digest domains/bindings. Earlier reports retain their former-name identities and must
not be mixed with or silently revalidated as Poppet evidence.

## Purpose and frozen scope

The milestone tests one product hypothesis:

> A person can bring existing character artwork to life on their desktop,
> locally, without learning bones, timelines, XML, or code, while preserving the
> character's recognizable identity and style as far as the supported input
> scope allows.

The engineering loop is:

```text
choose a local image
  -> see the source
  -> see the processed result and readiness
  -> Create
  -> validate and persist atomically
  -> spawn exactly one pet using that exact character
  -> report success only after its first ready frame
  -> restore the same character after restart
```

Poppet Core remains local-first, network-free, telemetry-free, and usable without
an account. This milestone does not add a new extraction or pixelization
algorithm, Studio, AI generation, a model download, an endpoint, an account,
payment, community features, new pet actions, or a release bypass. Studio stays
disabled. Imported images and renderers stay untrusted. Character v0/v1/v2
compatibility continues through `src/shared/parts.js`.

## Input buckets

The bucket is assigned before a case runs and must not be changed after seeing
the result.

### `supported`

- Pixel or pixel-like character art with an alpha channel.
- Character art on a solid or simple background.
- A subject with a clear boundary and input dimensions, frame count, aggregate
  pixels, and work set inside the existing safety budgets.
- The user accepts Original or an already implemented local preset.
- Automatic detection is correct, or no more than one clear manual correction
  is needed.

### `recovery`

- Background removal is uncertain but an existing fallback can recover it.
- Face or parts inference is wrong but the existing manual controls can correct
  it.
- A sprite sheet needs the existing manual grid or part controls.
- A failed Create attempt can be retried without losing the source, draft, or
  user selections.

### `unsupported`

- Complex photographs or semantic backgrounds.
- Severe occlusion, extremely low contrast, or widespread transparent noise.
- Inputs that require semantic judgement to decide what should be retained.
- Requests to redraw, inpaint, generate poses or frames, or repair the artwork.
- Inputs over an existing image, animation, or work-set safety budget.
- Any flow that requires cloud inference or a model download.

An unsupported or over-budget input must be explained, recoverably handed back,
or rejected clearly. A correct rejection is not a supported-scope product
failure and must not be moved into or out of a denominator after the run.

The milestone summary's `failureCounts` covers both observed case failures and
currently unmet milestone gates. In particular, a run with fewer than five
qualifying novices records `HUMAN_EVIDENCE_UNAVAILABLE`, and a run without the
required rights-cleared supported-scope corpus records
`RIGHTS_OR_PROVENANCE_BLOCKED`. Those gate counts are at least one while the
condition remains unmet; zero never means "not run" or "unknown".

## Default-flow decisions and disclosure

The default path asks for only these decisions:

1. Choose a local image the participant has the right to use.
2. Keep Original, or choose from a default surface containing no more than three
   total already implemented, user-facing style choices including Original.
   Original requires no affirmative choice and stays the safe default.
3. Click Create after the result is Ready.

A derived default name is not a required decision. Naming, face and part boxes,
sprite-sheet controls, rig details, diagnostics, thresholds, and palette detail
belong behind one clear Advanced entry. Opening Advanced does not itself count
as a correction.

The primary states are `Processing`, `Ready`, `Needs review`, `Unsupported`,
and `Failed with recovery`. Create is enabled only for `Ready`. Every other
state supplies one reason and, where a safe existing recovery exists, one next
action. Detection uncertainty may reveal the relevant recovery control; it must
not expose every advanced control at once. Keyboard access and understandable
labels are part of the default-flow contract.

Initial processing and Create failures retain the source, draft, and current
selections. Advanced remains available and retains the existing face, parts,
sheet, rig, and preview recovery abilities.

## Outcomes

Each case ends in exactly one outcome:

- `success`: validation and persistence complete, exactly one pet loads the
  exact new character, the renderer acknowledges its first content frame, and
  the Manager receives that acknowledgement. No recovery path was used.
- `recovered`: the same end condition is reached after an allowed recovery or
  manual correction.
- `rejected`: the input is unsupported or outside a safety budget, and Poppet
  explains the reason without corrupting an existing character or losing a
  recoverable draft.
- `failed`: a supported or recovery-scope case cannot reach the end condition,
  or Poppet silently shows the wrong character, loses persisted state, bypasses a
  safety budget, or claims success before renderer readiness.

Persistence without a ready pet is not success. A saved character is retained
if spawn or renderer readiness later fails, and the UI must present a retry or
recovery state rather than silently importing a duplicate.

## Time-to-Pet clock

All automated durations use one monotonic time domain. The preferred design has
the main process timestamp receipt of every dev-only milestone event with its
own monotonic clock. In particular, `T5` is the main-process receipt time of a
trusted pet sender's no-argument, once-only first-content-frame acknowledgement;
the main process derives the exact character from the sender rather than trusting
a renderer payload. A renderer's `performance.timeOrigin + performance.now()` is
not assumed to share a clock with Node or another renderer.

If an implementation retains renderer-local timestamps, it must perform an
explicit main/Manager/pet clock calibration, record calibration uncertainty,
and transform every marker into the declared common domain. Without that
calibration, cross-process markers and derived metrics are null/`UNAVAILABLE`.
Output stores offsets, durations, clock mode, and calibration uncertainty, not
local wall-clock timestamps for individual user actions.

| Point | Definition |
| --- | --- |
| `T0` | A valid local selection is accepted and Poppet begins reading it. |
| `T1` | The bounded source preview is first visibly available. |
| `T2` | The processed preview and its readiness state are first visibly available. |
| `T3` | The user or automation activates Create. |
| `T4` | Main-process validation and durable atomic persistence have completed. |
| `T5` | The target pet renderer has loaded the exact character and reports its first non-empty content frame. |
| `T6` | The Manager receives the success acknowledgement that includes `T5`. |

The current `pet:ready` request supplies initialization data; it is not, by
itself, a `T5` first-frame acknowledgement.

If Chromium suspends Manager animation frames while that window is occluded or
backgrounded, Poppet may use a bounded deadline to keep local processing
responsive. That deadline is not visibility evidence: the affected `T1`, `T2`,
or Manager success-visibility marker remains null with
`POPPET_MANAGER_PAINT_UNAVAILABLE`; no duration may be inferred from it.

Derived metrics are:

```text
timeToSourcePreview    = T1 - T0
timeToProcessedPreview = T2 - T0
createToPetReady       = T5 - T3
systemTimeToPet        = (T2 - T0) + (T5 - T3)
humanEndToEndTime      = T5 - T0
```

`humanEndToEndTime` is valid only for an observed human trial and includes all
participant reading, choosing, hesitation, and correction time. Automated runs
must identify themselves as `automation`, leave `humanEndToEndTime` null, and
must not support a 60-second human claim. Missing or out-of-order markers make
the relevant metric unavailable; a harness must not infer a missing marker from
a sleep or polling deadline.

## Manual corrections

`fixesNeeded` counts user actions taken after the first processed preview in
order to obtain a usable result. Each committed change of a detection/crop/part
rectangle, sheet interpretation, or existing preset counts once. A continuous
drag ending at one pointer-up counts once. Reverting and choosing again counts
again.

Opening or closing Advanced, viewing a preview, typing a name, moving focus,
retrying Create without changing the draft, or accepting the automatic result
does not count. Automated recovery scripts may record `scriptedFixes`, but they
do not populate human `fixesNeeded` or contribute to the human correction-rate
claim.

## Failure taxonomy

Every non-success event records its stage, recoverability, input bucket,
supported-scope flag, stable error code or category, final-claim impact, and one
of these classes:

- `CI_SOURCE_CONTRACT`
- `CI_HOST_LAYOUT_ASSUMPTION`
- `PACKAGED_NOTICE_MISSING`
- `PACKAGED_NOTICE_STALE`
- `ASAR_MANIFEST_DRIFT`
- `INPUT_BUDGET_REJECTED`
- `UNSUPPORTED_COMPLEX_BACKGROUND`
- `SUBJECT_EXTRACTION_FAILURE`
- `SUBJECT_EXTRACTION_UNCERTAIN`
- `FACE_OR_PARTS_DETECTION_FAILURE`
- `MANUAL_FIX_REQUIRED`
- `PIXELIZE_FAILURE`
- `PREVIEW_FAILURE`
- `PERSISTENCE_FAILURE`
- `SPAWN_FAILURE`
- `RESTART_RECOVERY_FAILURE`
- `RUNTIME_COMPOSITION_FAILURE`
- `PERFORMANCE_REGRESSION`
- `TEST_FIXTURE_ERROR`
- `ENVIRONMENT_FAILURE`
- `HUMAN_EVIDENCE_UNAVAILABLE`
- `RIGHTS_OR_PROVENANCE_BLOCKED`

From the rename cutover onward, stable `POPPET_*` error codes remain the low-level
cause. The measurement harness maps them and the current stage to this taxonomy;
it does not replace specific causes with a generic `failed`. A correct
unsupported/background or budget rejection is reported but excluded from the
supported-scope success denominator. A fixture defect is `TEST_FIXTURE_ERROR`,
not a product failure.

## Local measurement and corpus records

Measurement is developer-only and explicitly invoked. It neither runs during a
normal user session nor uploads, reports, or transmits anything. Raw artifacts
stay under the ignored `.artifacts/core-loop/` tree. Only an aggregated,
privacy-reviewed summary may be committed.

A case record may contain only:

- `schemaVersion`, `runId`, `gitSha`, platform, Node/Electron versions, and a
  coarse non-identifying hardware class;
- opaque case ID, preregistered input bucket, width, height, frame count, and
  other non-identifying budget fields;
- chosen existing preset, extractor mode, timing durations/offsets,
  `fixesNeeded` or `scriptedFixes`, outcome, failure records, recovery use,
  warnings, and harness version.

It must not contain a filename, absolute path, username or home directory,
image bytes or thumbnail, reversible file hash, EXIF or other source metadata,
user-entered character name, unconsented device identifier, or network address.
Warnings and exception text are sanitized before serialization. Opaque case IDs
are assigned in a local manifest and are never derived from file bytes or a
path.

Corpus rules are fail-closed:

- Use only project-created synthetic fixtures or inputs with recorded permission
  and provenance appropriate for the test.
- Keep private input files and their path-bearing manifest ignored and local.
- Give every committed fixture an explicit source and license record.
- Freeze bucket and exclusion decisions before processing.
- Report every original denominator; never remove or re-bucket a case after its
  outcome is visible.
- Automated synthetic cases validate pipeline stability, not novice usability,
  recognizable identity, style preservation, or a wow moment.

No corpus-level success claim is allowed before at least 50 rights-cleared
supported-scope cases exist. The candidate target is at least 90% successful in
the supported bucket under the preregistered 0-1 correction semantics, with no
silent wrong-character result, persistence/runtime mismatch, or safety-budget
bypass.

## Performance baseline and regression rule

Before/after measurements use the same native machine, power mode, display
configuration, Electron/Node versions, Poppet settings, character fixture set, and
sampling protocol. Each run uses an isolated profile and records the git SHA.
Cross-built packages are not native runtime evidence.

For each of 1, 3, and 6 pets:

1. Warm up for 30 seconds.
2. Record 60 seconds idle.
3. Record 60 seconds of deterministic existing animation activity.
4. Destroy the created pets and record a 30-second recovery window.
5. Repeat the sequence three times, preserving every repetition.

Record main and renderer CPU, main and renderer resident/working-set memory,
frame cadence and p50/p95/p99 frame interval, long frames over twice the target
frame period, render work, event-loop stalls over 100 ms, crashes, unhandled
errors/rejections, window/pet counts, and observable timer/listener/resource
counts before creation and after destruction.

For a lower-is-better continuous metric, aggregate the recorded intervals into
10-second blocks and compare blocks paired by topology, phase, repetition, and
position with `(after - before) / max(abs(before), noiseFloor)`. Noise floors
are one CPU percentage point, 1 MiB for memory, 0.1 ms for frame/render work,
and 0.1 percentage point for rates. A significant regression requires both a
median increase greater than 20% and a paired bootstrap 95% confidence interval
whose lower bound is above zero. The bootstrap uses 10,000 resamples and the
fixed integer seed `0x4b5454`. For cadence, apply the same rule to p95 frame
interval and also fail if the long-frame rate rises by more than one percentage
point with a confidence interval above zero. Any new crash, unhandled exception/
rejection, wrong pet/window count, or resource count that does not return to its
preregistered post-destroy baseline is a regression without a statistical
waiver.

When the environment permits, run a one-hour 6-pet automated soak after a
10-minute warm-up. It fails on a crash, unhandled error, increasing pet/window/
listener/timer counts, or combined main-plus-renderer memory whose Theil-Sen
slope has a 95% lower confidence bound above 1 MiB/min and whose final ten-minute
median exceeds the first measured ten-minute median by more than 20 MiB. These
rules are locked before results are viewed and must not be changed to make a run
pass.

The developer-only local harness is explicit and is excluded from production
packages by `!tools/**/*`. `npm run measure:performance` runs the locked default
1/3/6 matrix and one-hour soak with the repository Electron probe. Duration
overrides are permitted only for smoke validation and force
`protocolQualified=false`; their unavailable ten-minute memory analysis is not
a pass or regression result. `--app-root <clean-worktree>` runs the same harness
against a selected pre-change or final worktree on the same host. The harness
records whether that source worktree is dirty; a preregistered-duration run on
anything other than a provably clean worktree records `ENVIRONMENT_FAILURE`.
All raw JSONL, JSON, and Markdown output is written only on explicit invocation
under ignored `.artifacts/core-loop/`.

After the pre-change and final runs finish, the developer-only comparator is
invoked with `npm run compare:performance -- --before <pre-run-directory>
--after <final-run-directory> --same-machine`. Each directory must contain the
harness-produced `samples.jsonl` and `summary.json`. It rejects different coarse
hardware classes, protocols, clean harness SHAs, Node/Electron versions, probes,
fixtures, settings, anonymized display/power identities, sample coverage, or
10-second block identities. The operator flag is an explicit attestation that
the two locked runs were executed sequentially on the same machine; a matching
coarse bucket alone is insufficient. The comparator pairs by topology, phase,
repetition, process type/slot, and block position and uses the locked noise
floors plus 10,000 paired bootstrap resamples with seed `0x4b5454`.

The comparator recomputes soak memory and resource trends from raw samples and
rejects a recorded aggregate that disagrees. Crash, unhandled-error,
wrong-pet/window, post-destroy timer/listener, and soak-leak checks have no
statistical waiver. A smoke or otherwise non-claimable result exits non-zero
unless the caller explicitly supplies `--allow-smoke`; that flag can never make
the result claim-eligible. Only privacy-safe aggregate `comparison.json`,
`comparison.md`, and an independent `evidence-binding.json` are written beneath
`.artifacts/core-loop/`; raw samples, run IDs, paths, and filenames are not
copied into the comparison output. The binding hashes the exact before/after
`samples.jsonl` bytes and the persisted `comparison.json` bytes and records the
observed sample, paired-block, metric-result, and hard-check counts. Verification
re-reads both raw run directories, recomputes the comparison, and rejects any
changed sample, aggregate, comparison, or count.

`npm run finalize:core-loop` is the network-free final projection step. It
requires the before run, after run, comparison directory, candidate milestone
summary, and a sanitized hosted-CI bundle. It first performs the raw evidence
verification above, then produces an ignored candidate summary plus a small
acceptance sidecar. An engineering-accepted summary is invalid without that
sidecar; a digest typed into the summary without the bound evidence cannot
satisfy the strict validator.

### Methodology provenance addendum — 2026-08-20

Commit `be397ca` locked the supported buckets, T0-T6 definitions, correction
semantics, privacy boundary, and pre-change Manager observations before any
Manager/runtime implementation change. The later 10-second block identity,
fixed bootstrap seed, comparator, raw histogram, provenance, and environment
identity details in this section are a dated methodology addendum. They were
locked before any protocol-qualified performance result was collected, but are
not represented as if every detail had already existed in `be397ca`.

The comparable pre-change app is therefore a clean linear commit that adds only
the developer-only fixed-size frame-interval instrumentation to the unchanged
pre-Manager renderer. It must exclude first-frame acknowledgement, Manager UX,
Create/persistence semantics, and extra evidence callbacks. Both that commit
and the final app are driven sequentially by the same clean, committed final
harness; otherwise the comparison is non-claimable.

That instrumentation-only app commit is
`5bef57ec4793496cc64da341b370da4f6b5df642`, whose direct parent is
`acae91a28503ed50ef035782fbe78ab0d4ff3d78`. Its sole source-file change is
the developer-only renderer interval histogram; it contains none of the
Manager/runtime milestone implementation. The earlier `749fbf9` observation
below remains the preregistered product baseline, while `5bef57e` is the
minimal measurement-compatible app source used for the qualified performance
comparison.

## Preregistered pre-change baseline

This baseline was recorded before the Manager progressive-disclosure change.
It is append-only: later corrections must be an explicit dated erratum rather
than rewriting the observed result.

Within the table, “Current” means current at the 2026-08-20 preregistration
snapshot. It is not a claim about the present Poppet implementation.

| Item | Pre-change evidence | Boundary |
| --- | --- | --- |
| Source reference | `main` at `749fbf9fe9f93aac536b6b73f944e578f61db9a6`; P0 packaging work could remain uncommitted, but Manager/runtime source had not been changed for this milestone | Working-tree baseline, not a remote immutable run |
| Host/runtime | Windows development host; Node `v22.23.2` | Source Electron smoke, not installed/signed package evidence |
| Manager smoke | `npm run test:manager`: first process 4/4; separate restart process 3/3; exit 0 | First execution included the Electron download; no human timing was captured |
| Creation/persistence | Current import validation and staging/rename path persist a character, and import activates it through `addPet` | The import reply does not wait for a first rendered content frame |
| Restart | The smoke test reloads the saved character and verifies the live renderer has the same character ID after a separate process restart | It polls after a fixed wait; it is not a `T5` acknowledgement |
| Source preview | The bounded source preview is rendered after processing completes | `T1` is not independently observable before `T2` |
| Processing failure | A failed initial import closes the editor and discards the draft; a failed pixelization change restores the previous usable result | Does not yet satisfy general draft preservation |
| Default disclosure | Original is the default, but pixel palette, face/parts, sheet, rig, and preview controls are all exposed; five processed style labels are visible | Does not satisfy the preregistered default path |
| Timing | `tools/test-pipeline.mjs` prints only synchronous pipeline elapsed milliseconds; the Manager smoke has no T0-T6 record | No compliant Time-to-Pet baseline number exists |
| Corrections/outcomes | No stable `fixesNeeded`, outcome, recovery, or milestone failure-taxonomy record | Unavailable, not zero |
| Synthetic coverage | `npm run survey` covers 12 generated morphologies and writes console output | Auxiliary engineering evidence only |
| Rights-cleared corpus | 0 qualifying supported-scope cases | Product corpus threshold not met |
| Human trials | 0 qualifying novice participants | `humanEndToEndTime`, 60-second, identity/style, and subjective claims unavailable |
| Current cadence probe | The click smoke samples roughly two seconds of active cadence for one pet and logs fps/frame interval/render work | No structured CPU, memory, event-loop, or baseline comparison |
| Multi-pet probe | The multi smoke exercises two pets and IPC/persistence routing | No 1/3/6 performance matrix or soak |

The pre-change engineering state is `PARTIAL_VERIFIED`. The product state is
`HUMAN_REQUIRED`. It is not `CORE_LOOP_ENGINEERING_ACCEPTED` because the
measurement, readiness, performance, and final same-SHA evidence contracts are
not complete. It is not `CORE_LOOP_PRODUCT_VALIDATED` because the qualifying
corpus and human denominators are both zero.

## Required artifacts and final report

Raw logs, private manifests, per-case JSONL, screenshots, and packages remain
ignored under `.artifacts/core-loop/`. The committed milestone artifacts are:

- `docs/core-loop-excellence.md`: this preregistered contract;
- `docs/reports/core-loop-excellence.summary.json`: the privacy-reviewed,
  machine-readable aggregate;
- `docs/reports/core-loop-excellence.acceptance.json`: the privacy-safe CI and
  performance-manifest sidecar required only when the engineering verdict is
  accepted. Raw samples and logs remain ignored.

The human-readable final report for the milestone is development-local
evidence and is not part of the published tree.

The summary contains `schemaVersion`, `generatedAt`, `gitSha`, `branch`, `pr`,
`ciRun`, `engineeringVerdict`, `productVerdict`, `evidenceBoundaries`,
`testCommands`, `testResults`, `packageResults`, `managerScenarios`,
`corpusCounts`, `humanTrialCounts`, `timingSummary`, `performanceSummary`,
`failureCounts`, `rightsStatus`, `nativePlatformStatus`, `remainingGates`,
`commits`, `nextAction`, and the accepted-only `acceptanceBinding`. Unknown or
unexecuted results are null or explicitly `NOT_RUN`; they are never encoded as
zero or PASS. Every exact count comes from the final run. The aggregate contains
no case ID or input-derived identifier.

`summary.gitSha` always identifies the evaluated app commit. Hosted CI,
performance provenance, and the comparator after SHA must identify that same
commit. A later commit carrying only the report files is explicitly a
`DOCS_ONLY_DESCENDANT_OF_SUBJECT`; it must never masquerade as the evaluated app
SHA or create an impossible self-referential report hash. The committed
acceptance sidecar contains only the sanitized CI projection and the digest-
bound performance manifest/projection, and the canonical report test supplies
it to the strict summary validator.

The final Markdown starts with the verdict and uses these ten sections in
order: Verdict; What changed; Before -> after evidence; Round table; Product
evidence; Performance; Evidence boundaries; Git delivery; Remaining blockers;
and one single highest-expected-value next action. Historical results are
labelled historical and are not silently promoted to final-SHA evidence.

## Evidence gates and stop conditions

`CORE_LOOP_ENGINEERING_ACCEPTED` requires, on one final remote SHA:

- all Ubuntu, macOS, Windows, audit, macOS package/verify/upload, and Windows
  package/verify/upload jobs passing;
- the default Manager flow, atomic persistence, exactly-one exact-character
  spawn, first-frame acknowledgement, and restart recovery proven by automated
  oracles;
- T0-T6, automated/human separation, correction semantics, taxonomy, privacy,
  corpus tooling, and the 1/3/6 performance baseline reproducible locally;
- no regression to package-notice, exact-ASAR, security-budget, Studio-disabled,
  character-compatibility, or removed-action gates.

`CORE_LOOP_PRODUCT_VALIDATED` additionally requires at least 50 rights-cleared
supported cases and a preregistered novice study with at least five people.
Report original denominators. The candidate novice targets are at least 4/5
independent supported-happy-path completions, a majority of completers reaching
pet-ready within 60 seconds including decision time, and typical completion in
0-1 corrections. Subjective identity/style preservation and a wow moment require
participant evidence and cannot be inferred from successful rendering.

Stop the autonomous engineering loop when all engineering gates pass; a safe
Electron notice source cannot be established; a new product/security decision
is required; only rights, human, signing, or native-device evidence remains; a
source-supported `NO_GO` is reached; or five scoped improvement rounds are used.

## `HUMAN_REQUIRED` and native-device boundaries

The following cannot be manufactured by automation:

- rights and provenance approval for real corpus inputs and any new or changed
  artwork; the exact current bundled blonde chain was separately verified on
  2026-08-21;
- recruitment, consent, observation, and feedback from real novice participants;
- human `fixesNeeded`, `humanEndToEndTime`, recognizable identity/style, clarity,
  delight, distraction, and long-term retention judgements;
- repository-owner, signing-identity, notarization, or distribution approvals.

Native installation and interaction qualification also remains a separate gate:
Windows installation/runtime, signed/notarized macOS installation, multi-display,
high-DPI, sleep/wake, and 4/8-hour real desktop residency are not proven by a
local source smoke, synthetic corpus, one-hour automation, or a cross-build.

If the engineering gates pass while these inputs remain unavailable, the honest
milestone result is:

```text
CORE_LOOP_ENGINEERING_ACCEPTED + HUMAN_REQUIRED
```

It must not be reported as market validation, public-release readiness, signed
native qualification, or `CORE_LOOP_PRODUCT_VALIDATED`.

### Measurement-extension addendum — 2026-08-21

The performance probe identity advanced to `poppet-core-loop-electron-probe-v4`
with `core-loop-performance-harness-v3`: samples now include the GPU and
utility processes (previously ~100–200 MiB of unmeasured footprint) as
optional same-tick members, and renderer samples carry a `skippedFrameCount`
for render-on-demand comparisons. The identity bump is deliberate: runs made
under earlier identities are non-comparable with v4 runs by construction, and
the locked thresholds and protocol phases above are unchanged.
