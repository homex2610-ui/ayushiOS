# Mindcraft Mission Runner
# Starts the bot, waits for it to be ready, connects to the MindServer over a
# raw socket.io v4 websocket, injects goal steps as chat commands, and persists
# goal progress back to bots/ayushi/goals.json after every step.
#
# Compatible with Windows PowerShell 5.1 (.NET Framework 4.5+ ClientWebSocket).

# ------------------------- Configuration ------------------------------------
$StepDelaySeconds        = 30      # seconds to wait between injected steps
$ReadinessTimeoutSeconds = 90      # max seconds to wait for bot readiness
$MindServerUri           = "ws://localhost:8080/socket.io/?EIO=4&transport=websocket"
$BotName                 = "ayushi"
$GoalsRelativePath       = "bots\ayushi\goals.json"

$script:botReady = $false
$script:goals    = @()

# ------------------------- Goals --------------------------------------------
function Load-Goals {
    $path = Join-Path $PSScriptRoot $GoalsRelativePath
    if (Test-Path $path) {
        $script:goals = Get-Content $path -Raw | ConvertFrom-Json
        Write-Host "Loaded $($script:goals.Count) goals"
    } else {
        Write-Host "No goals file found at $path"
        $script:goals = @()
    }
}

function Save-Goals {
    $path = Join-Path $PSScriptRoot $GoalsRelativePath
    # -InputObject preserves array shape; UTF8 without BOM so node's JSON.parse stays happy.
    $json = ConvertTo-Json -InputObject $script:goals -Depth 10
    [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

# ------------------------- WebSocket plumbing -------------------------------
function Send-SioFrameText {
    param($ws, [string]$text)
    if ($null -eq $ws -or $ws.State -ne [System.Net.WebSockets.WebSocketState]::Open) {
        Write-Host "[INJECT] Socket not connected, cannot send: $text" -ForegroundColor Red
        return $false
    }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    $segment = New-Object System.ArraySegment[byte] -ArgumentList @(,$bytes)
    $task = $ws.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None)
    if (-not $task.Wait(10000)) {   # modest send timeout: 10s
        Write-Host "[INJECT] Send timed out: $text" -ForegroundColor Red
        return $false
    }
    return $true
}

function Receive-SioFrame {
    param($ws, [int]$waitMs)
    if ($null -eq $ws -or $ws.State -ne [System.Net.WebSockets.WebSocketState]::Open) { return $null }
    try {
        $buffer = New-Object byte[] 16384
        $stream = New-Object System.IO.MemoryStream
        while ($true) {
            $segment = New-Object System.ArraySegment[byte] -ArgumentList @(,$buffer)
            $task = $ws.ReceiveAsync($segment, [System.Threading.CancellationToken]::None)
            if (-not $task.Wait([Math]::Max(50, $waitMs))) { return $null }  # nothing arrived in time
            $result = $task.Result
            if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { return $null }
            $stream.Write($buffer, 0, $result.Count)
            if ($result.EndOfMessage) { break }
            $waitMs = 2000   # fragmented frame already started; give it more time
        }
        return [System.Text.Encoding]::UTF8.GetString($stream.ToArray())
    } catch {
        return $null
    }
}

function Send-SioMessage {
    param($ws, $obj)
    $json = ConvertTo-Json -InputObject $obj -Compress -Depth 10
    return Send-SioFrameText $ws ("42" + $json)
}

function Connect-MindServer {
    Write-Host "[WS] Connecting to MindServer at $MindServerUri..." -ForegroundColor Yellow
    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $uri = New-Object System.Uri($MindServerUri)
    $connectTask = $ws.ConnectAsync($uri, [System.Threading.CancellationToken]::None)
    if (-not $connectTask.Wait(15000)) {
        $ws.Dispose()
        throw "[WS] Timed out connecting to MindServer at $MindServerUri"
    }
    if ($ws.State -ne [System.Net.WebSockets.WebSocketState]::Open) {
        $state = $ws.State
        $ws.Dispose()
        throw "[WS] MindServer connection failed (state: $state)"
    }

    # socket.io v4 handshake: request namespace connection ("40"), wait for ack.
    Send-SioFrameText $ws "40" | Out-Null
    $deadline = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $deadline) {
        $frame = Receive-SioFrame $ws 500
        if ($frame) {
            if ($frame.StartsWith("40")) { break }          # namespace connect ack
            if ($frame.StartsWith("2")) { Send-SioFrameText $ws "3" | Out-Null }  # engine.io ping -> pong
        }
    }

    Write-Host "[WS] Connected to MindServer." -ForegroundColor Green
    return $ws
}

