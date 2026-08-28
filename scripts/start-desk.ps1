Get-Process | Where-Object { $_.MainWindowTitle -eq 'desk Setup' } | Stop-Process -Force -ErrorAction SilentlyContinue
$exe = Join-Path $env:LOCALAPPDATA 'desk\desk.exe'
Write-Output "exe=$exe exists=$([IO.File]::Exists($exe))"
if (Test-Path $exe) {
  Start-Process -FilePath $exe
  Start-Sleep -Seconds 2
  Get-Process -Name desk -ErrorAction SilentlyContinue | Format-Table Id, ProcessName -AutoSize
} else {
  Write-Output 'MISSING exe'
  Get-ChildItem (Join-Path $env:LOCALAPPDATA 'desk') | Select-Object Name, Length, LastWriteTime
}
