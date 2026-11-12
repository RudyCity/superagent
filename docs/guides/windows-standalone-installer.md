# SuperAgent Windows x64 standalone installer

The Windows NSIS setup bundles **SuperAgent Tray**, the native **superagent.exe** CLI launcher,
a pinned **Bun 1.4.2** executable, the compiled Core distribution, and its locked **production
node_modules**. The CLI can launch without the user installing Bun, Node.js, or Git.

## Install prebuilt on ordinary Windows PCs (no Rust or MSVC)

A fresh `git clone` contains the native Tray **source**, not compiled `.exe` build products. End users should download the precompiled, integrity-checked NSIS installer from [official GitHub Releases](https://github.com/RudyCity/superagent/releases), which includes Tray, Core, Bun, and the CLI. **MSVC and Rust are required on CI/build machines only, not on the target PC.**

If Bun is already installed for source development, use `bun run tray:prebuilt:check`, `bun run tray:prebuilt:download`, or `bun run tray:prebuilt:install` to select an official Windows release and validate it against that release’s SHA256SUMS.txt before launch. A release version mismatch with the checkout is rejected by default; review the version and use `bun scripts/install-prebuilt-windows.ts --install --allow-version-mismatch` only if you explicitly accept the older prebuilt release. `--check` is read-only, `--download` does not run the setup, and no build tools are downloaded or silently installed. The published installer may be unsigned; the manifest hash verifies download integrity, not the publisher’s code-signing identity.

## Build and verify

On an authorized Windows x64 machine with Rust/MSVC, Bun 1.4.2, and the repository installed:

```powershell
bun install --frozen-lockfile
bun run installer:build
```

The command compiles Core, compiles the native CLI, stages frozen production dependencies,
runs a sanitized-PATH portable CLI smoke test, then builds the NSIS installer with Tauri 2.
It does not install or start the compiled application. The expected artifact is:

`apps/superagent-tray/src-tauri/target/release/bundle/nsis/SuperAgent_<version>_x64-setup.exe`

The generated Core/dependency stage and sidecar runtime binaries are ignored by Git.
The `tauri.standalone.conf.json` overlay is used only by Windows standalone packaging;
normal Cargo builds and non-Windows Tauri builds remain unchanged.

## Installation and usage

Run the `-setup.exe` on Windows 10/11 x64, then open SuperAgent from the Start menu
or launch `superagent` from a **new terminal window**. The NSIS installer uses a
current-user install and adds the installation directory to user PATH **only if it is not
already present**. On uninstall it removes only the PATH addition that this installer made.

An unsigned release candidate may trigger Microsoft SmartScreen; verify the release's
SHA-256 checksum and publisher/source before executing. Code signing and a clean-machine
installation/upgrade/uninstall acceptance matrix remain separate production release gates.
The release candidate does not automatically change live Core/MCP owners or reuse OAuth
credentials. Existing runtimes must be restarted by their authorized owners.

The bundled runtime covers the TypeScript Core and npm packages. It **does not** silently
install Microsoft Office, LibreOffice, Python packages such as PyMuPDF/rembg, proprietary
AI weights, Chrome or WebView2 dependencies that may be required for optional features.
Such capabilities should report unavailable until provisioned.

## GitHub CI and release candidates

- `.github/workflows/tray-build.yml` verifies Core/extension, Rust tests and Windows
  standalone payloads on main/PR and preserves normal Linux/macOS tray packaging.
- `.github/workflows/release-windows-standalone.yml` is triggered by a signed-off
  release-candidate tag of the form `v<package-version>-rc.<number>`. The workflow
  compares the tag with package metadata, runs bounded regression and native Rust tests,
  builds a fresh standalone NSIS installer, installs it onto a disposable GitHub runner, verifies the installed CLI without global Bun/Node, and uninstalls it before publishing
  the EXE and `SHA256SUMS.txt` as a **GitHub prerelease**.
- A successful local build is not a public release. Only a completed GitHub release
  workflow with downloadable, matching SHA-256 assets counts as published.
- MSI standalone packaging is not part of this candidate. WiX linking of the full
  production dependency tree needs separate bounded-runtime and clean-install tests.

Do not promote this release candidate into a production runtime cutover until the
repository's R0–R7 release controls and operator approvals are satisfied.

## macOS arm64 and Linux x64 self-contained packages

The Tauri release matrix also packages macOS arm64 into a DMG and Linux x64 into
DEB and AppImage. Each builds a platform-native `superagent` CLI, ships Bun 1.4.2
in the executable directory and stages the same frozen production dependencies
as a `standalone/` resource. On macOS the Core entrypoint is located beneath
`Contents/Resources/standalone/`; on Linux DEB/AppImage under the Tauri
application library resource directory. The CLI uses platform-specific relative
paths and does not require a system-wide Bun or Node installation.

To build on the matching host:

```bash
bun install --frozen-lockfile
bun run installer:build:unix
```

GitHub CI tests the unbundled CLI with PATH excluding Bun/Node and validates
macOS .app resource content or extracts the Linux DEB and runs its installed CLI.
Both checks must pass before a multi-OS prerelease can be published. DMG and
AppImage are **not** a promise of platform code-signing/notarization; distributing
unsigned beta installers may trigger platform security prompts. Linux also needs
the usual host GTK/WebKit runtime dependencies; a self-contained JS runtime does
not statically bundle every system UI library.
