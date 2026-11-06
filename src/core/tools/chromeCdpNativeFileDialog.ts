import { spawn } from "node:child_process";
import path from "node:path";

/** Opt-in Windows UI Automation fallback for an already-open native file dialog. */
export async function handleNativeWindowsFileDialog(
  files: string[], options: { confirmNativeDialog?: boolean; windowTitle?: string } = {},
): Promise<{ status: "native_dialog_closed"; files: string[]; serverUploadConfirmed: false }> {
  if (process.platform !== "win32") throw new Error("Native file picker automation is supported only on Windows.");
  if (options.confirmNativeDialog !== true) throw new Error("Native Windows dialog automation requires confirmNativeDialog=true.");
  if (!files.length || files.length > 10) throw new Error("Expected 1-10 validated files.");
  if (files.length > 1 && files.some(f => path.dirname(f).toLowerCase() !== path.dirname(files[0]).toLowerCase())) {
    throw new Error("Native multi-file picker requires files in the same folder. Use direct CDP upload for multiple folders.");
  }
  const json = Buffer.from(JSON.stringify({ files, windowTitle: options.windowTitle || "" }), "utf8").toString("base64");
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('` + json + String.raw`')) | ConvertFrom-Json
$root = [System.Windows.Automation.AutomationElement]::RootElement
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32770')
$dialogs = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
$matches = @()
for ($i = 0; $i -lt $dialogs.Count; $i++) {
  $dialog = $dialogs.Item($i)
  $title = [string]$dialog.Current.Name
  if ($payload.windowTitle -and $title -ne [string]$payload.windowTitle) { continue }
  if (-not $payload.windowTitle -and $title -notmatch '^(Open|Buka|Choose File|Select File|Open File)$') { continue }
  $pidValue = [int]$dialog.Current.ProcessId
  try { $processName = [System.Diagnostics.Process]::GetProcessById($pidValue).ProcessName.ToLowerInvariant() }
  catch { continue }
  if ($processName -notin @('chrome', 'msedge')) { continue }
  $matches += $dialog
}
if ($matches.Count -ne 1) { throw "Expected exactly one Chrome-owned native Open dialog; found $($matches.Count)." }
$dialog = $matches[0]
$editCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
$edits = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)
$matchingEdits = @()
for ($i = 0; $i -lt $edits.Count; $i++) {
  $el = $edits.Item($i)
  $id = [string]$el.Current.AutomationId
  $name = [string]$el.Current.Name
  if ($id -eq '1148' -or $name -match '(File name|Nama file)') { $matchingEdits += $el }
}
if ($matchingEdits.Count -ne 1) { throw "Cannot unambiguously identify the native File name input." }
$edit = $matchingEdits[0]
$pattern = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
$paths = @($payload.files)
if ($paths.Count -eq 1) { $textValue = [string]$paths[0] }
else { $textValue = ($paths | ForEach-Object { '"' + [string]$_ + '"' }) -join ' ' }
$pattern.SetValue($textValue)
$buttonCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
$buttons = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCond)
$openButtons = @()
for ($i = 0; $i -lt $buttons.Count; $i++) {
  $el = $buttons.Item($i)
  if ([string]$el.Current.AutomationId -eq '1' -and [string]$el.Current.Name -match '(Open|Buka)') { $openButtons += $el }
}
if ($openButtons.Count -ne 1) { throw "Cannot unambiguously identify the native Open button." }
$openButtons[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
Start-Sleep -Milliseconds 350
$stillOpen = $false
try { $stillOpen = $dialog.Current.IsEnabled -and (-not $dialog.Current.IsOffscreen) } catch {}
if ($stillOpen) { throw "Native dialog remains visible after Open; file selection not confirmed." }
'{"status":"native_dialog_closed"}'
`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errOutput = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Native file chooser timed out (15 seconds).")); }, 15000);
    child.stdout.on("data", b => { output = (output + b.toString()).slice(-4000); });
    child.stderr.on("data", b => { errOutput = (errOutput + b.toString()).slice(-2000); });
    child.on("error", e => { clearTimeout(timer); reject(new Error("Cannot start Windows UI Automation: " + e.message)); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0 || !output.includes('"native_dialog_closed"')) {
        return reject(new Error("Native Open dialog could not be handled: " + (errOutput.trim() || output.trim() || "unknown error").slice(0, 700)));
      }
      resolve({ status: "native_dialog_closed", files: files.map(f => path.basename(f)), serverUploadConfirmed: false });
    });
  });
}
