# Mindcraft Bot - Forever Loop Launcher
# This script keeps the bot running all night, restarting on crash

$maxRestarts = 999
$restartCount = 0
$waitTime = 10

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Mindcraft Bot - Forever Loop Launcher  " -ForegroundColor Cyan
Write-Host "  Target: proxy.driftsmp.net | Bot: ayushi_ds_2026 " -ForegroundColor Cyan
Write-Host "  Task: Diamond Grind + Base + Farm      " -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

while ($restartCount -lt $maxRestarts) {
    $restartCount++
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "`n[$timestamp] Launch #$restartCount - Starting bot..." -ForegroundColor Green
    
    try {
        $process = Start-Process -FilePath "node" -ArgumentList "main.js" -NoNewWindow -PassThru -Wait -RedirectStandardOutput "bot_output.log" -RedirectStandardError "bot_error.log"
        
        $exitCode = $process.ExitCode
        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        Write-Host "[$timestamp] Bot exited with code $exitCode" -ForegroundColor Yellow
        
        if ($exitCode -eq 0) {
            Write-Host "Bot exited cleanly (task completed?)" -ForegroundColor Green
            Start-Sleep -Seconds 5
        }
        else {
            Write-Host "Bot crashed with code $exitCode" -ForegroundColor Red
            
            $errors = Get-Content -Path "bot_error.log" -Tail 10
            Write-Host "Last errors:" -ForegroundColor Red
            $errors | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkRed }
        }
    }
    catch {
        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        Write-Host "[$timestamp] Launch failed: $_" -ForegroundColor Red
    }
    
    # Adaptive backoff
    if ($restartCount -gt 5) {
        $waitTime = [Math]::Min(60, 10 + ($restartCount - 5) * 2)
    }
    
    $nextTimestamp = (Get-Date).AddSeconds($waitTime) | Get-Date -Format "HH:mm:ss"
    Write-Host "Restart #$restartCount in ${waitTime}s (next at $nextTimestamp)..." -ForegroundColor Gray
    Start-Sleep -Seconds $waitTime
}

Write-Host "Max restarts reached. Stopping." -ForegroundColor Red
