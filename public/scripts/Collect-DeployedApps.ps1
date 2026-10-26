#Requires -Version 5.1
<#
.SYNOPSIS
    Finds deployed .NET applications (IIS sites, Windows services, common install folders) and copies
    their deps.json and runtimeconfig.json, plus an assembly manifest in PowerShell 7, for the
    assets-graph Binding check.

.DESCRIPTION
    A FileNotFoundException at runtime comes from the folder the process actually runs from, which is
    often not your build output. This script looks where deployed apps usually live:
      - IIS: every site and application physicalPath in applicationHost.config (needs an elevated
        prompt; skipped with a message otherwise)
      - Windows services whose executable (or the .dll passed to dotnet.exe) has a matching
        <Name>.runtimeconfig.json
      - -DeployRoots, searched -MaxDepth folder levels deep (folders matching -ExcludePaths skipped)

    An application is a folder with <Name>.runtimeconfig.json and <Name>.deps.json. Both files are
    copied to <Destination>\deployed\<Name>_<folder>\. With -RunManifest in PowerShell 7,
    Export-AssemblyManifest.ps1 writes a manifest of that folder (plugin subfolders named in
    -PluginFolders are scanned as separate roots, and the shared framework is listed) next to them.
    Manifests are skipped when more than -MaxManifests apps match; narrow with -NameFilter.
    Nothing in the deployed folders is changed. Supports -WhatIf.

    On Azure App Service (Kudu PowerShell console), pass -Destination 'D:\home\data\AssetsGraphInputs'
    and download that folder from Kudu afterwards.

.EXAMPLE
    .\Collect-DeployedApps.ps1

.EXAMPLE
    .\Collect-DeployedApps.ps1 -DeployRoots @('E:\Sites', 'C:\Services') -NameFilter 'RxSense*' -IncludeIis $true -IncludeServices $true -MaxDepth 3 -RunManifest $true -Destination 'C:\dev\results\AssetsGraphInputs_20261026_1405'
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    # Folders searched for runtimeconfig.json files. Missing folders are skipped.
    [string[]]$DeployRoots = @('C:\inetpub\wwwroot', 'C:\Program Files', 'C:\Program Files (x86)', 'C:\Services', 'C:\Apps', 'D:\home\site\wwwroot'),

    # How many folder levels below each deploy root to search. Default: 4.
    [int]$MaxDepth = 4,

    # Read IIS site and application folders from applicationHost.config. Default: $true.
    [bool]$IncludeIis = $true,

    # Inspect Windows services. Default: $true.
    [bool]$IncludeServices = $true,

    # Wildcard on the application name, e.g. 'RxSense*'. Default: all.
    [string]$NameFilter = '*',

    # Wildcard paths never treated as your apps (SDKs, tools, browsers).
    [string[]]$ExcludePaths = @('*\dotnet\*', '*\Microsoft Visual Studio\*', '*\PowerShell\*', '*\WindowsApps\*', '*\Common Files\*', '*\Reference Assemblies\*', '*\MSBuild\*', '*\Microsoft SQL Server*', '*\Microsoft\Edge*', '*\JetBrains\*', '*\Azure Data Studio\*'),

    # Collection folder, created if missing. Default: C:\dev\results\AssetsGraphInputs_yyyyMMdd_HHmm.
    [string]$Destination = ('C:\dev\results\AssetsGraphInputs_{0}' -f (Get-Date -Format 'yyyyMMdd_HHmm')),

    # Run Export-AssemblyManifest.ps1 for each app found (PowerShell 7+). Default: $true.
    [bool]$RunManifest = $true,

    # Skip manifests when more apps than this match. Default: 25.
    [int]$MaxManifests = 25,

    # Path to Export-AssemblyManifest.ps1. Default: next to this script.
    [string]$ManifestScript = $(if ($PSScriptRoot) { Join-Path $PSScriptRoot 'Export-AssemblyManifest.ps1' } else { '.\Export-AssemblyManifest.ps1' }),

    # .NET installation root passed to Export-AssemblyManifest.ps1 for the shared-framework list.
    [string]$DotnetRoot = 'C:\Program Files\dotnet',

    # Subfolder names inside an app folder that hold plugins; passed to the manifest as extra roots.
    [string[]]$PluginFolders = @('plugins', 'modules', 'extensions', 'addins')
)

