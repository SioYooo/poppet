# Native release qualification

This runbook turns "the package built" into an auditable chain:

```text
source commit
  -> automated tests
  -> native package
  -> package purity (actual app.asar)
  -> expected release inventory + SHA-256
  -> platform signature/trust observation
  -> structured evidence report
  -> manual GUI checklist on the packaged app
```

Every claim made anywhere about alpha readiness must be traceable to a row in
this document. Do not describe a build as installed, trusted, or verified when
the evidence tier below says otherwise.

## Evidence tiers

| Tier | Meaning |
| --- | --- |
| `AUTOMATED` | Executed by `npm run qualify:native` (or the listed commands) on this machine; recorded in the JSON report. |
| `MANUAL` | A human performs it on the packaged app; recorded in the report's `manualChecks` as `MANUAL_REQUIRED` until someone records the result. |
| `PLATFORM_NATIVE` | Requires the named operating system's package/verify tooling. A cross-build is never evidence. |
| `HOSTED_CI` | Only a real GitHub Actions run proves it. Workflow YAML is not a run. |
| `OWNER_REQUIRED` | An external account, certificate, approval, or publication decision that no build can supply. |
| `NOT_VERIFIABLE_HERE` | Structurally impossible on a dev machine (e.g. quarantined first launch). Named honestly instead of approximated. |

## Automated chain: `npm run qualify:native`

`tools/qualify-native.mjs` runs, in order, on the **current** platform only
(Linux is refused: a cross-build is not native evidence):

1. Record the commit and working-tree state. A dirty tree is refused unless
   `--allow-dirty` records it, because evidence must name the commit it tested.
2. `npm test`
3. Electron smokes only with `--smokes` (`test:manager`, `test:click`,
   `test:multi` — they need a real GUI session).
4. `npm run pack:mac` / `npm run pack:win` (native build)
5. `npm run verify:package` (production `app.asar` purity against current source)
6. `collect-release-assets` (exact expected inventory + SHA-256 manifests)
7. Re-verify every packaged binary against the run's own manifest.
8. Signature/trust observation:
   - macOS, per built `.app`: `codesign --verify --deep --strict --verbose=4`,
     `codesign -d --verbose=4` (identifier, TeamIdentifier, ad-hoc state),
     `spctl -a -vv` (recorded, never judged).
   - Windows, per packaged `.exe`: `Get-AuthenticodeSignature` status.
9. Writes one `schemaVersion 1` JSON report (exclusive create, never
   overwritten) under `.artifacts/native-qualification/` (git-ignored) and
   prints the summary plus what this run cannot prove.

The command never tags, publishes, uploads, notarizes, or changes visibility.
Exit code 0 means every automated check passed — **not** that the release is
qualified: `manualChecks` remain outstanding by construction.

### Report schema (schemaVersion 1)

```json
{
  "schemaVersion": 1,
  "generatedBy": "tools/qualify-native.mjs",
  "automatedOnly": true,
  "commit": "<git sha>",
  "workingTree": "clean | dirty (--allow-dirty recorded)",
  "version": "<package.json version>",
  "platform": "macos | windows",
  "osVersion": "<os.type> <os.release>",
  "arch": "arm64 | x64 | ...",
  "node": "<process.version>",
  "electron": "<devDependency>",
  "electronBuilder": "<devDependency>",
  "appId": "com.sioyoo.poppet",
  "timestamp": "<ISO 8601>",
  "commands": [{ "name": "...", "command": "...", "status": "PASS|FAIL|NOT_RUN", "exitCode": 0 }],
  "packageArtifacts": [{ "name": "...", "bytes": 0, "sha256": "...", "status": "PASS" }],
  "packagePurity": { "verifyPackage": "PASS", "note": "..." },
  "signature": [],
  "smokes": { "status": "PASS | FAIL | NOT_RUN", "note": "..." },
  "manualChecks": { "<checklist key>": "MANUAL_REQUIRED" },
  "blockedChecks": ["<NOT_VERIFIABLE_HERE items>"],
  "result": "PASS | FAIL"
}
```

`result: "PASS"` is scoped to the automated chain on one platform. It must be
quoted together with `automatedOnly: true` and the outstanding `manualChecks`
or it becomes a false claim. Reports must never contain secrets, certificates,
tokens, or absolute machine-local paths.

