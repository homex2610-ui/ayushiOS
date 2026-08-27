$ErrorActionPreference = 'Continue'
$out = 'C:\Users\updes\AppData\Local\Temp\opencode\mclogs\run4_out.log'
$err = 'C:\Users\updes\AppData\Local\Temp\opencode\mclogs\run4_err.log'
$p = Start-Process -FilePath 'node' -ArgumentList 'main.js','--host','127.0.0.1','--port','63198' -WorkingDirectory 'C:\Users\updes\projects\mindcraft' -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
Write-Host "run4 PID: $($p.Id)"
