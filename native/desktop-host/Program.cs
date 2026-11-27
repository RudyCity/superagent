// Single native Desktop UI host: one WinExe process that serves both scoped
// PrintWindow capture and UIAutomation inspection over a strict JSON-lines
// protocol on stdin/stdout.
//
// Hardening rules (fail closed, never recover):
// - one command per line; a line above 2 MB, malformed JSON, or the third
//   protocol violation terminates the process with a non-zero exit code;
// - no caller-supplied path, script, argument or file name is ever accepted;
// - UTF-8 output through one StreamWriter, flushed per line, no stdout logging
//   and no stdin echo, so stdout is protocol-only;
// - the ready line echoes a Core-generated nonce from the environment; a host
//   started without a nonce exits without ever printing ready.
using System;
using System.Globalization;
using System.IO;
using System.Text;

namespace DesktopHost
{
    internal static class Program
    {
        private const int MaxCommandChars = 2 * 1024 * 1024;
        private const int MaxProtocolViolations = 3;
        private const string NonceEnvironmentVariable = "SUPERAGENT_DESKTOP_HOST_NONCE";
        private const string CloseCommand = "close";
        private const string CaptureCommandName = "capture";
        private const string InspectCommandName = "inspect";

        private const int ExitClean = 0;
        private const int ExitDpiUnavailable = 2;
        private const int ExitProtocolViolations = 3;
        private const int ExitMalformedJson = 4;
        private const int ExitMissingNonce = 5;
        private const int ExitUnexpected = 6;

        [STAThread]
        private static int Main()
        {
            StreamWriter stdout = new StreamWriter(
                Console.OpenStandardOutput(),
                new UTF8Encoding(false),
                4096);
            stdout.AutoFlush = true;
            StreamReader stdin = new StreamReader(
                Console.OpenStandardInput(),
                new UTF8Encoding(false),
                false,
                4096);
            try
            {
                string nonce = Environment.GetEnvironmentVariable(NonceEnvironmentVariable);
                if (string.IsNullOrEmpty(nonce)) return ExitMissingNonce;
                if (!DpiAwareness.EnablePerMonitorV2())
                {
                    ProtocolJson.WriteError(stdout, "DPI_CONTEXT_UNAVAILABLE", "PER_MONITOR_AWARE_V2 could not be established.");
                    return ExitDpiUnavailable;
                }
                JsonBuilder ready = new JsonBuilder();
                ready.StartObject();
                ready.Name("type").Value("ready");
                ready.Name("nonce").Value(nonce);
                ready.EndObject();
                stdout.WriteLine(ready.ToString());
                return RunCommandLoop(stdin, stdout);
            }
            catch (Exception)
            {
                // Never write diagnostics to stdout: they would corrupt the
                // protocol stream the Core is parsing.
                return ExitUnexpected;
            }
            finally
            {
                try
                {
                    stdout.Flush();
                }
                catch (Exception)
                {
                }
            }
        }

        private static int RunCommandLoop(TextReader stdin, TextWriter stdout)
        {
            int violations = 0;
            while (true)
            {
                bool oversized;
                string line = ReadBoundedLine(stdin, MaxCommandChars, out oversized);
                if (oversized)
                {
                    // A single oversized line is a framing violation: fail closed
                    // immediately instead of draining attacker-sized input.
                    return ExitProtocolViolations;
                }
                if (line == null) return ExitClean;

                JsonValue command;
                try
                {
                    command = JsonParser.Parse(line);
                }
                catch (JsonParseException)
                {
                    ProtocolJson.WriteError(stdout, "PROTOCOL_MALFORMED", "Malformed JSON command line.");
                    return ExitMalformedJson;
                }

                string commandName;
                if (!TryReadCommandName(command, out commandName))
                {
                    violations++;
                    ProtocolJson.WriteError(stdout, "PROTOCOL_INVALID", "Command must be an object with a string cmd field.");
                    if (violations >= MaxProtocolViolations) return ExitProtocolViolations;
                    continue;
                }
                if (string.Equals(commandName, CloseCommand, StringComparison.Ordinal))
                {
                    return ExitClean;
                }
                if (!string.Equals(commandName, CaptureCommandName, StringComparison.Ordinal) &&
                    !string.Equals(commandName, InspectCommandName, StringComparison.Ordinal))
                {
                    violations++;
                    ProtocolJson.WriteError(stdout, "PROTOCOL_INVALID", "Unknown command.");
                    if (violations >= MaxProtocolViolations) return ExitProtocolViolations;
                    continue;
                }

                int pid;
                long hwnd;
                if (!TryReadTarget(command, out pid, out hwnd))
                {
                    violations++;
                    ProtocolJson.WriteError(stdout, "PROTOCOL_INVALID", "Command requires a positive integer pid and a decimal hwnd string.");
                    if (violations >= MaxProtocolViolations) return ExitProtocolViolations;
                    continue;
                }

                try
                {
                    if (string.Equals(commandName, CaptureCommandName, StringComparison.Ordinal))
                    {
                        CaptureCommand.Execute(pid, hwnd, stdout);
                    }
                    else
                    {
                        InspectCommand.Execute(pid, hwnd, stdout);
                    }
                }
                catch (HostException error)
                {
                    // Operational refusal: the target moved, the window closed or
                    // PrintWindow failed. Report it and keep the host alive; the
                    // Core treats the error line as a refused frame.
                    ProtocolJson.WriteError(stdout, error.Code, error.Message);
                }
            }
        }

