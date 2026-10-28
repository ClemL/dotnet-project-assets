#Requires -Version 7.0
<#
.SYNOPSIS
    Lists every DLL in a folder that references a given assembly, with the exact version each was
    compiled against (REFERENCER rows), plus the deployed copies of that assembly (DEPLOYED rows).

.DESCRIPTION
    The runtime reports only the first reference that fails to load. This scan shows all of them, so the
    fix (deployed version >= the highest RefersTo) covers every requester. Reads metadata with
    System.Reflection.Metadata; assemblies are never loaded.

    Prints the table (Kind, Dll, Version, RefersTo) and writes
    results\AssemblyReferences_<Name>_yyyyMMdd_HHmm.csv with Kind, Assembly, AssemblyVersion,
    ReferencesVersion, Path. Paste the table or load the CSV in the assets-graph Fix Planner.

.EXAMPLE
    .\Find-AssemblyReference.ps1 -Name 'Model.Import'

.EXAMPLE
    .\Find-AssemblyReference.ps1 -Path 'C:\dev\git\<Repo>\<Project>\bin\Debug\net10.0' -Name 'Model.Import' -Recurse $true -ResultsFolder '.\results'
#>
[CmdletBinding()]
param(
    # Folder to scan: the bin folder (or deployed folder) that failed.
    [string]$Path = 'C:\dev\git\<Repo>\<Project>\bin\Debug\net10.0',

    # Simple name of the assembly that failed to load (from "Could not load file or assembly '<Name>, ...").
    [string]$Name = 'Model.Import',

    # Include subfolders (plugin folders, runtimes\). Default: $true.
    [bool]$Recurse = $true,

    # Output folder, created if missing. Default: .\results under the current directory.
    [string]$ResultsFolder = '.\results'
)

$ErrorActionPreference = 'Stop'
$sep = [IO.Path]::DirectorySeparatorChar
$Path = $Path -replace '[\\/]', $sep
$ResultsFolder = $ResultsFolder -replace '[\\/]', $sep

if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "Folder not found: $Path. Pass -Path with the folder the failing process runs from."
}

$rows = [System.Collections.Generic.List[object]]::new()
$nonManaged = 0
foreach ($file in Get-ChildItem -LiteralPath $Path -Filter '*.dll' -File -Recurse:$Recurse | Sort-Object FullName) {
    $stream = $null
    $pe = $null
    try {
        $stream = [IO.File]::OpenRead($file.FullName)
        $pe = [System.Reflection.PortableExecutable.PEReader]::new($stream)
        if (-not $pe.HasMetadata) { $nonManaged++; continue }
        $md = [System.Reflection.Metadata.PEReaderExtensions]::GetMetadataReader($pe)
        if (-not $md.IsAssembly) { continue }
        $def = $md.GetAssemblyDefinition()
        $selfName = $md.GetString($def.Name)
        $selfVersion = $def.Version.ToString()
        if ($selfName -ieq $Name) {
            $rows.Add([pscustomobject]@{ Kind = 'DEPLOYED'; Assembly = $file.Name; AssemblyVersion = $selfVersion; ReferencesVersion = ''; Path = $file.FullName })
        }
        foreach ($handle in $md.AssemblyReferences) {
            $ref = $md.GetAssemblyReference($handle)
            if ($md.GetString($ref.Name) -ieq $Name) {
                $rows.Add([pscustomobject]@{ Kind = 'REFERENCER'; Assembly = $file.Name; AssemblyVersion = $selfVersion; ReferencesVersion = $ref.Version.ToString(); Path = $file.FullName })
            }
        }
    }
    catch [System.BadImageFormatException] { $nonManaged++ }
    finally {
        if ($pe) { $pe.Dispose() }
        if ($stream) { $stream.Dispose() }
    }
}

# Highest RefersTo first, then the deployed copies.
$referencers = @($rows | Where-Object Kind -eq 'REFERENCER' | Sort-Object { [version]$_.ReferencesVersion } -Descending)
$deployed = @($rows | Where-Object Kind -eq 'DEPLOYED')
$ordered = @($referencers) + @($deployed)

# Out-String with a wide width: Format-Table would otherwise cut long names with "..." in a narrow console.
$ordered | Select-Object Kind, @{ n = 'Dll'; e = { $_.Assembly } }, @{ n = 'Version'; e = { $_.AssemblyVersion } }, @{ n = 'RefersTo'; e = { $_.ReferencesVersion } } |
    Format-Table -AutoSize | Out-String -Width 4096 | Write-Host

if (-not (Test-Path -LiteralPath $ResultsFolder)) {
    New-Item -ItemType Directory -Path $ResultsFolder | Out-Null
}
$safeName = $Name -replace '[^A-Za-z0-9._-]+', '_'
$fileName = 'AssemblyReferences_{0}_{1}.csv' -f $safeName, (Get-Date -Format 'yyyyMMdd_HHmm')
$outputPath = Join-Path (Resolve-Path -LiteralPath $ResultsFolder).Path $fileName
$ordered | Select-Object Kind, Assembly, AssemblyVersion, ReferencesVersion, Path | Export-Csv -LiteralPath $outputPath -NoTypeInformation -Encoding UTF8

if ($referencers.Count -gt 0) {
    $required = $referencers[0].ReferencesVersion
    # The copy closest to the scanned folder is the one the app loads; plugin subfolders hold their own copies.
    $current = if ($deployed.Count -gt 0) { ($deployed | Sort-Object { ($_.Path -split '[\\/]').Count }, { [version]$_.AssemblyVersion } | Select-Object -First 1).AssemblyVersion } else { $null }
    $failing = if ($current) { @($referencers | Where-Object { [version]$_.ReferencesVersion -gt [version]$current }).Count } else { $referencers.Count }
    Write-Host ('Required minimum {0}: {1} (highest RefersTo). Deployed: {2}. {3} of {4} referencer(s) need a newer {0}.' -f $Name, $required, $(if ($current) { $current } else { 'none' }), $failing, $referencers.Count)
    Write-Host 'The runtime reports only the first failure; a fix must cover all of them.'
}
else {
    Write-Host "No DLL under $Path references $Name ($nonManaged non-.NET DLL(s) skipped). The requester may be loaded from another folder."
}
Write-Host 'Scan written to:'
Write-Host $outputPath
Write-Host 'Upload to OneDrive: https://inscriptrx-my.sharepoint.com/'
