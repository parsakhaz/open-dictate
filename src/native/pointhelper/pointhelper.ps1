# Point and say's helper (Windows): answers "what element is at this point" through UI Automation, in its own
# process so COM and a misbehaving app's accessibility tree never reach Dictate. One JSON request per line on stdin,
# one JSON answer per line on stdout:
#   {"id":1,"op":"at","x":640,"y":400}  ->  {"id":1,"ok":true,"left":false,"own":false,"hit":{pid,process,title},
#                                            "element":{name,role,rect,text,pid,process,window}}
#   {"id":2,"op":"ping"}                ->  {"id":2,"ok":true}
# Coordinates are physical screen pixels (the process is per-monitor DPI aware). "left" is whether the left mouse
# button is down. "hit" is the top-level window there, found without UI Automation, so an excluded app is known even
# where UI Automation is refused (an elevated window: "element" is then null). "text": false skips reading text.
# Nothing in Dictate's own process (-OwnPid) is read: "own" is true and "element" is null.
# It reads only what UI Automation exposes; it never clicks, types or captures pixels. It exits when stdin closes.
param([int]$OwnPid = 0)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DictatePointNative {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder s, int max);
  // The top-level window at a point and its process id, even where UI Automation is refused (an elevated window).
  public static uint WindowAt(int x, int y, out string title) {
    POINT p; p.X = x; p.Y = y;
    IntPtr w = GetAncestor(WindowFromPoint(p), 2);
    var s = new System.Text.StringBuilder(300);
    title = w == IntPtr.Zero ? "" : (GetWindowText(w, s, 300) > 0 ? s.ToString() : "");
    uint pid = 0;
    if (w != IntPtr.Zero) GetWindowThreadProcessId(w, out pid);
    return pid;
  }
}
'@

# Per-monitor aware (v2): rectangles and points are physical pixels on every display.
[void][DictatePointNative]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))

$MaxText = 8000
$MaxNodes = 300
$Walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$Root = [System.Windows.Automation.AutomationElement]::RootElement

function LeftDown {
  # With swapped buttons the primary (left-hand) button is VK_RBUTTON.
  $vk = if ([DictatePointNative]::GetSystemMetrics(23) -ne 0) { 0x02 } else { 0x01 }
  return ([DictatePointNative]::GetAsyncKeyState($vk) -band 0x8000) -ne 0
}

function ProcessName([int]$id) {
  try { return [System.Diagnostics.Process]::GetProcessById($id).ProcessName + '.exe' } catch { return '' }
}

function WindowTitle($el) {
  $node = $el
  for ($i = 0; $i -lt 40 -and $node; $i++) {
    $parent = $Walker.GetParent($node)
    if (-not $parent -or [System.Windows.Automation.Automation]::Compare($parent, $Root)) { return [string]$node.Current.Name }
    $node = $parent
  }
  return ''
}

# The element's own text (a value, a document), else the names of it and everything inside it, in order.
function TextOf($el) {
  $parts = [System.Collections.Generic.List[string]]::new()
  $pattern = $null
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
      $t = $pattern.DocumentRange.GetText($MaxText)
      if ($t) { return $t }
    }
  } catch {}
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
      $v = $pattern.Current.Value
      if ($v) { $parts.Add([string]$v) }
    }
  } catch {}
  $length = 0
  $nodes = 0
  $stack = [System.Collections.Generic.Stack[object]]::new()
  $stack.Push($el)
  $last = $null
  while ($stack.Count -gt 0 -and $nodes -lt $MaxNodes -and $length -lt $MaxText) {
    $node = $stack.Pop()
    $nodes++
    try {
      $name = [string]$node.Current.Name
      if ($name -and $name -ne $last -and -not $parts.Contains($name)) {
        $parts.Add($name)
        $length += $name.Length
        $last = $name
      }
      # Children are pushed last-first, so they come off the stack in reading order.
      $children = [System.Collections.Generic.List[object]]::new()
      $child = $Walker.GetFirstChild($node)
      while ($child -and $children.Count -lt $MaxNodes) {
        $children.Add($child)
        $child = $Walker.GetNextSibling($child)
      }
      for ($i = $children.Count - 1; $i -ge 0; $i--) { $stack.Push($children[$i]) }
    } catch {}
  }
  return ($parts -join "`n")
}

function ElementAt([int]$x, [int]$y) {
  $point = [System.Windows.Point]::new($x, $y)
  # Some apps answer the first hit test with a transient COM error: try a few times.
  for ($try = 0; $try -lt 3; $try++) {
    try { return [System.Windows.Automation.AutomationElement]::FromPoint($point) } catch { Start-Sleep -Milliseconds 30 }
  }
  return $null
}

function Answer($req) {
  if ($req.op -eq 'ping') { return @{ id = $req.id; ok = $true } }
  if ($req.op -ne 'at') { return @{ id = $req.id; ok = $false; error = 'unknown op' } }
  $left = LeftDown
  $title = ''
  $wpid = [int][DictatePointNative]::WindowAt([int]$req.x, [int]$req.y, [ref]$title)
  $hit = @{ pid = $wpid; process = $(if ($wpid) { ProcessName $wpid } else { '' }); title = $title }
  if ($OwnPid -and $wpid -eq $OwnPid) { return @{ id = $req.id; ok = $true; left = $left; own = $true; hit = $hit; element = $null } }
  $el = ElementAt ([int]$req.x) ([int]$req.y)
  if (-not $el) { return @{ id = $req.id; ok = $true; left = $left; own = $false; hit = $hit; element = $null } }
  $c = $el.Current
  if ($OwnPid -and $c.ProcessId -eq $OwnPid) { return @{ id = $req.id; ok = $true; left = $left; own = $true; hit = $hit; element = $null } }
  $r = $c.BoundingRectangle
  $rect = if ($r.IsEmpty) { @{ x = 0; y = 0; width = 0; height = 0 } } else { @{ x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height } }
  $text = if ($req.text -eq $false) { '' } else { TextOf $el }
  if ($text.Length -gt $MaxText) { $text = $text.Substring(0, $MaxText) }
  return @{
    id = $req.id; ok = $true; left = $left; own = $false; hit = $hit
    element = @{ name = [string]$c.Name; role = [string]$c.LocalizedControlType; rect = $rect; text = $text; pid = $c.ProcessId; process = (ProcessName $c.ProcessId); window = (WindowTitle $el) }
  }
}

[Console]::Out.WriteLine((@{ ready = $true } | ConvertTo-Json -Compress))
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.TrimStart([char]0xFEFF)
  if (-not $line.Trim()) { continue }
  $req = $null
  try {
    $req = $line | ConvertFrom-Json
    $out = Answer $req
  } catch {
    $out = @{ id = $req.id; ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 5))
  [Console]::Out.Flush()
}
