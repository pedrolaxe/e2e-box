# Contributing to e2e-box

Thanks for helping! Bug reports, flows that break, docs fixes and new Maestro commands are all welcome.

## Setup

You need Node 18+ (22 recommended), [pnpm](https://pnpm.io), `adb` and an Android device with USB debugging on (or an emulator).

```bash
pnpm install
pnpm dev          # dashboard at http://127.0.0.1:3334
pnpm e2e flows/   # CLI from source (tsx)
```

Before opening a pull request:

```bash
pnpm typecheck
pnpm build:cli    # dist/cli.js, the file published to npm
```

CI runs the same checks plus `pnpm build` on every push and pull request.

## Project layout

| Path | What it does |
|---|---|
| `src/lib/engine.ts` | Runs the flow commands |
| `src/lib/hierarchy.ts` | Parses `uiautomator dump` and matches selectors |
| `src/lib/adb.ts` | adb wrapper |
| `src/lib/flows.ts` | YAML parsing and workspaces |
| `src/lib/config.ts` | `e2e-box.config.json`, flow folders (`.e2e-box/`, `.maestro/`) |
| `src/lib/hub.ts` | Server state: one run per device, events |
| `src/lib/lock.ts` | Per-device lock shared by the dashboard and the CLI |
| `src/lib/agent.ts` + `agent/src/` | On-device agent (fast screen reads, accented text) |
| `src/lib/i18n.tsx` | Dashboard texts (Brazilian Portuguese and English) |
| `src/app/api/*` | API routes (SSE events, video/screenshot mirror, actions) |
| `bin/e2e-box.ts` | CLI; `scripts/build-cli.mjs` bundles it into `dist/cli.js` |

`src/lib` uses relative imports (no `@/` alias) so the CLI runs with `tsx` and bundles with esbuild.

## Common changes

- **New Maestro command**: add it to the `switch` in `execCommand` (`src/lib/engine.ts`) and to the commands table in the README.
- **New dashboard text**: add it to both languages in `src/lib/i18n.tsx`; never hardcode UI strings.
- **Agent changes** (`agent/src`): rebuild with `node agent/build.mjs` (JDK 17+ and Android SDK with build-tools) and commit `agent/dist/e2e-box-agent.jar`.

## Testing on a real device

- `back` can leave the app, so the next tap may land on the launcher; check the screen before tapping by coordinates.
- The dashboard and the CLI cannot run flows on the same device at the same time (they would kill each other's agent).
- `flows/configuracoes.yaml` runs on any Android device and is a quick sanity check.

## Pull requests

- Keep each pull request focused on one change and describe how you tested it (device, Android version, emulator or real).
- Update the README when behavior or commands change, and add a line to the `Unreleased` section of `CHANGELOG.md`.
- Security issues: please do not open a public issue; see [SECURITY.md](SECURITY.md).

## Releasing (maintainers)

```bash
npm version patch          # or minor / major: bumps package.json, commits and tags
npm publish                # prepublishOnly runs typecheck and build:cli
git push --follow-tags
gh release create vX.Y.Z --generate-notes
```

Move the `Unreleased` entries in `CHANGELOG.md` under the new version before running `npm version`.
