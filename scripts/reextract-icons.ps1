$ErrorActionPreference = "Continue"
Add-Type -AssemblyName System.Drawing
$code = @'
using System;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Imaging;
public static class DeskCleanIcon3 {
  [DllImport("User32.dll", CharSet = CharSet.Unicode)]
  public static extern uint PrivateExtractIcons(string f, int i, int cx, int cy, IntPtr[] ph, uint[] pid, uint n, uint flags);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);
  public static bool Save(string file, int index, int px, string dest) {
    IntPtr[] icons = new IntPtr[1];
    uint[] ids = new uint[1];
    if (PrivateExtractIcons(file, index, px, px, icons, ids, 1, 0) == 0 || icons[0] == IntPtr.Zero) return false;
    using (Icon icon = (Icon)Icon.FromHandle(icons[0]).Clone()) {
      DestroyIcon(icons[0]);
      using (Bitmap bmp = new Bitmap(px, px, PixelFormat.Format32bppArgb))
      using (Graphics g = Graphics.FromImage(bmp)) {
        g.Clear(Color.Transparent);
        g.DrawIcon(icon, new Rectangle(0, 0, px, px));
        bmp.Save(dest, ImageFormat.Png);
      }
    }
    return true;
  }
}
'@
if (-not ("DeskCleanIcon3" -as [type])) {
  Add-Type -TypeDefinition $code -ReferencedAssemblies System.Drawing
}

function Save-CleanIcon([string]$src, [string]$dest) {
  $ext = [IO.Path]::GetExtension($src).ToLowerInvariant()
  $ok = $false
  if ($ext -eq ".lnk") {
    $sh = New-Object -ComObject WScript.Shell
    $lnk = $sh.CreateShortcut($src)
    $iconLoc = $lnk.IconLocation
    $target = $lnk.TargetPath
    $idx = 0
    $iconPath = $null
    if ($iconLoc -and $iconLoc.Trim() -ne "" -and $iconLoc -ne ",") {
      $parts = $iconLoc -split ",", 2
      $iconPath = $parts[0].Trim('"')
      if ($parts.Count -gt 1) { [void][int]::TryParse($parts[1], [ref]$idx) }
      if ($idx -lt 0) { $idx = [Math]::Abs($idx) }
    }
    if ($iconPath -and (Test-Path -LiteralPath $iconPath)) {
      $ok = [DeskCleanIcon3]::Save($iconPath, $idx, 64, $dest)
    }
    if (-not $ok -and $target -and (Test-Path -LiteralPath $target)) {
      $ok = [DeskCleanIcon3]::Save($target, 0, 64, $dest)
    }
  } elseif ($ext -eq ".url") {
    $iconFile = $null
    $idx = 0
    foreach ($line in Get-Content -LiteralPath $src -ErrorAction SilentlyContinue) {
      if ($line -match '^\s*IconFile\s*=\s*(.+)\s*$') { $iconFile = $Matches[1].Trim().Trim('"') }
      if ($line -match '^\s*IconIndex\s*=\s*(-?\d+)\s*$') { $idx = [Math]::Abs([int]$Matches[1]) }
    }
    if ($iconFile -and (Test-Path -LiteralPath $iconFile)) {
      $ok = [DeskCleanIcon3]::Save($iconFile, $idx, 64, $dest)
    }
  }
  if (-not $ok) {
    $ok = [DeskCleanIcon3]::Save($src, 0, 64, $dest)
  }
  if (-not $ok) {
    try {
      $i = [System.Drawing.Icon]::ExtractAssociatedIcon($src)
      if ($null -ne $i) {
        $b = $i.ToBitmap()
        $b.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
        $b.Dispose(); $i.Dispose(); $ok = $true
      }
    } catch {}
  }
  return $ok
}

$root = Join-Path $env:LOCALAPPDATA "desk"
$meta = Get-Content (Join-Path $root "vault.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$okN = 0; $failN = 0
foreach ($e in $meta.items) {
  $src = Join-Path $root "vault\$($e.vault_name)"
  $dest = Join-Path $root "icons\$($e.id).png"
  if (-not (Test-Path -LiteralPath $src)) { $failN++; continue }
  if (Test-Path $dest) { Remove-Item -Force $dest }
  if (Save-CleanIcon $src $dest) { $okN++ } else { $failN++; Write-Output "FAIL $($e.id)" }
}
Set-Content -Path (Join-Path $root "icon-cache-v2") -Value "2" -Encoding ASCII
Write-Output "ok=$okN fail=$failN"

Get-Process -Name desk -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 1
Start-Process (Join-Path $root "desk.exe")
Start-Sleep 2
Get-Process -Name desk -ErrorAction SilentlyContinue | Format-Table Id, ProcessName -AutoSize
