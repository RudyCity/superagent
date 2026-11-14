# Disposable, dedicated WinForms fixture. Never attaches to a user application.
# Child owns one local HWND and closes automatically after 30 seconds.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# Read-only diagnostics: do not inspect, activate, or interact with user windows.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DisposableFixtureDesktop {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint threadId);
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, int length, out int needed);
  private static bool IsDefault(IntPtr desktop) {
    if (desktop == IntPtr.Zero) return false;
    var name = new StringBuilder(128);
    int needed;
    return GetUserObjectInformation(desktop, 2, name, name.Capacity * 2, out needed)
      && name.ToString() == "Default";
  }
  public static bool OnDefaultInputDesktop() {
    var input = OpenInputDesktop(0, false, 1); // DESKTOP_READOBJECTS
    if (input == IntPtr.Zero) return false;
    try { return IsDefault(input) && IsDefault(GetThreadDesktop(GetCurrentThreadId())); }
    finally { CloseDesktop(input); }
  }
}
'@
$form = [System.Windows.Forms.Form]::new()
$form.Text = "SuperAgent Disposable UIA Fixture"
$form.Size = [System.Drawing.Size]::new(420, 240)
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Location = [System.Drawing.Point]::new(40, 40)
$form.ShowInTaskbar = $true
$button = [System.Windows.Forms.Button]::new()
$button.Name = "ActionOne"
$button.Text = "Action"
$button.AccessibleName = "Action"
$button.Size = [System.Drawing.Size]::new(100, 30)
$button.Location = [System.Drawing.Point]::new(30, 45)
$form.Controls.Add($button)
$script:clicked = 0
$button.Add_Click({
  $script:clicked++
  [Console]::Out.WriteLine("CLICKED:" + $script:clicked)
  [Console]::Out.Flush()
  $form.Close()
})
$timer = [System.Windows.Forms.Timer]::new()
$timer.Interval = 30000
$timer.Add_Tick({ $timer.Stop(); $form.Close() })
$form.Add_Shown({
  [void]$form.Activate()
  [void]$button.Focus()
  $timer.Start()
  $process = [System.Diagnostics.Process]::GetCurrentProcess()
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $ready = [pscustomobject]@{
    pid = $process.Id
    nativeId = $form.Handle.ToInt64().ToString()
    processBirthId = "filetime:" + $process.StartTime.ToUniversalTime().ToFileTimeUtc()
    osUserId = $sid
    hostSessionId = "session:" + $process.SessionId
    nativeRef = "automationId:ActionOne"
    foregroundAtShown = ([DisposableFixtureDesktop]::GetForegroundWindow() -eq $form.Handle)
    defaultInputDesktopAtShown = [DisposableFixtureDesktop]::OnDefaultInputDesktop()
  }
  [Console]::Out.WriteLine(($ready | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
})
try { [System.Windows.Forms.Application]::Run($form) }
finally { $timer.Dispose(); $button.Dispose(); $form.Dispose() }
