// Scoped PrintWindow capture. The frame is rendered only from the verified root
// HWND; there is no screen-region fallback. PrintWindow is retried a bounded
// number of times because GPU-composited windows intermittently refuse a frame
// while they paint, and the target is re-verified before every attempt.
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Threading;

namespace DesktopHost
{
    internal static class CaptureCommand
    {
        private const int MaxAttempts = 3;
        private const int RetryDelayMs = 120;
        private const int MinPngBytes = 24;
        private const int MaxPngBytes = 8 * 1024 * 1024;

        internal static void Execute(int pid, long hwndValue, TextWriter stdout)
        {
            WindowDescriptor before = WindowVerifier.Verify(pid, hwndValue, WindowPurpose.Capture);
            byte[] png = null;
            for (int attempt = 1; attempt <= MaxAttempts; attempt++)
            {
                png = CaptureOnce(new IntPtr(hwndValue), before.Width, before.Height);
                if (png != null) break;
                if (attempt == MaxAttempts) break;
                Thread.Sleep(RetryDelayMs);
                before = WindowVerifier.Verify(pid, hwndValue, WindowPurpose.Capture);
            }
            if (png == null)
            {
                throw new HostException("SCREENSHOT_UNAVAILABLE", "PrintWindow failed for the scoped HWND.");
            }
            WindowDescriptor after = WindowVerifier.Verify(pid, hwndValue, WindowPurpose.Capture);
            if (after.X != before.X || after.Y != before.Y ||
                after.Width != before.Width || after.Height != before.Height)
            {
                throw new HostException("SCREENSHOT_UNAVAILABLE", "Target window geometry changed during capture.");
            }

            JsonBuilder builder = new JsonBuilder();
            builder.StartObject();
            builder.Name("type").Value("frame");
            builder.Name("png").Value(Convert.ToBase64String(png));
            builder.Name("window");
            ProtocolJson.WriteWindow(builder, after);
            builder.EndObject();
            stdout.WriteLine(builder.ToString());
        }

        /// <summary>One bitmap render attempt; null means PrintWindow refused.</summary>
        private static byte[] CaptureOnce(IntPtr hwnd, int width, int height)
        {
            using (Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
            using (Graphics graphics = Graphics.FromImage(bitmap))
            {
                IntPtr deviceContext = graphics.GetHdc();
                bool captured;
                try
                {
                    captured = NativeMethods.PrintWindow(hwnd, deviceContext, NativeMethods.PwRenderFullContent);
                }
                finally
                {
                    graphics.ReleaseHdc(deviceContext);
                }
                if (!captured) return null;
                using (MemoryStream stream = new MemoryStream())
                {
                    bitmap.Save(stream, ImageFormat.Png);
                    if (stream.Length < MinPngBytes || stream.Length > MaxPngBytes) return null;
                    return stream.ToArray();
                }
            }
        }
    }
}
