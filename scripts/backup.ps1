#!/usr/bin/env pwsh
# ============================================================
# Backup de la base de datos Robles Stock (PostgreSQL)
# Uso:  powershell -File scripts\backup.ps1
# Programalo con el Programador de tareas de Windows (diario).
# ============================================================
param(
  [string]$OutputDir = "$PSScriptRoot\backups",
  [string]$DatabaseUrl = $env:DATABASE_URL
)

$ErrorActionPreference = 'Stop'

if (-not $DatabaseUrl) {
  # Lee DATABASE_URL desde backend\.env
  $envFile = Join-Path $PSScriptRoot "..\backend\.env"
  if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
      if ($_ -match '^\s*DATABASE_URL\s*=\s*(.+)\s*$') { $DatabaseUrl = $Matches[1] }
    }
  }
}
if (-not $DatabaseUrl) {
  Write-Error "No se encontró DATABASE_URL (variable de entorno o backend\.env)"
  exit 1
}

# Localiza pg_dump
$pgDumpCandidates = @(
  $env:PG_DUMP,
  "C:\Program Files\PostgreSQL\18\bin\pg_dump.exe",
  "C:\Program Files\PostgreSQL\17\bin\pg_dump.exe",
  "C:\Program Files\PostgreSQL\16\bin\pg_dump.exe",
  "pg_dump"
) | Where-Object { $_ }
$pgDump = $null
foreach ($c in $pgDumpCandidates) {
  try { & $c --version *> $null; $pgDump = $c; break } catch {}
}
if (-not $pgDump) { Write-Error "No se encontró pg_dump. Ajusta PG_DUMP en backend\.env"; exit 1 }

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$file = Join-Path $OutputDir "robles_stock_$stamp.dump"

& $pgDump --format=custom --file=$file $DatabaseUrl
if ($LASTEXITCODE -ne 0) { Write-Error "pg_dump falló"; exit 1 }

Write-Host "✔ Backup creado: $file" -ForegroundColor Green

# Retención: elimina backups con más de 30 días
$cutoff = (Get-Date).AddDays(-30)
Get-ChildItem $OutputDir -Filter "robles_stock_*.dump" |
  Where-Object { $_.LastWriteTime -lt $cutoff } |
  ForEach-Object { Remove-Item $_.FullName; Write-Host "Eliminado (30+ días): $($_.Name)" }

Write-Host "Listo."