Recorded runs live in `docs/reports/native-qualification-*.json`, named for
the commit they tested. The first recorded run is
`native-qualification-macos-7550279.json` (2026-08-28, macOS 27.0, Apple M5
Pro arm64, Node 22.23.1, Electron 43.4.1): full chain PASS, both ASARs pure,
both bundles ad-hoc signed with the correct identifier and the expected
`spctl: rejected`; everything in `manualChecks` remains outstanding.

## macOS qualification (PLATFORM_NATIVE)

```bash
npm ci
npm run qualify:native -- --smokes
```

Automated, per built `.app` (both `mac-arm64` and `mac` x64 outputs):

- `codesign --verify --deep --strict` exits 0 — structurally valid signature.
- Identifier equals `com.sioyoo.poppet` (matches `Info.plist`).
- Ad-hoc state recorded. Without a Developer ID the honest description is
  **"ad-hoc signed, not notarized"** — never "signed" or "trusted".
- `spctl` verdict recorded. `rejected` is the **normal** verdict for an
  unsigned/ad-hoc app and is not a packaging failure.

`build/after-sign.cjs` contract (regression-tested in
`test/packaging/after-sign-identity.test.mjs`): if a real Developer ID
signature is present (`TeamIdentifier` other than `not set` in the
`codesign -d` display output — which arrives on **stderr**), the hook skips
and never touches the bundle; otherwise it replaces the broken linker
signature with ad-hoc and fail-closed verifies, refusing to emit a bundle that
fails `codesign --verify --deep --strict`.

### Manual packaged-app checklist (MANUAL)

Run against the packaged app (install the DMG, or open the built `.app`), not
`npm start`. Record each as observed; a failure is recorded as a failure.

app launches; tray/menu-bar icon appears; Manager opens from tray; bundled pet
appears; import PNG; preprocessing/pixelization works; Create succeeds and the
first non-empty pet frame appears; click reaction; drag and landing; sandboxed
click-through; multiple pets; positions persist; restart recovery; remove and
re-add pet; import a `.poppetpack`; export a user-created `.poppetpack`;
built-in brand character refuses export; quit and relaunch; multi-display
rescue (if hardware permits).

### Gatekeeper honesty

A local build never carries the `com.apple.quarantine` attribute, so no local
run can show what a genuinely downloaded copy displays. Until someone performs
the real `browser download -> quarantine -> first launch` path on a machine
that did not build the artifact, the state is exactly:

```text
NOT_VERIFIED: QUARANTINED_FIRST_LAUNCH
```

Never disable Gatekeeper or advise anyone to. The expected ad-hoc path is the
System Settings > Privacy & Security "still open" flow, not a double-click.

## Windows qualification (PLATFORM_NATIVE)

```powershell
npm ci
npm run qualify:native -- --smokes
```

Automated: NSIS installer + portable exe built, `app.asar` purity, inventory +
SHA-256, and `Get-AuthenticodeSignature` per packaged exe. For the unsigned
alpha the honest state is `NotSigned` — an "unsigned developer alpha", never a
"trusted Windows release".

Manual checklist (MANUAL), on the installed machine: install; launch; tray
icon; Manager; bundled pet; PNG import; pixelization; Create; click; drag and
landing; click-through; multiple pets; restart recovery; position persistence;
`.poppetpack` import/export; brand-export refusal; uninstall; reinstall.
SmartScreen first-launch behavior on a downloaded copy is
`NOT_VERIFIABLE_HERE` for a locally built artifact.

## What remains outside this runbook

- `HOSTED_CI`: hosted Linux/Windows/macOS test + smoke lanes, and the release
  workflow's build/verify/publish matrix (see `.github/workflows/release.yml`
  and `.github/release-policy.json`).
- `OWNER_REQUIRED`: repository visibility approval, Apple Developer Program /
  Developer ID + notarization, Microsoft Store account and reserved identity,
  Steam Direct. Verified facts and sequencing for those external accounts are
  owner-recorded outside the published tree; no fake identity, App ID,
  Publisher ID, or review result may ever be recorded here.

Record failures without inflating them into success. A compile, a GitHub
artifact, or a cross-build does not substitute for the relevant machine.
