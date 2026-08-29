# Security policy

## Supported versions

Poppet has no supported public binary release yet. Until an alpha is published,
security work targets the current `main` branch. After publication, only the
latest prerelease will receive fixes unless a release note says otherwise.
Poppet has no auto-update channel, so a fix never reaches an installed copy on
its own: users must manually download the fixed release from the GitHub
Releases page and install it over the old version.

## Reporting a vulnerability

Use GitHub Private Vulnerability Reporting at
`https://github.com/SioYooo/poppet/security/advisories/new`. The repository
owner must enable that feature before making the repository public. If the
private reporting form is unavailable, do not publish exploit details in an
issue. Blank issues are disabled, so use the **Request a private security
contact channel** issue form instead: it asks only for a coarse platform and a
disclosure acknowledgement, offers no field for technical detail, and exists
solely so the maintainer can reply with a private channel. Send the report
itself through that channel, never through the form.

Include the affected commit/version, platform, impact, minimal reproduction,
and whether a malicious image, character directory, or `.poppetpack` package
is required. Remove
private images, credentials, and unrelated personal paths.

No response-time SLA, bounty, or reward is currently promised. Please allow a
reasonable remediation window before public disclosure.

## Relevant boundaries

High-value reports include unsafe image parsing/resource exhaustion, IPC input
validation bypass, path traversal, unsafe persistence/recovery, or packaged
development surfaces. Ordinary feature requests and unsigned-package warnings
belong in regular issues; unsigned alpha status is a known distribution risk,
not proof of a Poppet vulnerability.
