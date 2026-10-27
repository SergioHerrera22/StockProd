# Crea robles-stock-pro-deploy.zip con separadores '/' internos
# (Compress-Archive usa '\' y algunos extractores en Linux los tratan
#  como parte del nombre, rompiendo la estructura de carpetas).
# Uso: powershell -File scripts/create_zip_hostinger.ps1
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot

$zipPath = Join-Path $root 'robles-stock-pro-deploy.zip'
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

$items = @(
  @{ Path = 'dist';              Recursive = $true },
  @{ Path = 'public';            Recursive = $true },
  @{ Path = 'package.json';      Recursive = $false },
  @{ Path = 'package-lock.json'; Recursive = $false },
  @{ Path = '.env';              Recursive = $false },
  @{ Path = 'README_DEPLOY.txt'; Recursive = $false },
  @{ Path = 'migrations';          Recursive = $true },
  @{ Path = 'scripts/migrate.mjs'; Recursive = $false }
)

$fs = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::CreateNew)
$zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
$count = 0

try {
  foreach ($item in $items) {
    $fullPath = Join-Path $root $item.Path
    if (-not (Test-Path $fullPath)) {
      Write-Warning "No existe: $($item.Path) (saltando)"
      continue
    }

    if ($item.Recursive) {
      $baseDir = Split-Path $fullPath -Parent
      $files = Get-ChildItem $fullPath -Recurse -File
      foreach ($f in $files) {
        $relative = $f.FullName.Substring($root.Length + 1).Replace('\', '/')
        $entry = $zip.CreateEntry($relative, [System.IO.Compression.CompressionLevel]::Optimal)
        $entryStream = $entry.Open()
        $fileStream = [System.IO.File]::OpenRead($f.FullName)
        $fileStream.CopyTo($entryStream)
        $fileStream.Dispose(); $entryStream.Dispose()
        $count++
      }
    } else {
      $entry = $zip.CreateEntry($item.Path, [System.IO.Compression.CompressionLevel]::Optimal)
      $entryStream = $entry.Open()
      $fileStream = [System.IO.File]::OpenRead($fullPath)
      $fileStream.CopyTo($entryStream)
      $fileStream.Dispose(); $entryStream.Dispose()
      $count++
    }
  }
} finally {
  $zip.Dispose(); $fs.Dispose()
}

$z = Get-Item $zipPath
Write-Host ("ZIP: {0}" -f $zipPath)
Write-Host ("Entradas: {0} | Tamano: {1:N0} KB" -f $count, ($z.Length / 1KB))
