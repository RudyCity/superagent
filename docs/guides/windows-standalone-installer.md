# SuperAgent Windows x64 standalone installer

The Windows NSIS setup bundles **SuperAgent Tray**, the native **superagent.exe** CLI launcher,
a pinned **Bun 1.4.2** executable, the compiled Core distribution, and its locked **production
node_modules**. The CLI can launch without the user installing Bun, Node.js, or Git.

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
