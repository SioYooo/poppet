# Asset licensing

Status: VERIFIED

The MIT license in `LICENSE` covers Poppet source code and documentation. It does
not grant permission to reuse or redistribute artwork merely because that
artwork is present in this repository. Every custom asset selected by the
package build is inventoried below.

This `VERIFIED` status applies to the bundled blonde artwork inventory, not to
every image stored in the repository and not to public-repository approval.

## Bundled artwork: VERIFIED

On 2026-08-21 Sioyoo attested that they generated the blonde default-character
artwork using OpenAI's ChatGPT image generation (`gpt-image`), that OpenAI's
Terms of Use assign the generated output to them, and they explicitly
authorized the Poppet-scoped uses defined by
`LicenseRef-Poppet-Scoped-Artwork`. The source anchor embeds OpenAI's signed
C2PA manifest, which is retained as provenance evidence. The authorization,
generative-AI disclosure, rights basis, current per-file hashes, and scope
limits are recorded in `docs/default-character-provenance.md`.

| Path | Packaged role | Provenance | Copyright owner | License | Redistribution | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `assets/characters/default/character.json` | Built-in character metadata that identifies and positions the default artwork | PROJECT_AUTHORED_METADATA | Sioyoo | LicenseRef-Poppet-Scoped-Artwork | VERIFIED | `docs/default-character-provenance.md` |
| `assets/characters/default/icon.png` | Built-in character selection icon | DERIVED_FROM_OWNER_AI_GENERATED | Sioyoo | LicenseRef-Poppet-Scoped-Artwork | VERIFIED | `docs/default-character-provenance.md` |
| `assets/characters/default/parts.png` | Built-in character sprite parts used by the renderer | DERIVED_FROM_OWNER_AI_GENERATED | Sioyoo | LicenseRef-Poppet-Scoped-Artwork | VERIFIED | `docs/default-character-provenance.md` |
| `assets/characters/default/pet.png` | Built-in character preview artwork | DERIVED_FROM_OWNER_AI_GENERATED | Sioyoo | LicenseRef-Poppet-Scoped-Artwork | VERIFIED | `docs/default-character-provenance.md` |
| `assets/tray-fallback.png` | Canonical macOS menu-bar and Windows notification-area icon | GENERATED_FROM_OWNER_AI_GENERATED_ARTWORK | Sioyoo | LicenseRef-Poppet-Scoped-Artwork | VERIFIED | `docs/default-character-provenance.md` |
| `build/icon.icns` | macOS application icon bundle | GENERATED_FROM_OWNER_AI_GENERATED_ARTWORK | Sioyoo | LicenseRef-Poppet-Scoped-Artwork | VERIFIED | `docs/default-character-provenance.md` |
| `build/icon.ico` | Windows application icon bundle | GENERATED_FROM_OWNER_AI_GENERATED_ARTWORK | Sioyoo | LicenseRef-Poppet-Scoped-Artwork | VERIFIED | `docs/default-character-provenance.md` |

The permission is limited to the covered blonde chain and the Poppet-scoped uses
defined in the evidence record. It does not grant standalone third-party reuse.
If any covered bytes, ownership, or permission changes, update the evidence
record, this inventory, and `.github/release-policy.json` together. The
readiness checker derives packaged custom asset paths from `package.json` and
rejects missing or extra entries.

The tracked blonde source reference
`5E700BDF-E583-4DFB-9B63-E03CC10F02FD.PNG` is covered by the Poppet-scoped owner
licence and is excluded from application packages. The unbundled black-haired
root reference `F8B5D4B4-324B-487B-BFAC-E4A3A151D7E7.PNG` is also owner-generated
AI artwork under the same Poppet-scoped owner licence, attested 2026-08-24, and
is likewise excluded from application packages. Unlike the blonde source, its
bytes carry no embedded provenance manifest to corroborate that attestation; see
`docs/default-character-provenance.md` for why, and for what that means.
Both root paths are inventoried independently in
`.github/release-policy.json`, and the readiness checker rejects missing, extra,
or unresolved repository-root artwork.

## User-imported images

Images imported by users are not part of Poppet and are not relicensed. Users are
responsible for having the rights needed for their own use or distribution.
