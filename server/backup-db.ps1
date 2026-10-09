# Backs up the heyhr database with pg_dump: one file per run, checked after writing, old ones removed.
#
#   powershell -ExecutionPolicy Bypass -File server\backup-db.ps1              # back up now
#   powershell -ExecutionPolicy Bypass -File server\backup-db.ps1 -Install     # also every night at 1:00 AM
#   powershell -ExecutionPolicy Bypass -File server\backup-db.ps1 -Uninstall   # stop the nightly backup
#
# Options: -BackupDir <folder> (default Documents\HeyHR-backups), -KeepDays <n> (default 14).
# It signs in with the app's own login from server\.env, so no admin password is stored anywhere.
#
# Restoring (into a new, empty database; never over the live one without a fresh backup first):
#   createdb -U postgres heyhr_restored
#   pg_restore -U postgres -d heyhr_restored --no-owner --no-privileges "<backup file>"
#
# The backups hold employees' government numbers encrypted; reading them needs HEYHR_DATA_KEY from
# server\.env. Keep a copy of that key somewhere safe and separate from the backups (a password
# manager), and copy the backup folder off this PC too (e.g. a synced Google Drive folder).

param(
  [string]$BackupDir = (Join-Path ([Environment]::GetFolderPath("MyDocuments")) "HeyHR-backups"),
  [int]$KeepDays = 14,
  [switch]$Install,
  [switch]$Uninstall
)
$ErrorActionPreference = "Stop"
$TaskName = "HeyHR nightly database backup"

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Nightly backup removed."
  return
}

$bin = Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\pg_dump.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $bin) { throw "pg_dump.exe not found under C:\Program Files\PostgreSQL" }
$pgDump = $bin.FullName
$pgRestore = Join-Path $bin.DirectoryName "pg_restore.exe"

# The app's connection from server\.env: postgres://user:password@host:port/database
$envFile = Join-Path $PSScriptRoot ".env"
$line = Get-Content $envFile | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
if ($line -notmatch '^DATABASE_URL=postgres(?:ql)?://([^:]+):([^@]+)@([^:/]+)(?::(\d+))?/(.+)$') { throw "DATABASE_URL in server\.env isn't in the expected form" }
$user = $Matches[1]; $env:PGPASSWORD = [Uri]::UnescapeDataString($Matches[2]); $pgHost = $Matches[3]
$port = if ($Matches[4]) { $Matches[4] } else { "5432" }; $db = $Matches[5]

try {
  New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
  $file = Join-Path $BackupDir ("heyhr-{0}.dump" -f (Get-Date -Format "yyyy-MM-dd_HHmmss"))
  & $pgDump -h $pgHost -p $port -U $user -d $db --format=custom --no-owner --no-privileges --file $file
  if ($LASTEXITCODE -ne 0) { Remove-Item $file -ErrorAction SilentlyContinue; throw "pg_dump failed" }
  # A backup that can't be read is no backup: list its contents to prove it opens.
  $tables = (& $pgRestore --list $file | Select-String "TABLE DATA").Count
  if ($LASTEXITCODE -ne 0 -or $tables -lt 1) { throw "The backup file couldn't be read back" }
  $size = "{0:N1} MB" -f ((Get-Item $file).Length / 1MB)
  Write-Host "Backed up $db ($tables tables, $size) to $file"

  # Keep KeepDays days of backups, but never delete the newest few.
  $old = Get-ChildItem $BackupDir -Filter "heyhr-*.dump" | Sort-Object LastWriteTime -Descending | Select-Object -Skip 3 |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) }
  $old | Remove-Item
  if ($old) { Write-Host "Removed $($old.Count) backup(s) older than $KeepDays days." }
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}

if ($Install) {
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -BackupDir `"$BackupDir`" -KeepDays $KeepDays"
  $trigger = New-ScheduledTaskTrigger -Daily -At "1:00 AM"
  # If the PC was off at 1:00 AM, it runs at the next chance.
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "pg_dump of the heyhr database to $BackupDir" -Force | Out-Null
  Write-Host "Nightly backup scheduled: every day at 1:00 AM to $BackupDir (Task Scheduler: '$TaskName')."
}
