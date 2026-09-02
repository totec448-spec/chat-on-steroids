param(
    [switch]$FailFetch
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSCommandPath
$serveDir = Join-Path $root 'src\renderer'
$pidFile = Join-Path $root '.one-cycle-last-pids.txt'
$metaFile = Join-Path $root '.one-cycle-last-meta.txt'
$server = $null
$trackedPids = @()
$exitCode = 0

function Get-ProcessTreePids {
    param([int]$RootPid)

    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $result = New-Object System.Collections.Generic.List[int]
    $queue = New-Object System.Collections.Generic.Queue[int]
    $queue.Enqueue($RootPid)

    while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()
        if (-not $result.Contains($current)) {
            [void]$result.Add($current)
            foreach ($child in $all | Where-Object { $_.ParentProcessId -eq $current }) {
                $queue.Enqueue([int]$child.ProcessId)
            }
        }
    }

    return @($result)
}

try {
    Remove-Item -LiteralPath $pidFile, $metaFile -Force -ErrorAction SilentlyContinue

    if (-not (Test-Path -LiteralPath (Join-Path $serveDir 'index.html'))) {
        throw "Missing real renderer page: $serveDir\index.html"
    }

    $python = Get-Command python.exe -ErrorAction Stop

    $probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $probe.Start()
    $port = ([System.Net.IPEndPoint]$probe.LocalEndpoint).Port
    $probe.Stop()

    Write-Output "ONE_CYCLE_BEGIN"
    Write-Output "SERVER_EXE=$($python.Source)"
    Write-Output "SERVER_PORT=$port"

    $serverOut = Join-Path $root '.one-cycle-server.out.log'
    $serverErr = Join-Path $root '.one-cycle-server.err.log'
    Remove-Item -LiteralPath $serverOut, $serverErr -Force -ErrorAction SilentlyContinue

    $server = Start-Process `
        -FilePath $python.Source `
        -ArgumentList @('-m', 'http.server', "$port", '--bind', '127.0.0.1', '--directory', $serveDir) `
        -WorkingDirectory $root `
        -WindowStyle Hidden `
        -RedirectStandardOutput $serverOut `
        -RedirectStandardError $serverErr `
        -PassThru

    Write-Output "SERVER_PID=$($server.Id)"

    # One bounded startup wait; there is no polling or retry loop.
    Start-Sleep -Milliseconds 600

    if ($server.HasExited) {
        throw "Server exited before fetch."
    }

    $trackedPids = @(Get-ProcessTreePids -RootPid $server.Id | Sort-Object -Unique)
    $trackedPids | Set-Content -LiteralPath $pidFile -Encoding ascii
    @("SERVER_PID=$($server.Id)", "SERVER_PORT=$port", "SPAWNED_PIDS=$($trackedPids -join ',')") |
        Set-Content -LiteralPath $metaFile -Encoding ascii
    Write-Output "SPAWNED_PIDS=$($trackedPids -join ',')"

    $url = if ($FailFetch) {
        "http://127.0.0.1:$port/__forced_fetch_failure__"
    } else {
        "http://127.0.0.1:$port/index.html"
    }

    Write-Output "FETCH_URL=$url"
    $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 5
    Write-Output "FETCH_STATUS=$($response.StatusCode)"
}
catch {
    $exitCode = 1
    Write-Output "FETCH_OR_RUN_ERROR=$($_.Exception.Message)"
}
finally {
    if ($server) {
        $liveTree = @()
        if (Get-Process -Id $server.Id -ErrorAction SilentlyContinue) {
            $liveTree = @(Get-ProcessTreePids -RootPid $server.Id)
        }

        $trackedPids = @($trackedPids + $liveTree + $server.Id | Sort-Object -Unique)
        $trackedPids | Set-Content -LiteralPath $pidFile -Encoding ascii

        Write-Output "STOPPING_PIDS=$($trackedPids -join ',')"

        if (Get-Process -Id $server.Id -ErrorAction SilentlyContinue) {
            & taskkill.exe /PID $server.Id /T /F | ForEach-Object { Write-Output "TASKKILL=$_"}
        }

        Start-Sleep -Milliseconds 250

        $alive = @($trackedPids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
        $listeners = @(
            foreach ($p in $trackedPids) {
                Get-NetTCPConnection -OwningProcess $p -State Listen -ErrorAction SilentlyContinue
            }
        )

        if ($alive.Count -gt 0 -or $listeners.Count -gt 0) {
            $exitCode = 2
            Write-Output "CLEANUP_ERROR=alive:$($alive -join ',');listeners:$($listeners.Count)"
        } else {
            Write-Output "CLEANUP_OK=all_tracked_pids_dead;listeners=0"
        }
    }

    Write-Output "ONE_CYCLE_END"
}

exit $exitCode