function Wait-KeepAlive {
    # Waits $seconds while answering engine.io pings ("2" -> "3") so the
    # MindServer does not drop us between steps.
    param($ws, [int]$seconds)
    $deadline = (Get-Date).AddSeconds($seconds)
    while ($true) {
        $remainingMs = [int](($deadline - (Get-Date)).TotalMilliseconds)
        if ($remainingMs -le 0) { break }
        $frame = Receive-SioFrame $ws ([Math]::Min(500, $remainingMs))
        if ($frame) {
            if ($frame.StartsWith("2")) {
                Send-SioFrameText $ws "3" | Out-Null
            } elseif ($frame.Length -gt 0) {
                $preview = $frame
                if ($preview.Length -gt 120) { $preview = $preview.Substring(0, 120) + "..." }
                Write-Host "[WS] <- $preview" -ForegroundColor DarkGray
            }
        }
        if ($ws.State -ne [System.Net.WebSockets.WebSocketState]::Open) {
            Write-Host "[WS] Connection closed by server." -ForegroundColor Red
            break
        }
        Start-Sleep -Milliseconds 100
    }
}

# ------------------------- Bot startup / readiness --------------------------
function Show-LogTail {
    param([string]$logPath)
    if (Test-Path $logPath) {
        Write-Host "--- last 15 bot log lines ---" -ForegroundColor DarkGray
        Get-Content $logPath -Tail 15 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
    }
}

function Wait-BotReady {
    # Polls the redirected stdout file for a readiness signal instead of
    # relying on variables set inside Start-Job (which never reach the parent).
    param([string]$logPath, $process, [int]$timeoutSeconds)
    Write-Host "[BOT] Waiting up to ${timeoutSeconds}s for bot readiness..." -ForegroundColor Yellow
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if ($process.HasExited) {
            Write-Host "[BOT] Bot process exited early with code $($process.ExitCode)." -ForegroundColor Red
            Show-LogTail $logPath
            return $false
        }
        if (Test-Path $logPath) {
            $lines = Get-Content $logPath -Tail 200 -ErrorAction SilentlyContinue
            foreach ($line in $lines) {
                if ($line -match "Connection ready|spawned|In Game|logged in") {
                    Write-Host "[BOT] Ready signal: $line" -ForegroundColor Green
                    $script:botReady = $true
                    return $true
                }
                if ($line -match "\[CHAT\] sending reply") {
                    Write-Host $line -ForegroundColor Magenta
                }
            }
        }
        Start-Sleep -Seconds 2
    }
    Write-Host "[BOT] Timed out waiting for readiness signal." -ForegroundColor Red
    Show-LogTail $logPath
    return $false
}

# ------------------------- Goal execution -----------------------------------
function Process-Goals {
    param($ws)
    foreach ($goal in $script:goals) {
        if ($goal.status -ne "pending") { continue }
        while ($true) {
            $stepIndex = [int]$goal.currentStep
            $steps = @($goal.steps)
            if ($stepIndex -ge $steps.Count) {
                $goal.status = "completed"
                Save-Goals
                Write-Host "[GOAL] Completed: $($goal.description)" -ForegroundColor Cyan
                break
            }
            $step = [string]$steps[$stepIndex]
            Write-Host ("[GOAL] Executing: {0} - Step {1}: {2}" -f $goal.description, ($stepIndex + 1), $step) -ForegroundColor Yellow

            # socket.io v4 event frame: '42["send-message","ayushi",{...}]'
            $payload = @("send-message", $BotName, @{ from = "updesh"; message = $step })
            $sent = Send-SioMessage $ws $payload
            if (-not $sent) {
                Write-Host "[GOAL] Aborting mission: cannot reach MindServer." -ForegroundColor Red
                return
            }
            Write-Host "[INJECT] Sent: $step" -ForegroundColor Green

            $goal.currentStep = $stepIndex + 1
            Save-Goals        # persist progress after each step

            Wait-KeepAlive $ws $StepDelaySeconds
        }
    }
}

function Start-Mission {
    Load-Goals

    # Start the bot process with stdout/stderr redirected to temp files.
    $stamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $botLog = Join-Path $env:TEMP "mindcraft_bot_stdout_$stamp.log"
    $botErr = Join-Path $env:TEMP "mindcraft_bot_stderr_$stamp.log"
    Write-Host "[BOT] Starting: node main.js (stdout -> $botLog)" -ForegroundColor Yellow
    $bot = Start-Process -FilePath "node" -ArgumentList "main.js" -WorkingDirectory $PSScriptRoot `
        -RedirectStandardOutput $botLog -RedirectStandardError $botErr `
        -PassThru -NoNewWindow

    try {
        if (-not (Wait-BotReady -logPath $botLog -process $bot -timeoutSeconds $ReadinessTimeoutSeconds)) {
            Write-Host "Mission aborted: bot never became ready." -ForegroundColor Red
            return
        }

        Write-Host "Bot is ready. Starting mission..." -ForegroundColor Green
        $ws = Connect-MindServer
        try {
            Process-Goals $ws
        } finally {
            if ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
                $closeTask = $ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, "mission complete", [System.Threading.CancellationToken]::None)
                $closeTask.Wait(3000) | Out-Null
            }
            $ws.Dispose()
        }
    } finally {
        if (-not $bot.HasExited) {
            Stop-Process -Id $bot.Id -Force -ErrorAction SilentlyContinue
            Write-Host "[BOT] Stopped bot process (pid $($bot.Id))." -ForegroundColor Gray
        }
    }
}

Start-Mission
