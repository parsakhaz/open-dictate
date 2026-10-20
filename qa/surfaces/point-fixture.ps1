# QA fixture for point and say (L6): a small always-on-top window in its own process (so Dictate's capture keeps it,
# unlike Dictate's own windows), with a known accessible name and a planted fake key. It never takes focus. Prints
# one JSON line with the window's and its controls' screen rectangles (physical pixels), then stays up until it is
# killed or -ParentPid exits.
param([int]$X = 120, [int]$Y = 120, [int]$ParentPid = 0)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class PointFixture : Form {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get { var p = base.CreateParams; p.ExStyle |= 0x08000000 | 0x00000008; return p; } // WS_EX_NOACTIVATE | WS_EX_TOPMOST
  }
}
'@
# Per-monitor aware, so the rectangles it prints are physical pixels, as Dictate and the helper see them.
[void][PointFixture]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))

$form = [PointFixture]::new()
$form.Text = 'Storefront - Unhandled exception'
$form.FormBorderStyle = 'FixedToolWindow'
$form.StartPosition = 'Manual'
$form.Location = [System.Drawing.Point]::new($X, $Y)
$form.ClientSize = [System.Drawing.Size]::new(520, 250)
$form.BackColor = [System.Drawing.Color]::FromArgb(40, 40, 44)
$form.ForeColor = [System.Drawing.Color]::White
$form.TopMost = $true
$form.ShowInTaskbar = $false

$title = [System.Windows.Forms.Label]::new()
$title.Text = 'Unhandled exception'
$title.Font = [System.Drawing.Font]::new('Segoe UI', 13, [System.Drawing.FontStyle]::Bold)
$title.Location = [System.Drawing.Point]::new(16, 12)
$title.AutoSize = $true

$details = [System.Windows.Forms.TextBox]::new()
$details.Name = 'details'
$details.AccessibleName = 'Error details'
$details.Multiline = $true
$details.ReadOnly = $true
$details.Font = [System.Drawing.Font]::new('Consolas', 10)
$details.Location = [System.Drawing.Point]::new(16, 50)
$details.Size = [System.Drawing.Size]::new(488, 120)
$details.BackColor = [System.Drawing.Color]::FromArgb(28, 28, 30)
$details.ForeColor = [System.Drawing.Color]::Gainsboro
# A made-up key, put together here so secret scanners don't take the source for a leak (l6-point.js checks it is masked).
$fakeKey = ('sk', 'live', '51HxQa2Rk7VbT9qaFixture') -join '-'
$details.Text = "Cannot read properties of undefined (reading 'total')`r`nat OrderSummary (checkout/summary.tsx:42:18)`r`nPOST /api/cart/quote -> 500`r`nAuthorization: Bearer $fakeKey"

$pay = [System.Windows.Forms.Button]::new()
$pay.Text = 'Pay now'
$pay.Location = [System.Drawing.Point]::new(404, 190)
$pay.Size = [System.Drawing.Size]::new(100, 36)
$pay.FlatStyle = 'Flat'
$pay.BackColor = [System.Drawing.Color]::FromArgb(96, 205, 255)
$pay.ForeColor = [System.Drawing.Color]::Black

$form.Controls.AddRange(@($title, $details, $pay))
$form.Add_Shown({
  $rect = { param($c) $p = $c.PointToScreen([System.Drawing.Point]::Empty); @{ x = $p.X; y = $p.Y; width = $c.Width; height = $c.Height } }
  $out = @{ pid = $PID; window = @{ x = $form.Left; y = $form.Top; width = $form.Width; height = $form.Height }; details = (& $rect $details); pay = (& $rect $pay) }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
})
# Closes when the journey that started it is gone (or after 10 minutes, whatever happens).
$started = Get-Date
$timer = [System.Windows.Forms.Timer]::new()
$timer.Interval = 500
$timer.Add_Tick({ if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) -or ((Get-Date) - $started).TotalMinutes -gt 10) { $form.Close() } })
$timer.Start()
[System.Windows.Forms.Application]::Run($form)