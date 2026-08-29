# Support

Poppet is pre-release software. There is currently no guaranteed support SLA.

- Read `README.md` and the known limitations first.
- Use the structured GitHub bug form for reproducible defects.
- If a `.poppetpack` is rejected, attach the output of
  `npm run inspect:pack -- --json <file>` instead of the package itself: it
  contains only sizes, digests, budget usage, and the stable error code, never
  the artwork.
- Use the feature-request form for scoped product ideas.
- Follow `SECURITY.md` for vulnerabilities; never disclose them in a public
  issue.

For a useful bug report, include the Poppet tag or commit, operating-system version,
CPU architecture, exact steps, expected result, and actual result. Do not attach
private character images unless you knowingly choose to make them public.

Unsigned alpha packages may trigger macOS Gatekeeper or Windows SmartScreen.
Those warnings are expected until signing and notarization gates are completed.
Do not disable system-wide security controls to run Poppet.

Updates: Poppet has no auto-update channel. Watch the GitHub Releases page for
new versions and install a new release manually over the old one.
