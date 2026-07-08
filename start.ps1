$ErrorActionPreference = "Stop"
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$bundledPython = "C:\Users\timot\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"

if (Test-Path -LiteralPath $bundledPython) {
    $python = $bundledPython
} else {
    $command = Get-Command python -ErrorAction SilentlyContinue
    if (-not $command) {
        Write-Host "Python wurde nicht gefunden. Bitte Python 3.10+ installieren." -ForegroundColor Red
        Read-Host "Enter zum Beenden"
        exit 1
    }
    $python = $command.Source
}

Set-Location -LiteralPath $project
& $python (Join-Path $project "server.py") --open
