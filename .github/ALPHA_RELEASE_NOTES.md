# Poppet controlled alpha

This is an early, **unsigned** build for informed testers, not a stable release.
The macOS artifacts are not Developer ID signed or notarized, and the Windows
executables are not Authenticode-signed, so both operating systems are expected
to warn before first launch. If you are not comfortable with the steps below,
please wait for a future signed build instead of running this one.

## What this alpha actually does

Import one pixel illustration and you get a desktop pet that breathes, blinks,
moves its mouth, tilts when you drag it, squashes when it lands, and walks with
a waist-line shear. The bundled character is a single still image too, so it
does exactly that and nothing more.

**It does not move its arms and legs, and that is not a bug.** A flat
illustration does not contain the pixels behind an arm or the order of what
occludes it, so limbs cannot be recovered from it — every infill strategy
measured on the bundled character fills the gap with a neighbouring colour and
reads as a slab. Poppet only reuses pixels the artwork already has.

Free Core does contain the playback for two richer tiers — behaviour-scoped
frame clips, and articulated skeletons whose poses are computed — but both
require artwork that was authored that way, and this alpha ships none of it.
The Manager can edit an existing skeleton, not create one. So for anyone
arriving with a single picture, the tier above is the whole product, and packs
carrying drawn or rigged limbs are a later thing.

## Verify your download

Each release includes a `SHA256SUMS` file listing the expected hash of every
artifact. Verify before running anything.

- macOS (in the download folder):

  ```sh
  shasum -a 256 -c SHA256SUMS
  ```

- Windows (PowerShell or Command Prompt):

  ```bat
  certutil -hashfile <filename> SHA256
  ```

  `certutil` only prints the hash; compare it manually against the line for
  that filename in `SHA256SUMS`. It must match exactly.

## First run on macOS

Because the app is unsigned, macOS will refuse to open it and say the developer
cannot be verified. **The Control-click / right-click "Open" trick no longer
works.** Apple removed that override in macOS Sequoia (15) and it is still gone
in Tahoe (26), so any instructions telling you to Control-click — including
older versions of this file — are out of date. The dialog you get offers only
Cancel and Move to Bin; there is no Open button anywhere in it.

On macOS Sequoia or later, the supported path is:

1. Double-click `Poppet.app` once and dismiss the refusal. This step is not
   optional — it is what registers the app so the next screen can offer it.
2. Open **System Settings > Privacy & Security** and scroll down to
   **Security**.
3. Find the notice naming Poppet and click **Open Anyway**.
4. Confirm, and enter your administrator password when asked.

The build carries a structurally valid ad-hoc signature. That is deliberately
not the same thing as being signed: ad-hoc means the bundle is internally
consistent and its identifier matches, but it carries no developer identity and
cannot be notarized, so Gatekeeper still refuses it. What it buys is the dialog
above rather than the harsher "Poppet is damaged and can't be opened", which is
what an internally inconsistent bundle produces and which most people
reasonably respond to by deleting the app.

If you do see "damaged" anyway, re-downloading rarely helps, because the message
describes the quarantine attribute rather than a corrupted file. On a download
whose hash you verified above, remove that attribute directly:

```sh
xattr -dr com.apple.quarantine /Applications/Poppet.app
```

Do **not** disable Gatekeeper, SIP, or any other system-wide security feature
to run Poppet. Turning off protection for the whole machine to run one alpha is
a worse trade than waiting for a signed build.

Honest caveat: the click path above comes from Apple's documentation for
unsigned software in general, not from running these specific artifacts on real
macOS hardware — native qualification has not happened yet. Expect the shape to
be right and the exact wording to vary by version.

If this is more ceremony than you want, that is a reasonable conclusion: a
signed and notarized build shows one ordinary "downloaded from the Internet"
prompt with an Open button, and is worth waiting for.

## First run on Windows

SmartScreen may show "Windows protected your PC". Click **More info**, confirm
the publisher is listed as unknown (expected for an unsigned build), then click
**Run anyway**. Only do this for a download whose hash you verified above.

## Updates

There is **no auto-update channel** in this alpha. New versions appear only on
the GitHub Releases page; to update, download the new release manually and
install it over the old one.

## Language

The application UI is Simplified Chinese only in this alpha.

## Known alpha characteristics

- Keep backups of any original images you import; this is alpha software and
  data-safety guarantees are still limited.
- The application, macOS menu-bar, and Windows notification-area icons use the
  fixed owner-generated (OpenAI gpt-image, disclosed) blonde character. This free build has no icon-replacement
  control.
- The first launch after an earlier working-name build copies its local profile
  into Poppet under single-instance protection and leaves the old directory as a
  fallback. Ambiguous or unsafe directory states stop instead of merging data.

## Character packages

`.poppetpack` files are untrusted third-party input. Only import packs from
sources you trust; malformed or oversized packs are rejected fail-closed and
never partially imported. The built-in brand character cannot be exported.

## Reporting

Report the Poppet version, OS, architecture, and exact steps. Do not attach
private images unless you intentionally choose to share them. For suspected
vulnerabilities, follow `SECURITY.md` instead of a public issue.
