// Startup privilege hardening for the Desktop UI host.
//
// The host only needs to read the signed-in user's own medium-integrity windows:
// PrintWindow paints a scoped HWND and UIAutomation reads the same-session tree.
// Neither operation needs a dangerous token privilege, and an elevated helper is
// a privilege-escalation path because the Core feeds it caller-derived PIDs and
// HWNDs. Therefore:
// - an elevated token is refused before any window is touched (typed error line,
//   non-zero exit);
// - every privilege the host does not need is removed from its own token with
//   SE_PRIVILEGE_REMOVED (falling back to disabling it), so even code execution
//   inside the host cannot re-enable it;
// - failure to remove a dangerous privilege is fatal (fail closed).
//
// Kept privilege: SeChangeNotifyPrivilege (bypass traverse checking). Windows
// enables it by default and the CLR, file and registry access all rely on it for
// path traversal; disabling it can break ordinary process operation without
// reducing the capture/UIA attack surface, so it is intentionally not touched.
// No other privilege is required: PrintWindow, UIAutomation and DPI queries run
// at the caller's integrity level and are gated by window/process ACLs, not by
// token privileges.
//
// Containment scope and residual risk (deliberate, measured): this helper is
// NOT AppContainer- or low-integrity-contained. A low-integrity token loses
// PrintWindow capture (Win32 5, ERROR_ACCESS_DENIED) and process read rights
// against the signed-in user's medium-integrity windows; AppContainer is
// stricter still because a package process has no default access to the
// interactive window station/desktop, so window enumeration, UIA and capture
// would need ACL grants that reopen exactly what containment should deny. The
// supported escape hatch (a UIAccess token) requires a binary signed with a
// trusted certificate, installed under a secure path and approved through UAC,
// i.e. the elevation this host refuses. The host therefore stays a medium-IL
// same-user process and bounds its blast radius behaviourally: elevation
// refusal, permanent removal of dangerous privileges, nonce handshake, strict
// framing, per-request window re-validation and the bounded request/lifetime
// budget in HostBudget.cs. The residual risk (a memory defect inside the host
// runs as the user for at most one bounded host lifetime, without dangerous
// privileges and without elevated-window access) is documented in
// docs/reports/2026-11-27-desktop-ui-remaining-items.md.
using System;
using System.Runtime.InteropServices;

namespace DesktopHost
{
    internal static class PrivilegeGuard
    {
        internal const string ElevatedCode = "ELEVATED_TOKEN";
        internal const string HardeningFailedCode = "PRIVILEGE_HARDENING_FAILED";
        internal const string TokenUnavailableCode = "TOKEN_UNAVAILABLE";

        /// <summary>
        /// Privileges removed from the host token. Order is stable so the ready
        /// line and diagnostics are diffable.
        /// </summary>
        private static readonly string[] DangerousPrivileges = new string[]
        {
            "SeDebugPrivilege",
            "SeImpersonatePrivilege",
            "SeTakeOwnershipPrivilege",
            "SeLoadDriverPrivilege",
            "SeTcbPrivilege",
            "SeAssignPrimaryTokenPrivilege",
            "SeIncreaseQuotaPrivilege",
            "SeBackupPrivilege",
            "SeRestorePrivilege",
            "SeShutdownPrivilege",
        };

        /// <summary>
        /// Refuse elevation and strip every dangerous privilege. Returns false
        /// with a typed protocol code and a safe message; the caller writes the
        /// error line and exits non-zero. Never throws.
        /// </summary>
        internal static bool TryHarden(out string failureCode, out string failureMessage, out int privilegesRemoved)
        {
            failureCode = null;
            failureMessage = null;
            privilegesRemoved = 0;
            IntPtr token = IntPtr.Zero;
            try
            {
                if (!NativeMethods.OpenProcessToken(
                    NativeMethods.GetCurrentProcess(),
                    NativeMethods.TokenAdjustPrivileges | NativeMethods.TokenQuery,
                    out token))
                {
                    failureCode = TokenUnavailableCode;
                    failureMessage = "The host process token could not be opened for hardening.";
                    return false;
                }
                bool elevated;
                string elevationError;
                if (!TryReadElevation(token, out elevated, out elevationError))
                {
                    failureCode = TokenUnavailableCode;
                    failureMessage = elevationError;
                    return false;
                }
                if (elevated)
                {
                    failureCode = ElevatedCode;
                    failureMessage = "The Desktop UI host refuses to run elevated; capture and inspection of the user's own windows do not require elevation.";
                    return false;
                }
                for (int index = 0; index < DangerousPrivileges.Length; index++)
                {
                    string name = DangerousPrivileges[index];
                    PrivilegeOutcome outcome;
                    uint errorCode;
                    if (!TryRemovePrivilege(token, name, out outcome, out errorCode))
                    {
                        failureCode = HardeningFailedCode;
                        failureMessage = "The token privilege " + name + " could not be removed (Win32 error " +
                            errorCode.ToString(System.Globalization.CultureInfo.InvariantCulture) + ").";
                        return false;
                    }
                    if (outcome != PrivilegeOutcome.NotHeld) privilegesRemoved++;
                }
                return true;
            }
            catch (Exception)
            {
                // A P/Invoke or marshalling surprise must fail closed too.
                failureCode = HardeningFailedCode;
                failureMessage = "Token privilege hardening failed unexpectedly.";
                return false;
            }
            finally
            {
                if (token != IntPtr.Zero)
                {
                    try
                    {
                        NativeMethods.CloseHandle(token);
                    }
                    catch (Exception)
                    {
                    }
                }
            }
        }

