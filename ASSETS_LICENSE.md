# Asset licensing

Status: VERIFIED

The PolyForm Noncommercial license in `LICENSE` covers Poppet source code and
documentation. It does not grant permission to reuse or redistribute artwork merely because that
artwork is present in this repository. Every custom asset selected by the
package build is inventoried below.

This `VERIFIED` status applies to the bundled blonde artwork inventory, not to
every image stored in the repository and not to public-repository approval.

## Bundled artwork: VERIFIED

The owner confirmed the noncommercial distribution policy on 2026-09-09.
The prior provenance attestations and asset hashes remain unchanged. This
revision uses `LicenseRef-Poppet-Noncommercial-Artwork-1.0`; the earlier
Poppet-scoped permission is historical and is not retroactively revoked.

## LicenseRef-Poppet-Noncommercial-Artwork-1.0

Copyright attribution: Sioyoo. Effective for this revision: 2026-09-09.
To the extent the owner holds rights in the covered artwork, recipients may:

- use and display it within Poppet for personal, noncommercial purposes;
- copy and redistribute it only as part of a complete, free, noncommercial
  Poppet source distribution or application, retaining this notice;
- modify, crop, resize, or convert it solely for those noncommercial Poppet uses;
- share noncommercial Poppet screenshots retaining artwork attribution.

Commercial use is not permitted. This includes selling or licensing the artwork
or bundled application, paid redistribution, advertising, paid services,
commercial products, and monetized content using the artwork. Free distribution
as part of a commercial offering is also prohibited. The artwork must not be
extracted or redistributed as a standalone asset, character pack, or unrelated
product. No trademark endorsement or sublicensing rights are granted.
Voluntary support to the Poppet author buys no artwork or commercial-use rights.
Rights granted under earlier versions of the artwork license are not revoked.
All rights not expressly granted are reserved, subject to applicable law.
The artwork is provided as is, without warranty; to the extent permitted by law,
the owner is not liable for claims or damages arising from its use.

These terms cover the inventory below, both root reference PNGs listed below,
and their Poppet screenshot derivatives in `docs/media/`. They do not relicense
user imports or third-party materials. AI provenance and the limits of the
copyright basis are documented in `docs/default-character-provenance.md`.

## Inventory

| Path | Packaged role | Provenance | Copyright owner | License | Redistribution | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `assets/characters/default/character.json` | Built-in character metadata that identifies and positions the default artwork | PROJECT_AUTHORED_METADATA | Sioyoo | LicenseRef-Poppet-Noncommercial-Artwork-1.0 | VERIFIED | `docs/default-character-provenance.md` |
| `assets/characters/default/icon.png` | Built-in character selection icon | DERIVED_FROM_OWNER_AI_GENERATED | Sioyoo | LicenseRef-Poppet-Noncommercial-Artwork-1.0 | VERIFIED | `docs/default-character-provenance.md` |
| `assets/characters/default/parts.png` | Built-in character sprite parts used by the renderer | DERIVED_FROM_OWNER_AI_GENERATED | Sioyoo | LicenseRef-Poppet-Noncommercial-Artwork-1.0 | VERIFIED | `docs/default-character-provenance.md` |
| `assets/characters/default/pet.png` | Built-in character preview artwork | DERIVED_FROM_OWNER_AI_GENERATED | Sioyoo | LicenseRef-Poppet-Noncommercial-Artwork-1.0 | VERIFIED | `docs/default-character-provenance.md` |
| `assets/tray-fallback.png` | Canonical macOS menu-bar and Windows notification-area icon | GENERATED_FROM_OWNER_AI_GENERATED_ARTWORK | Sioyoo | LicenseRef-Poppet-Noncommercial-Artwork-1.0 | VERIFIED | `docs/default-character-provenance.md` |
| `build/icon.icns` | macOS application icon bundle | GENERATED_FROM_OWNER_AI_GENERATED_ARTWORK | Sioyoo | LicenseRef-Poppet-Noncommercial-Artwork-1.0 | VERIFIED | `docs/default-character-provenance.md` |
| `build/icon.ico` | Windows application icon bundle | GENERATED_FROM_OWNER_AI_GENERATED_ARTWORK | Sioyoo | LicenseRef-Poppet-Noncommercial-Artwork-1.0 | VERIFIED | `docs/default-character-provenance.md` |

The permission is limited to the covered artwork and the noncommercial
Poppet uses defined above. It does not grant standalone third-party reuse.
If any covered bytes, ownership, or permission changes, update the evidence
record, this inventory, and `.github/release-policy.json` together. The
readiness checker derives packaged custom asset paths from `package.json` and
rejects missing or extra entries.

The tracked blonde source reference
`5E700BDF-E583-4DFB-9B63-E03CC10F02FD.PNG` is covered by the noncommercial artwork
licence and is excluded from application packages. The unbundled black-haired
root reference `F8B5D4B4-324B-487B-BFAC-E4A3A151D7E7.PNG` is also owner-generated
AI artwork under the same noncommercial artwork licence, attested 2026-08-24, and
is likewise excluded from application packages. Unlike the blonde source, its
bytes carry no embedded provenance manifest to corroborate that attestation; see
`docs/default-character-provenance.md` for why, and for what that means.
Both root paths are inventoried independently in
`.github/release-policy.json`, and the readiness checker rejects missing, extra,
or unresolved repository-root artwork.

## User-imported images

Images imported by users are not part of Poppet and are not relicensed. Users are
responsible for having the rights needed for their own use or distribution.

## Donation QR images

The original images in `assets/qrcode/` were supplied by the maintainer on
2026-09-09 for public display of Poppet's voluntary donation methods. They are
payment instructions, not character artwork, and are outside the character
artwork license above. Permission is limited to displaying the unmodified
images for Poppet support; no commercial reuse or payment-brand rights are
granted. Payment-service branding remains with its respective owners and does
not imply endorsement. These images are website/repository documentation and
are not included in the application package.
