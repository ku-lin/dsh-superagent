# Changelog

All notable changes to this repository are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims at
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because this package ships inside DeepSeek Harness, the `engines.dsh` range is part
of the compatibility surface: a change that raises it is a breaking change, even
while the version stays in `0.x`.

## [0.1.0] - 2026-11-19

First public release of this repository. It repackages the MIT-licensed research
prototype from [`deepseek-ai/dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype)
as a standalone plugin repository; the code is unchanged apart from packaging and
documentation.

### Added

- Standalone packaging: `private` removed, `repository`/`bugs`/`homepage`/`keywords`/
  `publishConfig` added, `files` extended with `examples` and `CHANGELOG.md`, and a
  `prepublishOnly` build hook so `npm publish` never ships a stale `lib/`.
- `README.md` restructured: install steps, minimal example, configuration reference,
  permissions and security notes, compatibility table and known limitations.
- `CONTRIBUTING.md`, this changelog, and a wider `.gitignore` (state directory,
  sqlite/WAL, local secrets and editor noise).
- GitHub Actions CI: typecheck, unit tests and `npm pack --dry-run` on Node 22.19
  and 24. It uses the public npm registry only and needs no secrets.

### Notes

- The bundle entry points, agent presets (`dsh-superagent-router`,
  `dsh-superagent-worker`) and the `/orchestrator/api/` surface are unchanged, so an
  existing profile configured against the upstream prototype keeps working.
- Not published to npm; install from source with `pnpm install && pnpm build`.
