#Requires -Version 5.1
<#
.SYNOPSIS
    Copies <App>.deps.json and <App>.runtimeconfig.json from your build output folders and, in
    PowerShell 7, exports an assembly manifest for each app, for the assets-graph Binding check.

.DESCRIPTION
    Walks -SourceRoots (without entering node_modules, obj, .vs, .git, packages, or junctions) for bin
    folders, then looks under bin\<Configuration>\ (including <tfm>\<rid>\ and publish\ subfolders) for
    applications: a <Name>.runtimeconfig.json next to a <Name>.deps.json. Class libraries (no
    runtimeconfig.json) and test projects (-ExcludeNames) are skipped.

    Each app's two files are copied to
    <Destination>\binding\<Name>\<Configuration>_<tfm>[_<rid>][_publish]\.
    With -RunManifest in PowerShell 7, Export-AssemblyManifest.ps1 runs against the same output folder
    and writes AssemblyManifest_<Name>_yyyyMMdd_HHmm.json next to them; in Windows PowerShell 5.1 the
    commands to run are printed instead. Source folders are only read. Supports -WhatIf.

.EXAMPLE
    .\Collect-BuildOutputs.ps1

.EXAMPLE
    .\Collect-BuildOutputs.ps1 -SourceRoots @('C:\dev\git\RxSense') -Configuration 'Release' -NameFilter 'RxSense.*' -RunManifest $true -ManifestScript 'C:\dev\scripts\Export-AssemblyManifest.ps1' -DotnetRoot 'C:\Program Files\dotnet' -Destination 'C:\dev\results\AssetsGraphInputs_20261026_1405'
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    # Folders to search. Missing folders are reported and skipped.
    [string[]]$SourceRoots = @('C:\dev\git', 'C:\dev\repos', "$env:USERPROFILE\source\repos"),

    # Collection folder, created if missing. Default: C:\dev\results\AssetsGraphInputs_yyyyMMdd_HHmm.
    [string]$Destination = ('C:\dev\results\AssetsGraphInputs_{0}' -f (Get-Date -Format 'yyyyMMdd_HHmm')),

    # bin\<Configuration>\ folder to read: 'Debug', 'Release', or '*' for every configuration.
    [string]$Configuration = 'Debug',

    # Wildcard on the application name (the deps.json base name). Default: all.
    [string]$NameFilter = '*',

    # Application names to skip (wildcards). Default: test projects and the test host.
    [string[]]$ExcludeNames = @('*.Tests', '*.Test', '*.UnitTests', '*.IntegrationTests', 'testhost*'),

    # Run Export-AssemblyManifest.ps1 for each app found (PowerShell 7+). Default: $true.
    [bool]$RunManifest = $true,

    # Path to Export-AssemblyManifest.ps1. Default: next to this script.
    [string]$ManifestScript = $(if ($PSScriptRoot) { Join-Path $PSScriptRoot 'Export-AssemblyManifest.ps1' } else { '.\Export-AssemblyManifest.ps1' }),

    # .NET installation root passed to Export-AssemblyManifest.ps1 for the shared-framework list.
    [string]$DotnetRoot = 'C:\Program Files\dotnet',

    # Folder names that are never entered while looking for bin folders.
    [string[]]$SkipFolders = @('node_modules', 'obj', '.vs', '.git', 'packages', '.idea')
)

$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyyMMdd_HHmm'
$script:unreadable = 0

function Get-RelativePath([string]$Root, [string]$Path) {
    return $Path.Substring($Root.TrimEnd('\', '/').Length).TrimStart('\', '/')
}

# Every bin folder under Root; does not descend into bin folders or skipped folders or junctions.
function Find-BinFolders([string]$Root, [string[]]$Skip) {
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
            if ($child.Name -eq 'bin') { $found.Add($child.FullName); continue }
            $stack.Push($child)
        }
    }
    return $found
}

$canRunManifest = $RunManifest -and $PSVersionTable.PSVersion.Major -ge 7 -and (Test-Path -LiteralPath $ManifestScript -PathType Leaf)
$pendingManifests = New-Object System.Collections.Generic.List[string]
$used = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$log = New-Object System.Collections.Generic.List[object]
$manifests = 0

