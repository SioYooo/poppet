# Contributing to Poppet

Poppet is preparing its first controlled public alpha. Small, reproducible fixes
and tests are welcome after the repository owner chooses to make the project
public.

## Development contract

1. Use Node.js 22 and run `npm ci` from a clean checkout.
2. Create a focused branch and avoid unrelated refactors.
3. Run `npm test` and any platform-specific checks affected by the change.
   While iterating, `npm run test:file -- test/security/storage.test.cjs` runs
   one test file (directories are accepted too); finish with the full `npm test`.
4. For packaging changes, build natively with `npm run pack:mac` or
   `npm run pack:win`, then run `npm run verify:package`.
5. Run `git diff --check` and describe exact validation in the pull request.
6. Run `npm run precheck` before pushing. It replays the checks the push lane
   will run and tells you which Electron smokes your change implicates —
   `npm test` cannot cover those, because they drive real windows. Add
   `--smokes` to run them locally.

Please treat hosted CI as a metered shared resource rather than a development
loop. Runs on a private repository consume a monthly allowance, macOS runners
cost roughly ten times a Linux one, and each job rounds up to a whole minute, so
a green run should confirm something you already believe rather than being the
first place your change is executed. Group commits and push at points worth a
run; pushes to a feature branch are free, and only `main` and pull requests
trigger the workflow.

Do not commit `dist/`, private character images, credentials, signing material,
machine-local paths, or generated diagnostic output.

## Interactive dev loop

`npm run dev` starts Electron on your real Poppet profile and keeps the
legacy-profile guard: on a machine where both the Poppet and the former `KTT`
user-data directories exist without a migration marker it fails closed with an
error dialog instead of guessing. To iterate without touching any real profile:

```bash
npm run dev:isolated              # pass-through is allowed, e.g. -- --demo
```

It creates a throwaway `poppet-electron-smoke-*` directory under the system
temp folder, starts `electron . --dev --isolated` on the normal interactive
path (hardware acceleration on, first-run onboarding and built-in seeding happen
inside the temporary profile, single-instance lock scoped to it so a production
Poppet may keep running), and removes the directory after you quit the app from
the tray menu or with Ctrl+C in the terminal. The runner has no timeout and
exits with the app's exit code. Smoke flags (`--test-*`) are refused here; use
`npm run test:click|test:manager|test:multi` for those.

`npm run inspect:pack -- [--json] <file.poppetpack>` runs the app's exact
import chain offline without writing anything; use it before filing or triaging
package-rejection reports. `npm run preflight:release` replays the release
workflow's validate gates locally and lists what local runs cannot prove.

## Artwork and fixtures

Every contributed image must include truthful author, source, copyright, and an
explicit redistribution license. Do not submit scraped, AI-generated, or
third-party artwork without evidence that its terms permit the intended use.
Synthetic test fixtures should be deterministic and clearly identified.

The bundled blonde default-character chain is verified under the scoped
`LicenseRef-Poppet-Scoped-Artwork`; see `ASSETS_LICENSE.md`. It is not MIT-licensed
or available for standalone reuse. New or replacement artwork still requires its
own truthful provenance, copyright owner, licence, redistribution scope, and
evidence before it can enter a package or public repository.

## Licensing

By submitting source-code or documentation changes, you agree that your
contribution may be distributed under the MIT license in `LICENSE`. Asset terms
must be stated separately and must be compatible with redistribution.
