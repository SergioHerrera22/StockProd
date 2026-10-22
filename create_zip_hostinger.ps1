Add-Type -AssemblyName System.IO.Compression.FileSystem

$sourceDir = "C:\Users\santiherrera\Desktop\MIS PROYECTOS\robles-stock-pro"
$zipPath = "C:\Users\santiherrera\Desktop\MIS PROYECTOS\robles-stock-pro\robles-stock-hostinger.zip"

# Create a temp directory with Hostinger-compatible structure
$tempDir = "C:\Users\santiherrera\Desktop\MIS PROYECTOS\robles-stock-pro\temp_deploy"
if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
New-Item -ItemType Directory -Path $tempDir | Out-Null

# Create subdirectories
New-Item -ItemType Directory -Path "$tempDir\dist" | Out-Null
New-Item -ItemType Directory -Path "$tempDir\public" | Out-Null

# ===== ROOT LEVEL (what Hostinger expects) =====
# Copy root package.json
Copy-Item "$sourceDir\package.json" "$tempDir\" -Force
Copy-Item "$sourceDir\package-lock.json" "$tempDir\" -Force

# Copy backend .env if exists
if (Test-Path "$sourceDir\backend\.env") {
    Copy-Item "$sourceDir\backend\.env" "$tempDir\.env" -Force
}

# Copy backend dist to root dist/
Copy-Item "$sourceDir\backend\dist\*" "$tempDir\dist\" -Recurse -Force

# Copy frontend build to public/
Copy-Item "$sourceDir\frontend\dist\*" "$tempDir\public\" -Recurse -Force

# Create zip
[System.IO.Compression.ZipFile]::CreateFromDirectory($tempDir, $zipPath)

# Cleanup
Remove-Item $tempDir -Recurse -Force

Write-Host "Zip creado en: $zipPath"
$size = (Get-Item $zipPath).Length
Write-Host "Tamaño: $size bytes ($([math]::Round($size/1MB, 2)) MB)"