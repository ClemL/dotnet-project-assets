<#
.SYNOPSIS
    Exports a NuGet source map for assets-graph: { "<id-lowercase>/<version>": "<source>" }.

.DESCRIPTION
    Reads every <id>/<version>/.nupkg.metadata file in the NuGet global packages folder and writes
    results\NuGetSourceMap_yyyyMMdd_HHmm.json. Load that file in assets-graph under
    "Package source metadata" > "Bundled map". Only the package Id, version, and source feed are
    exported; no package contents.

.EXAMPLE
    .\Export-NuGetSourceMap.ps1

.EXAMPLE
    .\Export-NuGetSourceMap.ps1 -PackagesPath "D:\nuget\packages" -OutputFolder ".\results" -IdFilter "acme.*"
#>
[CmdletBinding()]
param(
    # Global packages folder. Default: $env:NUGET_PACKAGES, else %UserProfile%\.nuget\packages.
    [string]$PackagesPath = $(if ($env:NUGET_PACKAGES) { $env:NUGET_PACKAGES } else { Join-Path $env:USERPROFILE '.nuget\packages' }),

    # Output folder, created if missing. Default: .\results under the current directory.
    [string]$OutputFolder = (Join-Path (Get-Location) 'results'),

    # Wildcard filter on package Id folder names. Default: all packages.
    [string]$IdFilter = '*'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $PackagesPath)) {
    throw "Packages folder not found: $PackagesPath"
}
if (-not (Test-Path -LiteralPath $OutputFolder)) {
    New-Item -ItemType Directory -Path $OutputFolder | Out-Null
}

$map = [ordered]@{}
$skipped = 0

foreach ($idDir in Get-ChildItem -LiteralPath $PackagesPath -Directory -Filter $IdFilter | Sort-Object Name) {
    $id = $idDir.Name.ToLowerInvariant()
    foreach ($versionDir in Get-ChildItem -LiteralPath $idDir.FullName -Directory | Sort-Object Name) {
        $metadataPath = Join-Path $versionDir.FullName '.nupkg.metadata'
        if (-not (Test-Path -LiteralPath $metadataPath)) { continue }
        try {
            $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
            if ($metadata.source) {
                $map["$id/$($versionDir.Name.ToLowerInvariant())"] = [string]$metadata.source
            }
            else {
                $skipped++
            }
        }
        catch {
            $skipped++
        }
    }
}

$fileName = 'NuGetSourceMap_{0}.json' -f (Get-Date -Format 'yyyyMMdd_HHmm')
$outputPath = Join-Path (Resolve-Path -LiteralPath $OutputFolder).Path $fileName
$map | ConvertTo-Json -Depth 2 | Set-Content -LiteralPath $outputPath -Encoding UTF8

Write-Host ('Exported {0} package versions ({1} skipped) to:' -f $map.Count, $skipped)
Write-Host $outputPath
Write-Host 'Upload to OneDrive: https://inscriptrx-my.sharepoint.com/'
