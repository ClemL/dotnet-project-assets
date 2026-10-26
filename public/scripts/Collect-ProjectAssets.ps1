#Requires -Version 5.1
<#
.SYNOPSIS
    Copies every obj\project.assets.json under your source folders into one collection folder for
    assets-graph.

.DESCRIPTION
    Walks each folder in -SourceRoots without entering node_modules, bin, .vs, .git, packages, or
    junctions/symbolic links, and copies every <project>\obj\project.assets.json to
    <Destination>\project-assets\<n>_<root name>\<path relative to the root>\obj\project.assets.json.

    The folder structure is kept, so "Choose folder..." on the assets-graph Inputs tab finds the files.
    Source folders are only read, never changed. Restore or build the solutions first (dotnet restore)
    so the files are current. A CSV log of the copied files is written to the collection folder.

    Works in Windows PowerShell 5.1 and PowerShell 7. Supports -WhatIf.

.EXAMPLE
    .\Collect-ProjectAssets.ps1

.EXAMPLE
    .\Collect-ProjectAssets.ps1 -SourceRoots @('C:\dev\git', 'D:\src') -Destination 'C:\dev\results\AssetsGraphInputs_20261026_1405' -MaxAgeDays 30 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    # Folders to search. Missing folders are reported and skipped.
    [string[]]$SourceRoots = @('C:\dev\git', 'C:\dev\repos', "$env:USERPROFILE\source\repos"),

    # Collection folder, created if missing. Default: C:\dev\results\AssetsGraphInputs_yyyyMMdd_HHmm.
    [string]$Destination = ('C:\dev\results\AssetsGraphInputs_{0}' -f (Get-Date -Format 'yyyyMMdd_HHmm')),

    # Skip files not written in the last N days (stale restores). Default: 0 (no age limit).
    [int]$MaxAgeDays = 0,

    # Folder names that are never entered.
    [string[]]$SkipFolders = @('node_modules', 'bin', '.vs', '.git', 'packages', '.idea')
)

$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyyMMdd_HHmm'
$script:unreadable = 0

function Get-RelativePath([string]$Root, [string]$Path) {
    return $Path.Substring($Root.TrimEnd('\', '/').Length).TrimStart('\', '/')
}

# Depth-first walk that never enters skipped folders or reparse points (junctions, symbolic links).
function Find-ProjectAssets([string]$Root, [string[]]$Skip) {
    $found = New-Object System.Collections.Generic.List[string]
    $stack = New-Object System.Collections.Generic.Stack[System.IO.DirectoryInfo]
    $stack.Push((New-Object System.IO.DirectoryInfo $Root))
    while ($stack.Count -gt 0) {
        $dir = $stack.Pop()
        try { $children = $dir.GetDirectories() }
        catch { $script:unreadable++; continue }
        foreach ($child in $children) {
            if ($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { continue }
            if ($Skip -contains $child.Name) { continue }
            if ($child.Name -eq 'obj') {
                $file = Join-Path $child.FullName 'project.assets.json'
                if (Test-Path -LiteralPath $file -PathType Leaf) { $found.Add($file) }
                continue
            }
            $stack.Push($child)
        }
    }
    return $found
}

$assetsRoot = Join-Path $Destination 'project-assets'
$cutoff = if ($MaxAgeDays -gt 0) { (Get-Date).AddDays(-$MaxAgeDays) } else { [datetime]::MinValue }
$log = New-Object System.Collections.Generic.List[object]
$skippedOld = 0

for ($i = 0; $i -lt $SourceRoots.Count; $i++) {
    $root = $SourceRoots[$i]
    if ([string]::IsNullOrWhiteSpace($root) -or -not (Test-Path -LiteralPath $root -PathType Container)) {
        Write-Host "Skipped (not found): $root"
        continue
    }
    $rootFull = (Resolve-Path -LiteralPath $root).Path
    $rootLabel = '{0}_{1}' -f ($i + 1), ((Split-Path -Leaf $rootFull) -replace '[^A-Za-z0-9._-]+', '_')
    Write-Host "Searching $rootFull ..."
    foreach ($file in @(Find-ProjectAssets $rootFull $SkipFolders)) {
        $item = Get-Item -LiteralPath $file
        if ($item.LastWriteTime -lt $cutoff) { $skippedOld++; continue }
        $target = Join-Path (Join-Path $assetsRoot $rootLabel) (Get-RelativePath $rootFull $file)
        if ($PSCmdlet.ShouldProcess($file, "Copy to $target")) {
            New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
            Copy-Item -LiteralPath $file -Destination $target -Force
        }
        $log.Add([pscustomobject]@{
                Source        = $file
                Destination   = $target
                SizeKB        = [math]::Round($item.Length / 1KB, 1)
                LastWriteTime = $item.LastWriteTime.ToString('yyyy-MM-dd HH:mm')
            })
    }
}

if ($log.Count -gt 0 -and -not $WhatIfPreference) {
    $logPath = Join-Path $Destination ('Collect-ProjectAssets_{0}.csv' -f $stamp)
    $log | Export-Csv -LiteralPath $logPath -NoTypeInformation -Encoding UTF8
}

$verb = if ($WhatIfPreference) { 'Would copy' } else { 'Copied' }
$ageNote = if ($MaxAgeDays -gt 0) { '; {0} skipped as older than {1} day(s)' -f $skippedOld, $MaxAgeDays } else { '' }
Write-Host ('{0} {1} project.assets.json file(s){2}; {3} folder(s) unreadable.' -f $verb, $log.Count, $ageNote, $script:unreadable)
if ($log.Count -gt 0) {
    $oldest = $log | Sort-Object LastWriteTime | Select-Object -First 1
    Write-Host ('Oldest restore: {0} ({1})' -f $oldest.LastWriteTime, $oldest.Source)
}
if ($log.Count -eq 0) { Write-Host 'Nothing found. Point -SourceRoots at the folders that contain your solutions, and restore them first (dotnet restore).' }
if ($log.Count -gt 0 -and -not $WhatIfPreference) {
    Write-Host 'Collected into:'
    Write-Host (Resolve-Path -LiteralPath $assetsRoot).Path
    Write-Host 'Next: assets-graph Inputs tab > Choose folder... > pick the folder above.'
}
Write-Host 'Upload to OneDrive: https://inscriptrx-my.sharepoint.com/'
