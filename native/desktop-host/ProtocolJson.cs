// Shared protocol line writers. Every line is complete JSON terminated by a
// newline; the caller flushes. Field order is fixed so frames are diffable.
using System;
using System.IO;

namespace DesktopHost
{
    internal static class ProtocolJson
    {
        internal static void WriteWindow(JsonBuilder builder, WindowDescriptor window)
        {
            builder.StartObject();
            builder.Name("pid").Value((long)window.Pid);
            builder.Name("nativeId").Value(window.NativeId);
            builder.Name("title").Value(window.Title);
            builder.Name("active").Value(window.Active);
            builder.Name("scaleFactor").Value(window.ScaleFactor);
            builder.Name("bounds");
            builder.StartObject();
            builder.Name("x").Value((long)window.X);
            builder.Name("y").Value((long)window.Y);
            builder.Name("width").Value((long)window.Width);
            builder.Name("height").Value((long)window.Height);
            builder.EndObject();
            builder.EndObject();
        }

        internal static void WriteError(TextWriter stdout, string code, string message)
        {
            JsonBuilder builder = new JsonBuilder();
            builder.StartObject();
            builder.Name("type").Value("error");
            builder.Name("code").Value(code);
            builder.Name("message").Value(WindowVerifier.CleanText(message));
            builder.EndObject();
            stdout.WriteLine(builder.ToString());
        }
    }
}