for ($i = 0; $i -lt $SourceRoots.Count; $i++) {
    $root = $SourceRoots[$i]
    if ([string]::IsNullOrWhiteSpace($root) -or -not (Test-Path -LiteralPath $root -PathType Container)) {
        Write-Host "Skipped (not found): $root"
        continue
    }
    $rootFull = (Resolve-Path -LiteralPath $root).Path
    Write-Host "Searching $rootFull ..."
    foreach ($bin in @(Find-BinFolders $rootFull $SkipFolders)) {
        foreach ($configDir in @(Get-ChildItem -LiteralPath $bin -Directory -Filter $Configuration -ErrorAction SilentlyContinue)) {
            $configs = @(Get-ChildItem -LiteralPath $configDir.FullName -Recurse -Depth 3 -File -Filter '*.runtimeconfig.json' -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -notlike '*.runtimeconfig.dev.json' })
            foreach ($rc in $configs) {
                $name = $rc.Name -replace '\.runtimeconfig\.json$', ''
                $deps = Join-Path $rc.DirectoryName "$name.deps.json"
                if (-not (Test-Path -LiteralPath $deps -PathType Leaf)) { continue }
                if ($name -notlike $NameFilter) { continue }
                if (@($ExcludeNames | Where-Object { $name -like $_ }).Count -gt 0) { continue }

                # Debug_net10.0, Release_net10.0_win-x64_publish, ...
                $variant = (Get-RelativePath $bin $rc.DirectoryName) -replace '[\\/]+', '_'
                $target = Join-Path (Join-Path (Join-Path $Destination 'binding') $name) $variant
                $n = 2
                while (-not $used.Add($target)) { $target = Join-Path (Join-Path (Join-Path $Destination 'binding') $name) ('{0}_{1}' -f $variant, $n); $n++ }

                if ($PSCmdlet.ShouldProcess($rc.DirectoryName, "Copy $name.deps.json and $name.runtimeconfig.json to $target")) {
                    New-Item -ItemType Directory -Path $target -Force | Out-Null
                    Copy-Item -LiteralPath $deps -Destination $target -Force
                    Copy-Item -LiteralPath $rc.FullName -Destination $target -Force
                    if ($canRunManifest) {
                        & $ManifestScript -BinPath $rc.DirectoryName -ResultsFolder $target -IncludeFramework $true -DotnetRoot $DotnetRoot
                        $manifests++
                    }
                    elseif ($RunManifest) {
                        $pendingManifests.Add(("& '{0}' -BinPath '{1}' -ResultsFolder '{2}' -IncludeFramework `$true -DotnetRoot '{3}'" -f $ManifestScript, $rc.DirectoryName, $target, $DotnetRoot))
                    }
                }
                $log.Add([pscustomobject]@{
                        App           = $name
                        Variant       = $variant
                        Source        = $rc.DirectoryName
                        Destination   = $target
                        LastWriteTime = (Get-Item -LiteralPath $deps).LastWriteTime.ToString('yyyy-MM-dd HH:mm')
                    })
            }
        }
    }
}

if ($log.Count -gt 0 -and -not $WhatIfPreference) {
    $logPath = Join-Path $Destination ('Collect-BuildOutputs_{0}.csv' -f $stamp)
    $log | Export-Csv -LiteralPath $logPath -NoTypeInformation -Encoding UTF8
}

$verb = if ($WhatIfPreference) { 'Would copy' } else { 'Copied' }
Write-Host ('{0} deps.json + runtimeconfig.json for {1} app output folder(s) ({2}); {3} manifest(s) exported; {4} folder(s) unreadable.' -f $verb, $log.Count, $Configuration, $manifests, $script:unreadable)
foreach ($entry in $log) { Write-Host ('  {0} [{1}] built {2}' -f $entry.App, $entry.Variant, $entry.LastWriteTime) }
if ($pendingManifests.Count -gt 0) {
    $reason = if ($PSVersionTable.PSVersion.Major -lt 7) { 'needs PowerShell 7' } else { "not found: $ManifestScript" }
    Write-Host "Assembly manifests were not exported ($reason). Run these in PowerShell 7 (pwsh):"
    foreach ($cmd in $pendingManifests) { Write-Host "  $cmd" }
}
if ($log.Count -eq 0) { Write-Host "Nothing found. Build the app first, or try -Configuration 'Release' or '*', and check -SourceRoots and -NameFilter." }
if ($log.Count -gt 0 -and -not $WhatIfPreference) {
    Write-Host 'Collected into:'
    Write-Host (Resolve-Path -LiteralPath (Join-Path $Destination 'binding')).Path
    Write-Host 'Next: assets-graph Inputs tab > Runtime binding inputs > upload one app folder''s files.'
}
Write-Host 'Upload to OneDrive: https://inscriptrx-my.sharepoint.com/'
