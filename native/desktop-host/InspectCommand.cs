// Bounded UIAutomation tree walk. Semantics mirror the proven persistent
// PowerShell carrier: ControlView first, a bounded Chromium warm-up/settle loop,
// and a RawView fallback only when ControlView is starved. Raw UIA signals are
// emitted so TypeScript keeps the single authority for retention and for the
// security-relevant `actionable` flag; the host also emits its own precomputed
// copy of `actionable`/`center`/`nativeRef` so the wire record is self-describing.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Automation;

namespace DesktopHost
{
    internal sealed class UiRecord
    {
        internal string Role;
        internal string Label;
        internal string Description;
        internal string Value;
        internal int X;
        internal int Y;
        internal int Width;
        internal int Height;
        internal bool Enabled;
        internal bool Offscreen;
        internal bool Focusable;
        internal bool Expandable;
        internal bool Focused;
        internal bool Actionable;
        internal string AutomationId;
        internal string RuntimeId;
        internal string NativeRef;
    }

    internal sealed class WalkResult
    {
        internal List<UiRecord> Records;
        internal int ValidCount;
    }

    internal static class InspectCommand
    {
        // Bounds copied from the live-verified persistent carrier.
        private const int MaxDepth = 24;
        private const int MaxElements = 2000;
        private const int MaxVisited = 6000;
        private const int ControlFallbackMin = 48;
        private const int ChromiumReadyMin = 24;
        private const int ChromiumSettleMs = 180;
        private const int ChromiumAttempts = 3;
        private const int MaxValueReads = 120;
        private const int MaxSiblingScan = 512;
        private const int MaxLabelChars = 512;
        private const int MaxRefChars = 256;
        private const int MaxUsableRectDimension = 100000;
        private const int MaxChildWindows = 16;

        private static readonly HashSet<string> ActionableRoles = new HashSet<string>(StringComparer.Ordinal)
        {
            "button", "edit", "hyperlink", "menuitem", "checkbox", "radiobutton",
            "combobox", "listitem", "tabitem", "slider", "spinner",
        };

        private static readonly HashSet<string> ExpandableRoles = new HashSet<string>(StringComparer.Ordinal)
        {
            "custom", "group", "pane", "dataitem", "treeitem", "listitem",
        };

        private static readonly HashSet<string> ValueRoles = new HashSet<string>(StringComparer.Ordinal)
        {
            "edit", "document", "combobox", "spinner", "text",
        };

        private struct NodeEntry
        {
            internal readonly AutomationElement Node;
            internal readonly int Depth;

            internal NodeEntry(AutomationElement node, int depth)
            {
                Node = node;
                Depth = depth;
            }
        }

