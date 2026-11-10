# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Contributing guide, security policy, code of conduct, and issue and pull request templates.
- npm version badge in the README.

## [1.0.1] - 2026-11-10

No changes to the CLI or the published package contents.

### Added

- GitHub Actions workflow: typecheck, dashboard build, CLI build, CLI smoke test and npm package check on every push
  and pull request.

## [1.0.0] - 2026-11-10

First public release.

### Added

- CLI published on npm with no runtime dependencies (`npx e2e-box`); needs only Node 18+ and `adb`.
- Runs the `.e2e-box/` and `.maestro/` folders of the current directory when called without a target; Maestro's
  `config.yaml` is not treated as a flow.
- Maestro-style YAML flows, including `onFlowStart`, `runFlow`, `repeat`, `retry`, relative selectors and `${VAR}`
  variables, plus the `wait` extension.
- On-device agent (`app_process`, no APK) that reads the screen in ~20ms and types accented text, with a per-session
  random socket and secret and an HMAC handshake.
- Local dashboard: live device mirror (H.264 video with screenshot fallback), live log, step queue, inspector, flow
  recorder, run timeline with a screenshot per step, and a 5x button to catch flaky flows.
- Test confidence checks: "passed without checks" warning, fragile-step lint with selector suggestions, preconditions,
  and running a single step or from the cursor.
- Multiple devices in parallel, disconnect detection and screen rotation support.
- Dashboard available in English and Brazilian Portuguese.

[Unreleased]: https://github.com/pedrolaxe/e2e-box/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/pedrolaxe/e2e-box/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/pedrolaxe/e2e-box/releases/tag/v1.0.0
