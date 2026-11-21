# Contributing

This is a research prototype published for reference. Small, well-scoped fixes and
documentation corrections are welcome; large redesigns probably belong in a fork.

## Before you open a pull request

```sh
pnpm install
pnpm check          # typecheck + tests + build
npm pack --dry-run  # what the published package would contain
```

`pnpm check` must pass. If a change touches the packaging (`package.json` `files`,
`exports`, `engines`), say so in the pull request description and paste the
`npm pack --dry-run` file list.

## What belongs here, and what belongs upstream

The code originates in [`deepseek-ai/dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype)
(MIT). Fixes that are about the agent's behavior are usually better proposed there;
this repository maintains the packaging, the README and the release process. Say in
your pull request which of the two you are changing.

## Rules the code depends on

- **No secrets in the tree.** No tokens, cookies, private keys, app secrets, chat or
  user ids, internal hosts, or operator-specific absolute paths. Examples use
  `<placeholders>` and documentation addresses (`/home/me`, `acme/widgets`).
- **Keep the compatibility surface explicit.** `engines.dsh` and the pinned
  `@deepseek-ai/*` peer versions are what DSH's own gate checks. Changing them is a
  breaking change and must appear in `CHANGELOG.md`.
- **Tests do not reach the network.** The suite uses fixtures; a test that needs a
  real GitHub account, a real bot or a real repository does not go in `tests/`.
- **Both READMEs move together.** `README.md` is English and `README.zh-CN.md` is Chinese; each
  links to the other, and the version line at the top of both must match `package.json`. A
  change to one that leaves the other stale is a defect.
- **Documented behavior is what is true.** If something is planned or unverified,
  the README says so.

## Commit messages

Conventional Commits style is appreciated (`fix:`, `feat:`, `docs:`, `chore:`), with
a body that explains why. Keep a change and its test in the same commit.

## License

By contributing you agree that your contribution is licensed under the MIT license in
[LICENSE](LICENSE).