        private static bool TryReadCommandName(JsonValue command, out string commandName)
        {
            commandName = null;
            if (command == null || command.Kind != JsonKind.Object) return false;
            JsonValue value;
            if (!command.TryGetMember("cmd", out value) || value == null || value.Kind != JsonKind.String) return false;
            commandName = value.Text;
            return !string.IsNullOrEmpty(commandName);
        }

        private static bool TryReadTarget(JsonValue command, out int pid, out long hwnd)
        {
            pid = 0;
            hwnd = 0;
            JsonValue pidValue;
            if (!command.TryGetMember("pid", out pidValue) || pidValue == null || pidValue.Kind != JsonKind.Number) return false;
            if (pidValue.Number != Math.Floor(pidValue.Number) || pidValue.Number <= 0 || pidValue.Number > int.MaxValue) return false;
            pid = (int)pidValue.Number;
            JsonValue hwndValue;
            if (!command.TryGetMember("hwnd", out hwndValue) || hwndValue == null || hwndValue.Kind != JsonKind.String) return false;
            string text = hwndValue.Text;
            if (string.IsNullOrEmpty(text) || text.Length > 20) return false;
            for (int index = 0; index < text.Length; index++)
            {
                if (text[index] < '0' || text[index] > '9') return false;
            }
            if (!long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out hwnd)) return false;
            return hwnd > 0;
        }

        /// <summary>
        /// Reads one protocol line with a hard character bound. CR/LF are the only
        /// accepted terminators; EOF ends the loop. The caller owns exit policy.
        /// </summary>
        private static string ReadBoundedLine(TextReader reader, int maxChars, out bool oversized)
        {
            oversized = false;
            StringBuilder builder = new StringBuilder(128);
            while (true)
            {
                int next = reader.Read();
                if (next < 0)
                {
                    return builder.Length == 0 ? null : builder.ToString();
                }
                if (next == '\n') return builder.ToString();
                if (next == '\r') continue;
                builder.Append((char)next);
                if (builder.Length > maxChars)
                {
                    oversized = true;
                    return null;
                }
            }
        }
    }

    internal static class DpiAwareness
    {
        private static readonly IntPtr PerMonitorAwareV2 = new IntPtr(-4);

        /// <summary>
        /// Establish per-monitor-v2 DPI awareness for this process and the main
        /// thread. Process-level success is preferred; the thread context is the
        /// hard requirement because UIA and GetWindowRect must report physical
        /// pixels consistently for the whole host lifetime.
        /// </summary>
        internal static bool EnablePerMonitorV2()
        {
            try
            {
                NativeMethods.SetProcessDpiAwarenessContext(PerMonitorAwareV2);
            }
            catch (Exception)
            {
                // Older builds lack the export; the thread context below is the
                // actual requirement and is available on Windows 10 1607+.
            }
            try
            {
                return NativeMethods.SetThreadDpiAwarenessContext(PerMonitorAwareV2) != IntPtr.Zero;
            }
            catch (Exception)
            {
                return false;
            }
        }
    }
}
