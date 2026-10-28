#Requires -Version 7.0
<#
.SYNOPSIS
    Exports a package -> assembly map for the assets-graph Fix Planner: for every cached version of each
    internal package, the AssemblyVersion and FileVersion of the DLLs in lib\<tfm>\.

.DESCRIPTION
    Package versions (10.0.0-13615) and AssemblyVersions (10.0.0.40512) come from different counters, so
    the only way to know which package version ships a new enough assembly is to read the DLLs. This
    script walks the NuGet global packages folder, keeps package Ids matching -IdPattern, and reads each
    version's lib\<Tfm>\*.dll with System.Reflection.Metadata (assemblies are never loaded). A package
    without a lib\<Tfm>\ folder falls back to its highest other lib\ folder, recorded in "tfm".

    Writes results\PackageAssemblyMap_yyyyMMdd_HHmm.json:
        [{ id, packageVersion, dll, assemblyVersion, fileVersion, tfm }]
    Load it in assets-graph under Inputs > Runtime binding inputs. The cache holds only versions that
    were restored on this machine; the printed dotnet package search command lists every version on the
    feed.

.EXAMPLE
    .\Export-PackageAssemblyMap.ps1

.EXAMPLE
    .\Export-PackageAssemblyMap.ps1 -PackagesPath "$env:USERPROFILE\.nuget\packages" -IdPattern '^(model|plugin|datalayer|feature|linql)\.' -Tfm 'net10.0' -ResultsFolder '.\results'
#>
[CmdletBinding()]
param(
    # NuGet global packages folder. Default: %USERPROFILE%\.nuget\packages (set -PackagesPath if NUGET_PACKAGES moves it).
    [string]$PackagesPath = "$env:USERPROFILE\.nuget\packages",

    # Regex on the package Id (case-insensitive). Default: the internal prefixes.
    [string]$IdPattern = '^(model|plugin|datalayer|feature|linql)\.',

    # Target framework folder under lib\. Default: net10.0.
    [string]$Tfm = 'net10.0',

    # Output folder, created if missing. Default: .\results under the current directory.
    [string]$ResultsFolder = '.\results'
)

$ErrorActionPreference = 'Stop'
$FeedUrl = 'https://pkgs.dev.azure.com/inscriptrx/_packaging/org/nuget/v3/index.json'

# Accept either separator so the same arguments work on Windows and on PowerShell for Linux/macOS.
$sep = [IO.Path]::DirectorySeparatorChar
$PackagesPath = $PackagesPath -replace '[\\/]', $sep
$ResultsFolder = $ResultsFolder -replace '[\\/]', $sep

if (-not (Test-Path -LiteralPath $PackagesPath -PathType Container)) {
    throw "Packages folder not found: $PackagesPath. Pass -PackagesPath (or check `$env:NUGET_PACKAGES)."
}

# AssemblyVersion from metadata; never loads the assembly. $null for native or unreadable DLLs.
function Get-AssemblyVersionOrNull([string]$Path) {
    $stream = $null
    $pe = $null
    try {
        $stream = [IO.File]::OpenRead($Path)
        $pe = [System.Reflection.PortableExecutable.PEReader]::new($stream)
        if (-not $pe.HasMetadata) { return $null }
        $md = [System.Reflection.Metadata.PEReaderExtensions]::GetMetadataReader($pe)
        if (-not $md.IsAssembly) { return $null }
        return $md.GetAssemblyDefinition().Version.ToString()
    }
    catch { return $null }
    finally {
        if ($pe) { $pe.Dispose() }
        if ($stream) { $stream.Dispose() }
    }
}

function Get-FileVersionOrNull([string]$Path) {
    try {
        $v = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($Path).FileVersion
        if ([string]::IsNullOrWhiteSpace($v)) { return $null }
        return $v.Trim()
    }
    catch { return $null }
}

$entries = [System.Collections.Generic.List[object]]::new()
$ids = [System.Collections.Generic.List[string]]::new()
$fallbacks = 0
$noLib = 0

foreach ($idDir in Get-ChildItem -LiteralPath $PackagesPath -Directory | Where-Object { $_.Name -match $IdPattern } | Sort-Object Name) {
    foreach ($versionDir in Get-ChildItem -LiteralPath $idDir.FullName -Directory | Sort-Object Name) {
        # The nuspec carries the Id's real casing; the folder name is lowercase.
        $nuspec = Get-ChildItem -LiteralPath $versionDir.FullName -Filter '*.nuspec' -File | Select-Object -First 1
        $id = $idDir.Name
        if ($nuspec) {
            try { $id = ([xml](Get-Content -LiteralPath $nuspec.FullName -Raw)).package.metadata.id } catch { }
        }
        $libRoot = Join-Path $versionDir.FullName 'lib'
        $tfmDir = Join-Path $libRoot $Tfm
        $usedTfm = $Tfm
        if (-not (Test-Path -LiteralPath $tfmDir -PathType Container)) {
            $other = Get-ChildItem -LiteralPath $libRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
            if (-not $other) { $noLib++; continue }
            $tfmDir = $other.FullName
            $usedTfm = $other.Name
            $fallbacks++
        }
        foreach ($dll in Get-ChildItem -LiteralPath $tfmDir -Filter '*.dll' -File | Sort-Object Name) {
            $assemblyVersion = Get-AssemblyVersionOrNull $dll.FullName
            if (-not $assemblyVersion) { continue }
            $entries.Add([ordered]@{
                    id              = $id
                    packageVersion  = $versionDir.Name
                    dll             = $dll.Name
                    assemblyVersion = $assemblyVersion
                    fileVersion     = Get-FileVersionOrNull $dll.FullName
                    tfm             = $usedTfm
                })
        }
        if (-not $ids.Contains($id)) { $ids.Add($id) }
    }
}

if (-not (Test-Path -LiteralPath $ResultsFolder)) {
    New-Item -ItemType Directory -Path $ResultsFolder | Out-Null
}
$fileName = 'PackageAssemblyMap_{0}.json' -f (Get-Date -Format 'yyyyMMdd_HHmm')
$outputPath = Join-Path (Resolve-Path -LiteralPath $ResultsFolder).Path $fileName
ConvertTo-Json -InputObject @($entries) -Depth 3 | Set-Content -LiteralPath $outputPath -Encoding UTF8

Write-Host ('Mapped {0} DLL(s) in {1} package version(s) across {2} package Id(s); {3} used a fallback lib folder; {4} had no lib folder.' -f $entries.Count, @($entries | ForEach-Object { "$($_.id)/$($_.packageVersion)" } | Select-Object -Unique).Count, $ids.Count, $fallbacks, $noLib)
Write-Host 'Map written to:'
Write-Host $outputPath
Write-Host 'Upload to OneDrive: https://inscriptrx-my.sharepoint.com/'
Write-Host ''
Write-Host 'The cache holds only versions restored on this machine. To list every version on the feed:'
Write-Host ("  dotnet package search <Id> --source '{0}' --prerelease --exact-match --format table" -f $FeedUrl)
if ($ids.Count -gt 0) {
    Write-Host ("  dotnet package search {0} --source '{1}' --prerelease --exact-match --format table" -f $ids[0], $FeedUrl)
}