        internal static void Execute(int pid, long hwndValue, TextWriter stdout)
        {
            IntPtr hwnd = new IntPtr(hwndValue);
            // Fail fast on an invalid target before paying for the walk.
            WindowVerifier.Verify(pid, hwndValue, WindowPurpose.Inspect);

            bool chromiumSurface;
            List<IntPtr> childHandles = CollectSameProcessChildren(pid, hwnd, out chromiumSurface);
            if (chromiumSurface)
            {
                // Asking Chromium's child HWND for its UIA element starts
                // renderer accessibility; without this the first walk sees a
                // ~20 node skeleton and the real tree appears only later.
                foreach (IntPtr child in childHandles)
                {
                    try
                    {
                        AutomationElement.FromHandle(child);
                    }
                    catch (Exception)
                    {
                    }
                }
            }

            AutomationElement root = AutomationElement.FromHandle(hwnd);
            if (root == null)
            {
                throw new HostException("ACCESSIBILITY_UNAVAILABLE", "AutomationElement.FromHandle returned null.");
            }
            TreeWalker controlWalker = TreeWalker.ControlViewWalker;
            int valueReads = 0;
            WalkResult best = Walk(controlWalker, root, pid, hwnd, ref valueReads);
            int attempts = 1;
            while (chromiumSurface && best.ValidCount < ChromiumReadyMin && attempts < ChromiumAttempts)
            {
                Thread.Sleep(ChromiumSettleMs);
                root = AutomationElement.FromHandle(hwnd);
                if (root == null)
                {
                    throw new HostException("ACCESSIBILITY_UNAVAILABLE", "AutomationElement.FromHandle returned null.");
                }
                WalkResult next = Walk(controlWalker, root, pid, hwnd, ref valueReads);
                if (next.ValidCount > best.ValidCount) best = next;
                attempts++;
            }

            List<UiRecord> merged = new List<UiRecord>(best.Records);
            if (best.ValidCount < ControlFallbackMin)
            {
                root = AutomationElement.FromHandle(hwnd);
                if (root == null)
                {
                    throw new HostException("ACCESSIBILITY_UNAVAILABLE", "AutomationElement.FromHandle returned null.");
                }
                WalkResult raw = Walk(TreeWalker.RawViewWalker, root, pid, hwnd, ref valueReads);
                merged.AddRange(raw.Records);
            }

            // Re-verify HWND ownership after the walk: the window may have been
            // recycled or destroyed while UIA was reading it.
            WindowDescriptor window = WindowVerifier.Verify(pid, hwndValue, WindowPurpose.Inspect);

            JsonBuilder builder = new JsonBuilder();
            builder.StartObject();
            builder.Name("type").Value("elements");
            builder.Name("window");
            ProtocolJson.WriteWindow(builder, window);
            builder.Name("elements");
            builder.StartArray();
            foreach (UiRecord record in merged)
            {
                WriteRecord(builder, record);
            }
            builder.EndArray();
            builder.Name("warnings");
            builder.StartArray();
            builder.EndArray();
            builder.EndObject();
            stdout.WriteLine(builder.ToString());
            stdout.Flush();
        }

        private static void WriteRecord(JsonBuilder builder, UiRecord record)
        {
            builder.StartObject();
            builder.Name("role").Value(record.Role);
            builder.Name("label");
            if (record.Label.Length == 0) builder.Null();
            else builder.Value(record.Label);
            builder.Name("description");
            if (record.Description.Length == 0) builder.Null();
            else builder.Value(record.Description);
            builder.Name("value");
            if (record.Value.Length == 0) builder.Null();
            else builder.Value(record.Value);
            builder.Name("bounds");
            builder.StartObject();
            builder.Name("x").Value((long)record.X);
            builder.Name("y").Value((long)record.Y);
            builder.Name("width").Value((long)record.Width);
            builder.Name("height").Value((long)record.Height);
            builder.EndObject();
            builder.Name("center");
            builder.StartObject();
            builder.Name("x").Value(record.X + record.Width / 2.0);
            builder.Name("y").Value(record.Y + record.Height / 2.0);
            builder.EndObject();
            builder.Name("enabled").Value(record.Enabled);
            builder.Name("offscreen").Value(record.Offscreen);
            builder.Name("focusable").Value(record.Focusable);
            builder.Name("expandable").Value(record.Expandable);
            builder.Name("focused").Value(record.Focused);
            builder.Name("actionable").Value(record.Actionable);
            builder.Name("automationId").Value(record.AutomationId);
            builder.Name("runtimeId").Value(record.RuntimeId);
            builder.Name("nativeRef");
            if (record.NativeRef.Length == 0) builder.Null();
            else builder.Value(record.NativeRef);
            builder.EndObject();
        }

        private static WalkResult Walk(
            TreeWalker walker,
            AutomationElement root,
            int requestedPid,
            IntPtr hwnd,
            ref int valueReads)
        {
            List<UiRecord> records = new List<UiRecord>();
            int validCount = 0;
            int visited = 0;
            Stack<NodeEntry> stack = new Stack<NodeEntry>();
            stack.Push(new NodeEntry(root, 0));
            while (stack.Count > 0 && records.Count < MaxElements && visited < MaxVisited)
            {
                NodeEntry entry = stack.Pop();
                visited++;
                try
                {
                    System.Windows.Rect rect = entry.Node.Current.BoundingRectangle;
                    if (IsUsableRect(rect))
                    {
                        validCount++;
                        UiRecord record = RecordElement(entry.Node, rect, requestedPid, hwnd, ref valueReads);
                        if (record != null) records.Add(record);
                    }
                }
                catch (Exception)
                {
                }
                if (entry.Depth < MaxDepth)
                {
                    List<AutomationElement> children = Children(walker, entry.Node);
                    for (int index = children.Count - 1; index >= 0; index--)
                    {
                        stack.Push(new NodeEntry(children[index], entry.Depth + 1));
                    }
                }
            }
            WalkResult result = new WalkResult();
            result.Records = records;
            result.ValidCount = validCount;
            return result;
        }