$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyyMMdd_HHmm'
$onWindows = $env:OS -eq 'Windows_NT'

$apps = New-Object System.Collections.Generic.List[object]
$seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)

function Test-Excluded([string]$Path) {
    $p = $Path.TrimEnd('\', '/') + '\'
    return @($ExcludePaths | Where-Object { $p.Replace('/', '\') -like $_ }).Count -gt 0
}

# Registers <Folder>\<Name>.runtimeconfig.json as an app when the matching deps.json exists.
function Add-App([string]$RuntimeConfig, [string]$Found) {
    $folder = Split-Path -Parent $RuntimeConfig
    $name = (Split-Path -Leaf $RuntimeConfig) -replace '\.runtimeconfig\.json$', ''
    if ($name -like '*.runtimeconfig.dev') { return }
    if ($name -notlike $NameFilter -or (Test-Excluded $folder)) { return }
    if (-not (Test-Path -LiteralPath (Join-Path $folder "$name.deps.json") -PathType Leaf)) { return }
    if (-not $seen.Add((Join-Path $folder $name))) { return }
    $apps.Add([pscustomobject]@{ Name = $name; Folder = $folder; Found = $Found })
}

function Add-AppsInFolder([string]$Folder, [string]$Found, [int]$Depth) {
    if (-not (Test-Path -LiteralPath $Folder -PathType Container)) { return }
    foreach ($rc in @(Get-ChildItem -LiteralPath $Folder -Recurse -Depth $Depth -File -Filter '*.runtimeconfig.json' -ErrorAction SilentlyContinue)) {
        Add-App $rc.FullName $Found
    }
}

# IIS sites and applications.
if ($IncludeIis -and $onWindows) {
    $configPath = Join-Path $env:windir 'System32\inetsrv\config\applicationHost.config'
    if (Test-Path -LiteralPath $configPath) {
        try {
            [xml]$iis = Get-Content -LiteralPath $configPath -Raw
            foreach ($site in @($iis.configuration.'system.applicationHost'.sites.site)) {
                foreach ($app in @($site.application)) {
                    foreach ($vdir in @($app.virtualDirectory | Where-Object { $_.path -eq '/' })) {
                        $physical = [Environment]::ExpandEnvironmentVariables([string]$vdir.physicalPath)
                        Add-AppsInFolder $physical ('IIS {0}{1}' -f $site.name, $app.path) 1
                    }
                }
            }
        }
        catch {
            Write-Host "IIS: cannot read $configPath ($($_.Exception.Message)). Run from an elevated prompt to include IIS sites."
        }
    }
}

# Windows services: "C:\App\App.exe" args, or "C:\Program Files\dotnet\dotnet.exe" "C:\App\App.dll".
if ($IncludeServices -and $onWindows) {
    foreach ($svc in @(Get-CimInstance -ClassName Win32_Service -ErrorAction SilentlyContinue | Where-Object { $_.PathName })) {
        $tokens = @([regex]::Matches($svc.PathName, '"([^"]+)"|(\S+)') | ForEach-Object { if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[2].Value } })
        if ($tokens.Count -eq 0) { continue }
        $target = $tokens[0]
        if ((Split-Path -Leaf $target) -ieq 'dotnet.exe' -and $tokens.Count -gt 1) { $target = $tokens[1] }
        if ($target -notmatch '\.(exe|dll)$') { continue }
        $rc = Join-Path (Split-Path -Parent $target) (([IO.Path]::GetFileNameWithoutExtension($target)) + '.runtimeconfig.json')
        if (Test-Path -LiteralPath $rc -PathType Leaf) { Add-App $rc ('service {0}' -f $svc.Name) }
    }
}

foreach ($root in $DeployRoots) {
    if ([string]::IsNullOrWhiteSpace($root) -or -not (Test-Path -LiteralPath $root -PathType Container)) {
        Write-Host "Skipped (not found): $root"
        continue
    }
    Write-Host "Searching $root (depth $MaxDepth) ..."
    Add-AppsInFolder (Resolve-Path -LiteralPath $root).Path ('folder {0}' -f $root) $MaxDepth
}

$canRunManifest = $RunManifest -and $PSVersionTable.PSVersion.Major -ge 7 -and (Test-Path -LiteralPath $ManifestScript -PathType Leaf)
if ($canRunManifest -and $apps.Count -gt $MaxManifests) {
    Write-Host ('{0} apps match; manifests skipped (limit {1}). Narrow with -NameFilter, e.g. -NameFilter ''RxSense*''.' -f $apps.Count, $MaxManifests)
    $canRunManifest = $false
}
$pendingManifests = New-Object System.Collections.Generic.List[string]
$manifests = 0
$log = New-Object System.Collections.Generic.List[object]

foreach ($app in $apps) {
    $folderLabel = (($app.Folder -replace '[:\\/ ]+', '_') -replace '[^A-Za-z0-9._-]', '').Trim('_')
    if ($folderLabel.Length -gt 80) { $folderLabel = $folderLabel.Substring($folderLabel.Length - 80) }
    $target = Join-Path (Join-Path $Destination 'deployed') ('{0}_{1}' -f $app.Name, $folderLabel)
    $plugins = @($PluginFolders | ForEach-Object { Join-Path $app.Folder $_ } | Where-Object { Test-Path -LiteralPath $_ -PathType Container })

    if ($PSCmdlet.ShouldProcess($app.Folder, "Copy $($app.Name).deps.json and $($app.Name).runtimeconfig.json to $target")) {
        New-Item -ItemType Directory -Path $target -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $app.Folder "$($app.Name).deps.json") -Destination $target -Force
        Copy-Item -LiteralPath (Join-Path $app.Folder "$($app.Name).runtimeconfig.json") -Destination $target -Force
        if ($canRunManifest) {
            & $ManifestScript -BinPath $app.Folder -ExtraPaths $plugins -ResultsFolder $target -IncludeFramework $true -DotnetRoot $DotnetRoot
            $manifests++
        }
        elseif ($RunManifest) {
            $extra = if ($plugins.Count -gt 0) { " -ExtraPaths @('{0}')" -f ($plugins -join "', '") } else { '' }
            $pendingManifests.Add(("& '{0}' -BinPath '{1}'{2} -ResultsFolder '{3}' -IncludeFramework `$true -DotnetRoot '{4}'" -f $ManifestScript, $app.Folder, $extra, $target, $DotnetRoot))
        }
    }
    $log.Add([pscustomobject]@{
            App           = $app.Name
            Found         = $app.Found
            Folder        = $app.Folder
            Plugins       = ($plugins -join '; ')
            Destination   = $target
            LastWriteTime = (Get-Item -LiteralPath (Join-Path $app.Folder "$($app.Name).deps.json")).LastWriteTime.ToString('yyyy-MM-dd HH:mm')
        })
}

if ($log.Count -gt 0 -and -not $WhatIfPreference) {
    $logPath = Join-Path $Destination ('Collect-DeployedApps_{0}.csv' -f $stamp)
    $log | Export-Csv -LiteralPath $logPath -NoTypeInformation -Encoding UTF8
}

$verb = if ($WhatIfPreference) { 'Would copy' } else { 'Copied' }
Write-Host ('{0} deps.json + runtimeconfig.json for {1} deployed app(s); {2} manifest(s) exported.' -f $verb, $log.Count, $manifests)
foreach ($entry in $log) { Write-Host ('  {0} ({1}) at {2}, deployed {3}' -f $entry.App, $entry.Found, $entry.Folder, $entry.LastWriteTime) }
if ($pendingManifests.Count -gt 0) {
    $reason = if ($PSVersionTable.PSVersion.Major -lt 7) { 'needs PowerShell 7' } elseif (-not (Test-Path -LiteralPath $ManifestScript)) { "not found: $ManifestScript" } else { 'too many apps' }
    Write-Host "Assembly manifests were not exported ($reason). Run these in PowerShell 7 (pwsh):"
    foreach ($cmd in $pendingManifests) { Write-Host "  $cmd" }
}
if ($log.Count -eq 0) { Write-Host 'Nothing found. Add the deployment folder to -DeployRoots, raise -MaxDepth, or run elevated to include IIS sites.' }
if ($log.Count -gt 0 -and -not $WhatIfPreference) {
    Write-Host 'Collected into:'
    Write-Host (Resolve-Path -LiteralPath (Join-Path $Destination 'deployed')).Path
    Write-Host 'Next: assets-graph Inputs tab > Runtime binding inputs > upload one app folder''s files.'
}
Write-Host 'Upload to OneDrive: https://inscriptrx-my.sharepoint.com/'
