$ErrorActionPreference = 'Stop'
$checkpointTaskName = 'Skyline-xcpydisstlvtvcsqnjob-Recovery-15m'
$checkpointTaskUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
if (Get-ScheduledTask -TaskName $checkpointTaskName -ErrorAction SilentlyContinue) { throw 'Existing task must be reviewed before replacement.' }
$checkpointTaskAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\Users\goura\Desktop\Skyline-Website\scripts\release-close\scheduled-checkpoint.ps1"' -WorkingDirectory 'C:\Users\goura\Desktop\Skyline-Website'
$checkpointTaskTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)
$checkpointTaskPrincipal = New-ScheduledTaskPrincipal -UserId $checkpointTaskUser -LogonType Interactive -RunLevel Limited
$checkpointTaskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 12) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
Register-ScheduledTask -TaskName $checkpointTaskName -Action $checkpointTaskAction -Trigger $checkpointTaskTrigger -Principal $checkpointTaskPrincipal -Settings $checkpointTaskSettings -Description 'Owner-approved Skyline xcpydisstlvtvcsqnjob read-only encrypted recovery every 15 minutes; last 48 successful checkpoints; no production mutation.' | Out-Null
Start-ScheduledTask -TaskName $checkpointTaskName
Get-ScheduledTask -TaskName $checkpointTaskName | Select-Object TaskName,State,@{n='User';e={$_.Principal.UserId}},@{n='LogonType';e={$_.Principal.LogonType}},@{n='Interval';e={$_.Triggers[0].Repetition.Interval}} | ConvertTo-Json -Compress