        private static List<AutomationElement> Children(TreeWalker walker, AutomationElement node)
        {
            List<AutomationElement> children = new List<AutomationElement>();
            try
            {
                AutomationElement child = walker.GetFirstChild(node);
                while (child != null && children.Count < MaxSiblingScan)
                {
                    children.Add(child);
                    child = walker.GetNextSibling(child);
                }
            }
            catch (Exception)
            {
            }
            return children;
        }

        private static bool IsUsableRect(System.Windows.Rect rect)
        {
            return !rect.IsEmpty && rect.Width > 0 && rect.Height > 0 &&
                rect.Width <= MaxUsableRectDimension && rect.Height <= MaxUsableRectDimension;
        }

        private static UiRecord RecordElement(
            AutomationElement node,
            System.Windows.Rect rect,
            int requestedPid,
            IntPtr hwnd,
            ref int valueReads)
        {
            AutomationElement.AutomationElementInformation current = node.Current;
            string role = current.ControlType.ProgrammaticName;
            if (role.StartsWith("ControlType.", StringComparison.Ordinal))
            {
                role = role.Substring("ControlType.".Length);
            }
            if (string.Equals(role, "Pane", StringComparison.Ordinal))
            {
                role = RecoverNativeRole(current, requestedPid, hwnd, role);
            }
            string roleName = role.ToLowerInvariant();

            bool enabled = false;
            try
            {
                enabled = current.IsEnabled;
            }
            catch (Exception)
            {
            }
            bool offscreen = false;
            try
            {
                offscreen = current.IsOffscreen;
            }
            catch (Exception)
            {
            }
            bool focusable = false;
            try
            {
                focusable = current.IsKeyboardFocusable;
            }
            catch (Exception)
            {
            }
            bool focused = false;
            try
            {
                focused = current.HasKeyboardFocus;
            }
            catch (Exception)
            {
            }
            bool expandable = false;
            if (ExpandableRoles.Contains(roleName))
            {
                try
                {
                    object pattern = null;
                    if (node.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern))
                    {
                        expandable = pattern != null;
                    }
                }
                catch (Exception)
                {
                }
            }

            string label = Clip(WindowVerifier.CleanText(current.Name), MaxLabelChars);
            string description = Clip(WindowVerifier.CleanText(current.HelpText), MaxLabelChars);
            string automationId = Clip(WindowVerifier.CleanText(current.AutomationId), MaxRefChars);
            string runtimeId = string.Empty;
            try
            {
                int[] runtime = node.GetRuntimeId();
                if (runtime != null && runtime.Length > 0)
                {
                    string[] parts = new string[runtime.Length];
                    for (int index = 0; index < runtime.Length; index++)
                    {
                        parts[index] = runtime[index].ToString(CultureInfo.InvariantCulture);
                    }
                    runtimeId = string.Join(".", parts);
                }
            }
            catch (Exception)
            {
            }
            string value = ReadValue(node, roleName, ref valueReads);

