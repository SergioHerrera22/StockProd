Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::OpenRead('robles-stock-hostinger.zip')
foreach($e in $z.Entries) { Write-Host $e.FullName '(' $e.Length 'bytes)' }
$z.Dispose()