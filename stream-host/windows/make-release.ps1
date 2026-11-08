# Packs the Windows stream host into a zip from this checkout. Nothing in the zip comes
# from outside the repository except the three binary inputs you point it at:
#
#   -Game      folder holding the built hwengine.exe, its DLLs and Data\
#   -Ffmpeg    folder holding ffmpeg.exe (with h264_qsv or h264_nvenc) and its DLLs
#   -Mediamtx  folder holding mediamtx.exe (optional)
#
# The zip never contains a .env: the user copies .env.example and fills it in.
#
#   powershell -ExecutionPolicy Bypass -File make-release.ps1 -Game C:\build\game -Ffmpeg C:\tools\ffmpeg -Out C:\out\hw-stream-win.zip

param(
    [Parameter(Mandatory)] [string]$Game,
    [Parameter(Mandatory)] [string]$Ffmpeg,
    [string]$Mediamtx,
    [Parameter(Mandatory)] [string]$Out
)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$stream = Split-Path $here -Parent
$repo = Split-Path $stream -Parent

foreach ($need in @("$Game\hwengine.exe", "$Game\Data", "$Ffmpeg\ffmpeg.exe")) {
    if (-not (Test-Path $need)) { throw "missing $need" }
}

$commit = (git -C $repo rev-parse --short=9 HEAD).Trim()
$branch = (git -C $repo rev-parse --abbrev-ref HEAD).Trim()
if (git -C $repo status --porcelain --untracked-files=no) {
    throw "uncommitted changes in ${repo}: commit them so the zip matches $commit"
}

$stage = Join-Path ([IO.Path]::GetTempPath()) ("hw-stream-win-" + [guid]::NewGuid().ToString("n"))
$dest = Join-Path $stage "hw-stream-win"
New-Item -ItemType Directory -Path $dest | Out-Null
try {
    # the agent, its data and the launchers come from git, so the zip is the committed code
    $tracked = Join-Path $stage "export.tar"
    git -C $repo archive --format=tar -o $tracked HEAD stream-host/agent stream-host/data stream-host/windows stream-host/.env.example
    if ($LASTEXITCODE) { throw "git archive failed" }
    tar -xf $tracked -C $stage
    $src = Join-Path $stage "stream-host"
    Copy-Item "$src\agent" $dest -Recurse
    Copy-Item "$src\data" $dest -Recurse
    Copy-Item "$src\.env.example" $dest
    Copy-Item "$src\windows\run.ps1" $dest
    Copy-Item "$src\windows\launch.bat" $dest
    Copy-Item "$src\windows\release-readme.txt" "$dest\README.txt"

    Copy-Item $Game "$dest\game" -Recurse
    Copy-Item $Ffmpeg "$dest\ffmpeg" -Recurse
    if ($Mediamtx) { Copy-Item $Mediamtx "$dest\mediamtx" -Recurse }

    Set-Content -Path "$dest\VERSION.txt" -Encoding ascii -Value @(
        "Hedgewars stream host for Windows",
        "commit $commit (branch $branch)",
        "built $(Get-Date -Format yyyy-MM-dd)"
    )

    # no real values may travel in the zip
    foreach ($f in Get-ChildItem $dest -Recurse -Force -File) {
        if ($f.Name -in @(".env", ".dev.vars", "wrangler.local.toml") -or $f.Name -like "*.local.*") {
            throw "refusing to pack $($f.FullName)"
        }
    }

    $outDir = Split-Path -Parent ([IO.Path]::GetFullPath($Out))
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
    if (Test-Path $Out) { Remove-Item $Out -Force }
    tar -a -c -f $Out -C $stage "hw-stream-win"
    if ($LASTEXITCODE) { throw "tar failed" }
    "{0}  ({1:N0} MB)" -f $Out, ((Get-Item $Out).Length / 1MB)
}
finally {
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
