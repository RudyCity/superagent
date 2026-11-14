# Disposable, dedicated WinForms fixture. Never attaches to a user application.
# Child owns one local HWND and closes automatically after 20 seconds.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
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
$timer.Interval = 20000
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
  }
  [Console]::Out.WriteLine(($ready | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
})
try { [System.Windows.Forms.Application]::Run($form) }
finally { $timer.Dispose(); $button.Dispose(); $form.Dispose() }