            UiRecord record = new UiRecord();
            record.Role = roleName;
            record.Label = label;
            record.Description = description;
            record.Value = value;
            record.X = (int)Math.Round(rect.X);
            record.Y = (int)Math.Round(rect.Y);
            record.Width = Math.Max(1, (int)Math.Round(rect.Width));
            record.Height = Math.Max(1, (int)Math.Round(rect.Height));
            record.Enabled = enabled;
            record.Offscreen = offscreen;
            record.Focusable = focusable;
            record.Expandable = expandable;
            record.Focused = focused;
            record.Actionable = enabled && !offscreen &&
                (ActionableRoles.Contains(roleName) ||
                 (string.Equals(roleName, "custom", StringComparison.Ordinal) && expandable));
            record.AutomationId = automationId;
            record.RuntimeId = runtimeId;
            if (automationId.Length > 0) record.NativeRef = "automationId:" + automationId;
            else if (runtimeId.Length > 0) record.NativeRef = "runtimeId:" + runtimeId;
            else record.NativeRef = string.Empty;
            return record;
        }

        private static string ReadValue(AutomationElement node, string roleName, ref int valueReads)
        {
            if (!ValueRoles.Contains(roleName)) return string.Empty;
            if (valueReads >= MaxValueReads) return string.Empty;
            valueReads++;
            try
            {
                object pattern = null;
                if (node.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
                {
                    ValuePattern valuePattern = pattern as ValuePattern;
                    if (valuePattern != null)
                    {
                        return Clip(WindowVerifier.CleanText(valuePattern.Current.Value), MaxLabelChars);
                    }
                }
            }
            catch (Exception)
            {
            }
            return string.Empty;
        }

        private static string RecoverNativeRole(
            AutomationElement.AutomationElementInformation current,
            int requestedPid,
            IntPtr hwnd,
            string fallbackRole)
        {
            int nativeHandleValue;
            try
            {
                nativeHandleValue = current.NativeWindowHandle;
            }
            catch (Exception)
            {
                return fallbackRole;
            }
            if (nativeHandleValue == 0) return fallbackRole;
            IntPtr nativeHandle = new IntPtr(nativeHandleValue);
            if (!NativeMethods.IsWindow(nativeHandle)) return fallbackRole;
            uint nativeOwner;
            NativeMethods.GetWindowThreadProcessId(nativeHandle, out nativeOwner);
            if ((int)nativeOwner != requestedPid || !NativeMethods.IsChild(hwnd, nativeHandle)) return fallbackRole;
            StringBuilder buffer = new StringBuilder(256);
            NativeMethods.GetClassName(nativeHandle, buffer, buffer.Capacity);
            string className = buffer.ToString();
            if (className.StartsWith("WindowsForms10.BUTTON.", StringComparison.Ordinal)) return "Button";
            if (className.StartsWith("WindowsForms10.EDIT.", StringComparison.Ordinal)) return "Edit";
            return fallbackRole;
        }

        private static List<IntPtr> CollectSameProcessChildren(int pid, IntPtr root, out bool chromiumSurface)
        {
            List<IntPtr> handles = new List<IntPtr>();
            List<string> classes = new List<string>();
            NativeMethods.EnumWindowsProc callback = delegate(IntPtr childHwnd, IntPtr lParam)
            {
                try
                {
                    if (handles.Count < MaxChildWindows)
                    {
                        uint childPid;
                        NativeMethods.GetWindowThreadProcessId(childHwnd, out childPid);
                        if ((int)childPid == pid && NativeMethods.IsChild(root, childHwnd))
                        {
                            StringBuilder buffer = new StringBuilder(256);
                            NativeMethods.GetClassName(childHwnd, buffer, buffer.Capacity);
                            handles.Add(childHwnd);
                            classes.Add(buffer.ToString());
                        }
                    }
                }
                catch (Exception)
                {
                }
                return true;
            };
            NativeMethods.EnumChildWindows(root, callback, IntPtr.Zero);
            bool surface = false;
            foreach (string className in classes)
            {
                if (string.Equals(className, "Chrome_RenderWidgetHostHWND", StringComparison.Ordinal) ||
                    className.StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal))
                {
                    surface = true;
                }
            }
            chromiumSurface = surface;
            return handles;
        }

        private static string Clip(string value, int maxChars)
        {
            if (string.IsNullOrEmpty(value)) return string.Empty;
            return value.Length <= maxChars ? value : value.Substring(0, maxChars);
        }
    }
}