        private static bool TryReadElevation(IntPtr token, out bool elevated, out string error)
        {
            elevated = false;
            error = null;
            NativeMethods.TokenElevation elevation;
            int returnedLength;
            if (!NativeMethods.GetTokenInformation(
                token,
                NativeMethods.TokenElevationClass,
                out elevation,
                Marshal.SizeOf(typeof(NativeMethods.TokenElevation)),
                out returnedLength))
            {
                error = "The host elevation state could not be queried; the host refuses to start without it.";
                return false;
            }
            elevated = elevation.TokenIsElevated != 0;
            return true;
        }

        /// <summary>How a dangerous privilege was neutralized.</summary>
        private enum PrivilegeOutcome
        {
            NotHeld,
            Removed,
            Disabled,
        }

        /// <summary>
        /// Removes one privilege permanently, falling back to disabling it. A
        /// privilege the token does not hold cannot be abused, so
        /// ERROR_NOT_ALL_ASSIGNED and ERROR_NO_SUCH_PRIVILEGE are successful
        /// outcomes. Any other failure is fatal.
        /// </summary>
        private static bool TryRemovePrivilege(
            IntPtr token,
            string name,
            out PrivilegeOutcome outcome,
            out uint failureCode)
        {
            outcome = PrivilegeOutcome.NotHeld;
            failureCode = 0;
            NativeMethods.Luid luid;
            if (!NativeMethods.LookupPrivilegeValue(null, name, out luid))
            {
                uint lookupError = (uint)Marshal.GetLastWin32Error();
                if (lookupError == NativeMethods.ErrorNoSuchPrivilege) return true;
                failureCode = lookupError;
                return false;
            }

            NativeMethods.TokenPrivileges removal = new NativeMethods.TokenPrivileges();
            removal.PrivilegeCount = 1;
            removal.Privileges.Luid = luid;
            removal.Privileges.Attributes = NativeMethods.SePrivilegeRemoved;
            uint error;
            if (Apply(token, removal, out error))
            {
                if (error == NativeMethods.ErrorNotAllAssigned || error == NativeMethods.ErrorNoSuchPrivilege)
                {
                    return true;
                }
                outcome = PrivilegeOutcome.Removed;
                return true;
            }
            uint removalError = error;

            // Some builds reject removal for a subset of privileges; disabling is
            // the weaker but still effective fallback.
            NativeMethods.TokenPrivileges disable = new NativeMethods.TokenPrivileges();
            disable.PrivilegeCount = 1;
            disable.Privileges.Luid = luid;
            disable.Privileges.Attributes = 0;
            if (Apply(token, disable, out error))
            {
                if (error == NativeMethods.ErrorNotAllAssigned || error == NativeMethods.ErrorNoSuchPrivilege)
                {
                    return true;
                }
                outcome = PrivilegeOutcome.Disabled;
                return true;
            }
            failureCode = error != 0 ? error : removalError;
            return false;
        }

        /// <summary>
        /// Apply one privilege change. Returns true when the call completed,
        /// with `win32Error` carrying ERROR_NOT_ALL_ASSIGNED when the token did
        /// not hold the privilege; returns false only on a real Win32 failure.
        /// </summary>
        private static bool Apply(IntPtr token, NativeMethods.TokenPrivileges state, out uint win32Error)
        {
            if (!NativeMethods.AdjustTokenPrivileges(token, false, ref state, 0, IntPtr.Zero, IntPtr.Zero))
            {
                win32Error = (uint)Marshal.GetLastWin32Error();
                return false;
            }
            win32Error = (uint)Marshal.GetLastWin32Error();
            return win32Error == 0 ||
                win32Error == NativeMethods.ErrorNotAllAssigned ||
                win32Error == NativeMethods.ErrorNoSuchPrivilege;
        }
    }
}
