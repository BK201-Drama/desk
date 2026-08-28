$ErrorActionPreference = 'Stop'
$setup = Join-Path $PSScriptRoot '..\src-tauri\target\release\bundle\nsis\desk_0.1.0_x64-setup.exe'
if (-not (Test-Path $setup)) { throw "missing setup: $setup" }

Get-Process -Name desk -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process | Where-Object { $_.MainWindowTitle -eq 'desk Setup' } | Stop-Process -Force -ErrorAction SilentlyContinue

# /S silent, /NS no shortcuts (belt + hooks.nsh)
$p = Start-Process -FilePath $setup -ArgumentList '/S','/NS' -PassThru -Wait
Write-Output "setup_exit=$($p.ExitCode)"

foreach ($d in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'))) {
  $lnk = Join-Path $d 'desk.lnk'
  if (Test-Path $lnk) { Remove-Item -Force $lnk; Write-Output "removed $lnk" }
}

$exe = Join-Path $env:LOCALAPPDATA 'desk\desk.exe'
Start-Process -FilePath $exe
Start-Sleep 2
Get-Process -Name desk -ErrorAction SilentlyContinue | Format-Table Id, ProcessName -AutoSize
