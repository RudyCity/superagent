# Desktop application management and security approval

Date: 2026-11-09

## Scope

The native `desktop_ui` and principal-bound MCP `superagent_desktop_ui` keep their existing window-session behavior and add explicit application/package commands:

- `list_installed_apps`
- `launch_app`
- `focus_window`
- `close_app`
- `restart_app`
- `plan_package_change`
- `apply_package_change`
- `inspect_security_prompts`

`open` still means “open a scoped Desktop UI session for an already-existing exact window.” It does not launch an application. Application launch is only `launch_app`.

## Application lifecycle

Windows implements app discovery, launch, exact-window focus, graceful close and guarded restart. macOS and Linux additionally have exact-identity lifecycle backends, but real-host certification is pending.

`list_installed_apps` discovers launchable Windows entries from `Get-StartApps` and strict-offline package inventory when available. Default Windows behavior skips WinGet listing because the WinGet CLI cannot guarantee a hard no-network operation, and reports that limitation. The same response includes registeredPrograms (name, version and publisher only) from HKLM/HKCU uninstall registry keys without executing uninstall commands. These are informational records, NOT trusted WinGet package IDs or executable launch targets. Registry inventory is bounded and reports truncation. `launch_app` accepts only an exact application ID returned by fresh Start-app discovery, rejects paths and URL schemes, and launches through the trusted Windows Explorer `shell:AppsFolder\<id>` mechanism. No model-supplied executable path is run.

`focus_window` and `close_app` require an exact PID plus native HWND identity and existing host consent. The Windows provider validates HWND ownership immediately before using `SetForegroundWindow` or posting `WM_CLOSE`. It does not use `taskkill`, `Stop-Process`, `TerminateProcess`, or another force-kill path.

`restart_app` performs the same exact graceful close, waits for that window to disappear, and only then launches the freshly verified app ID. If graceful close does not complete, restart aborts without killing the process.

macOS lists bounded application bundles, resolves unique bundle identifiers through /usr/bin/plutil and launches verified bundle IDs through /usr/bin/open -b. Linux lists visible .desktop entries and launches verified desktop-entry IDs through /usr/bin/gtk-launch; the Exec field is never passed to a shell. Both use fixed executables and fail closed on ambiguous entries. macOS exact-window focus/close now match the CoreGraphics window ID, owning PID and AX window geometry before performing AXRaise or pressing the unique AXCloseButton. Linux matches AT-SPI PID, exact window title and unique top-level accessibility role; focus/close use only AT-SPI focus or the explicitly named close action on verified X11 sessions. Wayland remains denied. Restarts on macOS/Linux require the previously approved window close AND verified process exit; a lingering process aborts the restart. macOS/Linux lifecycle remains source/mock tested from Windows; actual macOS/Linux host certification and compositor/Accessibility permission behavior are not yet verified.

## Package inventory and changes

Package IDs, source names, and versions use bounded token validation. Raw command strings, executable paths, URLs, shell fragments, and arbitrary CLI flags are not accepted.

- Windows resolves WinGet from the signed App Installer package location under WindowsApps and invokes it through a fixed PowerShell wrapper for approved mutations. Default package inventory is strict-offline and therefore disabled before WinGet CLI execution; `list_installed_apps` still returns local Start-app discovery plus an explicit limitation. An internal test-only/provider opt-in covers bounded `winget list --count`, but the model-facing manager never enables it. Mutation uses exact `--id ... --exact --disable-interactivity` and never injects `--accept-source-agreements`, other broad agreement acceptance, or `--silent`.
- macOS accepts Homebrew only from `/opt/homebrew/bin/brew` or `/usr/local/bin/brew`, lists formulae/casks locally, and uses argument arrays with shell execution disabled.
- Linux lists installed packages through trusted `/usr/bin/apt` or `/usr/bin/dnf` paths. Mutation is fail-closed because the current architecture has no separate operator-owned privileged terminal integration. SuperAgent never invokes `sudo` or `pkexec` for package changes.

A reinstall plan is explicitly destructive: uninstall first, then install. Its plan states that a failed second step can leave the package absent.

If a package manager is unavailable, list_installed_apps still returns launchable app entries on macOS and Linux and reports that package inventory is unavailable. Package IDs reject drive-letter pseudo-paths and command fragments.

WinGet can use configured package sources to enrich installed-package information and its CLI does not expose a strict installed-only/offline switch. To honor the no-network contract, the model-facing Windows manager fails closed before CLI package enumeration. Package plans can still name an exact ID/source/version, but current installed version is marked unverified under this mode; apply remains blocked on one-shot human approval and uses `--exact`. A future Windows helper may use the WinGet COM `InstalledPackageInformationOnly` catalog, which is specifically designed to avoid external resources. Start-app discovery is local today.

## Human-only package approval

`plan_package_change` creates a canonical operation plan and SHA-256 digest. The approval request is bound to:

- operation digest
- package manager/package/action target
- authenticated principal
- random invocation ID
- short expiry

The model-facing tools do not expose an `approved` field and cannot approve requests. `apply_package_change` now displays a native, deny-default local host dialog if the exact request is not already approved, showing principal, action, package, manager, source, version, side effects and SHA-256 digest. On Windows this uses a local WinForms Yes/No warning (default No); macOS uses an AppleScript dialog (default Deny), and Linux uses Zenity with explicit Deny. Dialogs time out and fail closed on errors, headless sessions or absent GUI tooling. Only one host dialog may be active at once. A declined or failed confirmation cancels its pending operation; a new plan is required before retrying. The dialog is separate from the model-supplied arguments; the model cannot approve with `approved: true`. Host approvals are tied to the same request/digest/principal/invocation and are consumed once. A separate trusted host process may also call `DesktopHumanApprovalManager.approveHostRequest(...)`; this approval method is deliberately not registered as a Desktop UI or MCP command. This native UI confirmation is not an OS-privilege grant; any separate UAC/polkit authorization still requires a real person on the OS security surface.

`apply_package_change` consumes the approved binding once. Missing approval, expiry, principal mismatch, target mismatch, digest mismatch, or invocation mismatch fails closed before the package provider runs.

MCP remains classified `dangerous`, requires its existing write authorization/YOLO gates, remains principal-bound, and rejects SSH/chain workspaces before host dispatch.

## UAC, firewall, and administrator prompts

`inspect_security_prompts` is read-only.

On Windows it can report the presence of the system `consent.exe` process and signer evidence when available. That is evidence of a UAC consent surface, not proof of the requested elevated target. UAC secure-desktop content is intentionally not read, clicked, bypassed, or answered. Firewall consent dialogs are not reliably attributable from ordinary user mode and are never auto-approved or converted into firewall-rule changes.

On macOS, protected authorization/password dialogs are not inspected because they may expose credentials. On Linux, polkit/admin prompt discovery is desktop/compositor-specific and is reported as unsupported. Neither platform receives automated administrator credentials or approval.

## Audit privacy

Desktop UI audit sanitization redacts session/auth tokens, typed text, screenshots, window metadata, application/package metadata, and approval bindings. Approval IDs, invocation IDs, operation digests, package IDs, app IDs, versions, and sources are not emitted into the normal Desktop UI audit payload.

## Verification rules

Tests use mocked process runners for native dialogs, launch, focus, close, package mutation, and security-prompt flows. macOS/Linux native GUI actions are only mock-certified on Windows. No test installs/removes packages, launches a foreground application, changes firewall rules, grants elevation, or clicks UAC.
