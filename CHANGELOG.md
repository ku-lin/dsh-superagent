# Changelog

All notable changes to this repository are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims at
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because this package ships inside DeepSeek Harness, the `engines.dsh` range is part
of the compatibility surface: a change that raises it is a breaking change. The
`1.x` line is the first published line; the upstream prototype it is based on called
itself `0.1.0`, which is why this repository starts at `1.0.0` instead.

## [1.0.0] - 2026-11-19

First public release of this repository. It repackages the MIT-licensed research
prototype from [`deepseek-ai/dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype)
(upstream commit `8c32a9d`) as a standalone plugin repository.

### Added

- Standalone packaging: `private` removed, `repository`/`bugs`/`homepage`/`keywords`/
  `publishConfig` added, `files` extended with `docs`, `SETUP.md`, `examples` and
  `CHANGELOG.md`, and a `prepublishOnly` build hook so `npm publish` never ships a
  stale `lib/`.
- `README.md` restructured: install steps, minimal example, configuration reference,
  permissions and security notes, compatibility table and known limitations.
- `CONTRIBUTING.md`, this changelog, `.gitattributes` (LF for every text file, so the
  python3 `scripts/dsh-superagent` keeps a working shebang — the file also keeps its
  executable bit) and a wider `.gitignore` (state directory, sqlite/WAL, local
  secrets and editor noise).
- GitHub Actions CI: typecheck, unit tests and `npm pack --dry-run` on Node 22.19 and
  24, with one retry as insurance for the suite's poll/`waitFor` tests. It uses the
  public npm registry only and needs no secrets.

### Fixed

- `tests/sources.spec.ts` ("feishu event consumer: … reports a malformed line without
  stopping") asserted that the *last* health entry was the JSON error, but the error
  arrives on stdout while `[event] ready` arrives on stderr, and the two streams are
  not ordered against each other — on Linux the ready line is processed last, so the
  assertion failed on every run. The test now records every `ctx.report` and asserts
  the error was reported, which keeps its intent and drops the ordering assumption.
  Product behavior is unchanged.

### Notes

- The bundle entry points, agent presets (`dsh-superagent-router`,
  `dsh-superagent-worker`) and the `/orchestrator/api/` surface are unchanged, so an
  existing profile configured against the upstream prototype keeps working.
- Not published to npm; install from source with `pnpm install && pnpm build`. The
  name `dsh-superagent` is free on the registry, so a later release can claim it.
- `1.0.0` states "this is the released packaging", not "production ready": see the
  disclaimer and known limitations in `README.md`.
