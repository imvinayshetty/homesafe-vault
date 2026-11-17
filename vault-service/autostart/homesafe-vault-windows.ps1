# Registers a hidden background task that starts the Vault service at sign-in and restarts it on failure.
# Run once in PowerShell:  powershell -ExecutionPolicy Bypass -File homesafe-vault-windows.ps1
# (The HomeSafe Vault desktop app does this for you automatically; this is for service-only installs.)
$dir  = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$action   = New-ScheduledTaskAction -Execute $node -Argument "`"$dir\src\cli.mjs`" start" -WorkingDirectory $dir
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -Hidden -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit 0
Register-ScheduledTask -TaskName "HomeSafe Vault" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName "HomeSafe Vault"
Write-Host "HomeSafe Vault will now start automatically in the background."
