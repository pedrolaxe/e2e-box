# Security policy

e2e-box controls a real Android device: the on-device agent reads the screen of any app and types into fields,
including password fields. Security reports are taken seriously.

## Supported versions

Only the latest `1.x` release on npm receives fixes.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub:
**[Security → Report a vulnerability](https://github.com/pedrolaxe/e2e-box/security/advisories/new)**.

Include what you found, how to reproduce it (device, Android version, e2e-box version) and the impact you expect.
You should get a first answer within a week. Once a fix is released, the advisory is published with credit to you,
unless you prefer to stay anonymous.

## What is in scope

- **On-device agent**: each session starts its own agent with a random socket name and secret; it only accepts
  `shell`/root connections, and both sides prove the secret via HMAC before any command. Ways for another app on the
  device to read the screen, receive typed text or send commands are in scope.
- **Dashboard API**: it listens on `127.0.0.1` only and accepts requests with a local `Host`, a same-origin `Origin`
  and JSON bodies (`src/middleware.ts`). Ways for a website opened in the browser to control the device, read or write
  files, or bypass these checks are in scope.
- **Files and workspaces**: workspaces must live inside the folder that contains e2e-box, and subflows inside their
  workspace. Path traversal out of those folders is in scope.
- **Secrets**: test credentials live in `e2e-box.local.json` (git-ignored), and text from `${VAR}` is masked as `•••`
  in logs and reports. Leaks of those values are in scope.

## Out of scope

- Anyone who already has adb or shell access to the device, or a local account on the machine running e2e-box.
- Running the dashboard on a non-local interface or behind a proxy that changes the `Host` header.
- Vulnerabilities in adb, Android or the app under test.
