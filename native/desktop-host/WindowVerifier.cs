// Target-window verification and descriptor projection. Every request carries
// (pid, hwnd); identity is proven by HWND + owner PID + root-window ancestry,
// never by a title supplied by the caller. Titles are reported, not pinned: the
// client keeps its own target identity and re-checks it after every frame.
using System;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace DesktopHost
{
    internal enum WindowPurpose
    {
        Capture,
        Inspect,
    }

    internal sealed class HostException : Exception
    {
        internal readonly string Code;

        internal HostException(string code, string message)
            : base(message)
        {
            Code = code;
        }
    }

    internal sealed class WindowDescriptor
    {
        internal int Pid;
        internal string NativeId;
        internal string Title;
        internal bool Active;
        internal double ScaleFactor;
        internal int X;
        internal int Y;
        internal int Width;
        internal int Height;
    }

    internal static class WindowVerifier
    {
        private const int MaxWindowDimension = 8192;
        private const long MaxWindowPixels = 16000000;
        private const int MaxTitleLength = 512;

        private static readonly Regex ControlCharacters = new Regex("[\\x00-\\x1F\\x7F]", RegexOptions.Compiled);

        internal static WindowDescriptor Verify(int pid, long hwndValue, WindowPurpose purpose)
        {
            if (pid <= 0) throw new HostException("TARGET_NOT_FOUND", "Invalid target PID.");
            if (hwndValue <= 0) throw new HostException("TARGET_NOT_FOUND", "Invalid target HWND.");
            IntPtr hwnd = new IntPtr(hwndValue);
            if (!NativeMethods.IsWindow(hwnd))
            {
                throw new HostException("TARGET_NOT_FOUND", "Target HWND is not a window.");
            }
            if (!NativeMethods.IsWindowVisible(hwnd))
            {
                throw new HostException("TARGET_NOT_FOUND", "Target window is not visible.");
            }
            if (NativeMethods.GetAncestor(hwnd, NativeMethods.GaRoot) != hwnd)
            {
                throw new HostException("TARGET_NOT_FOUND", "Target HWND is not a root top-level window.");
            }
            uint ownerPid;
            NativeMethods.GetWindowThreadProcessId(hwnd, out ownerPid);
            if ((int)ownerPid != pid)
            {
                throw new HostException("TARGET_NOT_FOUND", "Target HWND is not owned by the requested PID.");
            }
            if (purpose == WindowPurpose.Capture)
            {
                if (NativeMethods.IsIconic(hwnd))
                {
                    throw new HostException("SCREENSHOT_UNAVAILABLE", "Target window is minimized.");
                }
                int cloaked;
                int cloakResult = NativeMethods.DwmGetWindowAttribute(hwnd, NativeMethods.DwmwaCloaked, out cloaked, sizeof(int));
                if (cloakResult != 0 || cloaked != 0)
                {
                    throw new HostException("SCREENSHOT_UNAVAILABLE", "Target window is cloaked.");
                }
                uint affinity;
                if (!NativeMethods.GetWindowDisplayAffinity(hwnd, out affinity) || affinity != 0)
                {
                    throw new HostException("SCREENSHOT_UNAVAILABLE", "Target window has protected display affinity.");
                }
            }
            NativeMethods.Rect rect;
            if (!NativeMethods.GetWindowRect(hwnd, out rect))
            {
                throw new HostException("TARGET_NOT_FOUND", "Target window bounds are unavailable.");
            }
            int width = rect.Right - rect.Left;
            int height = rect.Bottom - rect.Top;
            if (width <= 0 || height <= 0 ||
                width > MaxWindowDimension || height > MaxWindowDimension ||
                (long)width * (long)height > MaxWindowPixels)
            {
                throw new HostException("TARGET_NOT_FOUND", "Target window has unusable bounds.");
            }
            uint dpi = NativeMethods.GetDpiForWindow(hwnd);
            if (dpi == 0)
            {
                throw new HostException("DPI_CONTEXT_UNAVAILABLE", "Target window DPI is unavailable.");
            }
            int titleLength = NativeMethods.GetWindowTextLength(hwnd);
            int titleCapacity = Math.Max(1, Math.Min(MaxTitleLength + 1, titleLength + 1));
            StringBuilder titleBuffer = new StringBuilder(titleCapacity);
            NativeMethods.GetWindowText(hwnd, titleBuffer, titleBuffer.Capacity);
            string title = CleanText(titleBuffer.ToString());
            if (title.Length > MaxTitleLength) title = title.Substring(0, MaxTitleLength);

            WindowDescriptor descriptor = new WindowDescriptor();
            descriptor.Pid = pid;
            descriptor.NativeId = hwndValue.ToString(CultureInfo.InvariantCulture);
            descriptor.Title = title;
            descriptor.Active = NativeMethods.GetForegroundWindow() == hwnd;
            descriptor.ScaleFactor = dpi / 96.0;
            descriptor.X = rect.Left;
            descriptor.Y = rect.Top;
            descriptor.Width = width;
            descriptor.Height = height;
            return descriptor;
        }

        internal static string CleanText(string value)
        {
            if (string.IsNullOrEmpty(value)) return string.Empty;
            return ControlCharacters.Replace(value, string.Empty);
        }
    }
}
