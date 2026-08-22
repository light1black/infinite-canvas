$ErrorActionPreference = 'Continue'
$webDir = 'C:\LLM WIKI\projects\gpt  TU\infinite-canvas\web'
while ($true) {
  $process = Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'node_modules\vite\bin\vite.js --host 0.0.0.0 --port 5174' -WorkingDirectory $webDir -PassThru -WindowStyle Hidden
  Wait-Process -Id $process.Id
  Start-Sleep -Seconds 3
}
