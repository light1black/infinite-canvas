$ErrorActionPreference = 'Continue'
$agentDir = 'C:\LLM WIKI\projects\gpt  TU\infinite-canvas\canvas-agent'
while ($true) {
  $process = Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'dist/index.js' -WorkingDirectory $agentDir -PassThru -WindowStyle Hidden
  Wait-Process -Id $process.Id
  Start-Sleep -Seconds 3
}
