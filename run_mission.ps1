$script:botOutput = @()
$script:botReady = $false
$script:commandIndex = 0
$script:goals = @()

function Load-Goals {
    $path = Join-Path $PSScriptRoot "bots\ayushi\goals.json"
    if (Test-Path $path) {
        $script:goals = Get-Content $path -Raw | ConvertFrom-Json
        Write-Host "Loaded $($script:goals.Count) goals"
    } else {
        Write-Host "No goals file found at $path"
        $script:goals = @()
    }
}

function Send-Command {
    param($cmd)
    if ($global:socket -and $global:socket.Connected) {
        $data = @{ from = "updesh"; message = $cmd } | ConvertTo-Json -Compress
        $global:socket.Send("42[""send-message"",""ayushi"",$data]")
        Write-Host "[INJECT] Sent: $cmd" -ForegroundColor Green
    } else {
        Write-Host "[INJECT] Socket not connected, cannot send: $cmd" -ForegroundColor Red
    }
}

function Process-Goals {
    foreach ($goal in $script:goals) {
        if ($goal.status -ne "pending") { continue }
        $step = $goal.steps[$goal.currentStep -as [int]]
        if (-not $step) {
            $goal.status = "completed"
            Write-Host "[GOAL] Completed: $($goal.description)" -ForegroundColor Cyan
            continue
        }
        Write-Host "[GOAL] Executing: $($goal.description) - Step $($goal.currentStep + 1): $step" -ForegroundColor Yellow
        Send-Command $step
        return
    }
}

function Start-Mission {
    Load-Goals
    
    # Start the bot process
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "node"
    $psi.Arguments = "--experimental-require-module main.js"
    $psi.WorkingDirectory = $PSScriptRoot
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    
    $process = [System.Diagnostics.Process]::Start($psi)
    
    # Read output in background
    $outJob = Start-Job -ScriptBlock {
        param($proc)
        $reader = $proc.StandardOutput
        while (-not $reader.EndOfStream) {
            $line = $reader.ReadLine()
            Write-Host $line
            if ($line -match "Connection ready|spawned|ready") {
                $script:botReady = $true
            }
            if ($line -match "\[CHAT\] sending reply") {
                Write-Host $line -ForegroundColor Magenta
            }
        }
    } -ArgumentList $process

    # Wait for bot to connect
    Write-Host "Waiting for bot to connect..." -ForegroundColor Yellow
    Start-Sleep -Seconds 15
    
    # Now inject commands
    Write-Host "Bot should be ready. Starting mission..." -ForegroundColor Green
    Process-Goals
    
    # Wait for completion
    Start-Sleep -Seconds 120
}

Start-Mission
