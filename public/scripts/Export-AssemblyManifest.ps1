#Requires -Version 7.0
<#
.SYNOPSIS
    Exports an assembly manifest for the assets-graph Binding Check: the name, version, public key
    token, and assembly references of every managed DLL in a bin folder (plus plugin folders and,
    optionally, the shared framework).

.DESCRIPTION
    Reads ECMA-335 metadata with System.Reflection.PortableExecutable.PEReader and
    System.Reflection.Metadata.MetadataReader. Assemblies are never loaded, so nothing in them runs.

    - DLLs without .NET metadata (native code) are skipped and counted.
    - ref\ folders are excluded.
    - runtimes\<rid>\lib\ is included only for the win and win-x64 RIDs; the RID is recorded.
    - With -IncludeFramework, <App>.runtimeconfig.json in BinPath names the shared frameworks. Their
      DLLs are read from <DotnetRoot>\shared\<framework>\<version>\. When that exact version folder
      is not installed, the highest installed patch of the same major.minor is used and recorded.

    Writes results\AssemblyManifest_<AppName>_yyyyMMdd_HHmm.json. Load it in assets-graph under
    Inputs > Runtime binding inputs, together with <App>.deps.json. Only assembly names, versions,
    tokens, and relative paths are exported; no file contents.

.EXAMPLE
    .\Export-AssemblyManifest.ps1 -BinPath 'C:\dev\git\RxSense\RxSense.Api\bin\Debug\net10.0'

.EXAMPLE
    .\Export-AssemblyManifest.ps1 -BinPath 'C:\dev\git\RxSense\RxSense.Api\bin\Debug\net10.0' -ExtraPaths @('C:\dev\git\RxSense\plugins') -IncludeFramework $true -DotnetRoot 'C:\Program Files\dotnet' -ResultsFolder '.\results'
#>
[CmdletBinding()]
param(
    # Application output folder (contains <App>.dll, <App>.deps.json, <App>.runtimeconfig.json).
    [string]$BinPath = 'C:\dev\git\<Repo>\<Project>\bin\Debug\net10.0',

    # Additional folders to scan, such as plugin folders. Default: none.
    [string[]]$ExtraPaths = @(),

    # Also list the shared framework assemblies named by <App>.runtimeconfig.json. Default: $true.
    [bool]$IncludeFramework = $true,

    # .NET installation root that contains shared\<framework>\<version>\. Default: C:\Program Files\dotnet.
    [string]$DotnetRoot = 'C:\Program Files\dotnet',

    # Output folder, created if missing. Default: .\results under the current directory.
    [string]$ResultsFolder = '.\results'
)

$ErrorActionPreference = 'Stop'

# Accept either separator so the same arguments work on Windows and on PowerShell for Linux/macOS.
function ConvertTo-PlatformPath([string]$Path) {
    $sep = [IO.Path]::DirectorySeparatorChar
    return ($Path -replace '[\\/]', $sep)
}

$BinPath = ConvertTo-PlatformPath $BinPath
$ExtraPaths = @($ExtraPaths | Where-Object { $_ } | ForEach-Object { ConvertTo-PlatformPath $_ })
$DotnetRoot = ConvertTo-PlatformPath $DotnetRoot
$ResultsFolder = ConvertTo-PlatformPath $ResultsFolder

if (-not (Test-Path -LiteralPath $BinPath -PathType Container)) {
    throw "BinPath not found: $BinPath. Pass -BinPath with the application's output folder."
}
foreach ($extra in $ExtraPaths) {
    if (-not (Test-Path -LiteralPath $extra -PathType Container)) { throw "ExtraPaths entry not found: $extra" }
}

$AllowedRids = @('win', 'win-x64')

function Get-PublicKeyToken([byte[]]$PublicKey) {
    if ($null -eq $PublicKey -or $PublicKey.Length -eq 0) { return $null }
    $hash = [System.Security.Cryptography.SHA1]::HashData($PublicKey)
    $token = $hash[($hash.Length - 8)..($hash.Length - 1)]
    [array]::Reverse($token)
    return -join ($token | ForEach-Object { $_.ToString('x2') })
}

function ConvertTo-Hex([byte[]]$Bytes) {
    if ($null -eq $Bytes -or $Bytes.Length -eq 0) { return $null }
    return -join ($Bytes | ForEach-Object { $_.ToString('x2') })
}

function Get-FileVersionOrNull([string]$Path) {
    try {
        $v = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($Path).FileVersion
        if ([string]::IsNullOrWhiteSpace($v)) { return $null }
        return $v.Trim()
    }
    catch { return $null }
}

# Returns @{ Kind = 'assembly' | 'nonManaged' | 'netmodule'; ... }. Never loads the assembly.
function Read-AssemblyMetadata([string]$Path) {
    $stream = $null
    $pe = $null
    try {
        $stream = [IO.File]::OpenRead($Path)
        $pe = [System.Reflection.PortableExecutable.PEReader]::new($stream)
        if (-not $pe.HasMetadata) { return @{ Kind = 'nonManaged' } }
        $md = [System.Reflection.Metadata.PEReaderExtensions]::GetMetadataReader($pe)
        if (-not $md.IsAssembly) { return @{ Kind = 'netmodule' } }

        $def = $md.GetAssemblyDefinition()
        $culture = $md.GetString($def.Culture)
        $references = [System.Collections.Generic.List[object]]::new()
        foreach ($handle in $md.AssemblyReferences) {
            $ref = $md.GetAssemblyReference($handle)
            $blob = $md.GetBlobBytes($ref.PublicKeyOrToken)
            # Flag 0x0001 (PublicKey): the reference stores the full key, not the 8-byte token.
            $isFullKey = ([int]$ref.Flags -band [int][System.Reflection.AssemblyFlags]::PublicKey) -ne 0
            $refCulture = $md.GetString($ref.Culture)
            $references.Add([ordered]@{
                    name           = $md.GetString($ref.Name)
                    version        = $ref.Version.ToString()
                    publicKeyToken = $(if ($isFullKey) { Get-PublicKeyToken $blob } else { ConvertTo-Hex $blob })
                    culture        = $(if ([string]::IsNullOrEmpty($refCulture)) { $null } else { $refCulture })
                })
        }
        return @{
            Kind           = 'assembly'
            Name           = $md.GetString($def.Name)
            Version        = $def.Version.ToString()
            PublicKeyToken = Get-PublicKeyToken ($md.GetBlobBytes($def.PublicKey))
            Culture        = $(if ([string]::IsNullOrEmpty($culture)) { $null } else { $culture })
            References     = $references
        }
    }
    catch [System.BadImageFormatException] {
        return @{ Kind = 'nonManaged' }
    }
    finally {
        if ($pe) { $pe.Dispose() }
        if ($stream) { $stream.Dispose() }
    }
}

$skipped = [ordered]@{ nonManaged = 0; netmodule = 0; refFolder = 0; otherRid = 0; unreadable = 0 }
$assemblies = [System.Collections.Generic.List[object]]::new()
$roots = [System.Collections.Generic.List[string]]::new()

$scanRoots = @((Resolve-Path -LiteralPath $BinPath).Path) + @($ExtraPaths | ForEach-Object { (Resolve-Path -LiteralPath $_).Path })
$separator = [IO.Path]::DirectorySeparatorChar
for ($rootIndex = 0; $rootIndex -lt $scanRoots.Count; $rootIndex++) {
    $root = $scanRoots[$rootIndex]
    $roots.Add($root)
    # Extra paths inside this root (e.g. bin\plugins) are scanned as their own roots, not twice.
    $nested = @($scanRoots | Where-Object { $_ -ne $root -and $_.StartsWith($root.TrimEnd('\', '/') + $separator, [StringComparison]::OrdinalIgnoreCase) })
    foreach ($file in Get-ChildItem -LiteralPath $root -Recurse -File -Filter '*.dll' | Sort-Object FullName) {
        if ($nested | Where-Object { $file.FullName.StartsWith($_.TrimEnd('\', '/') + $separator, [StringComparison]::OrdinalIgnoreCase) }) { continue }
        $relative = [IO.Path]::GetRelativePath($root, $file.FullName)
        $segments = $relative -split '[\\/]'
        $dirs = @($segments | Select-Object -SkipLast 1)

        if ($dirs | Where-Object { $_ -ieq 'ref' }) { $skipped.refFolder++; continue }

        $rid = $null
        $runtimesIndex = [array]::FindIndex([string[]]$dirs, [Predicate[string]] { param($s) $s -ieq 'runtimes' })
        if ($runtimesIndex -ge 0) {
            $rid = if ($dirs.Count -gt $runtimesIndex + 1) { $dirs[$runtimesIndex + 1] } else { '' }
            $isLib = $dirs.Count -gt $runtimesIndex + 2 -and $dirs[$runtimesIndex + 2] -ieq 'lib'
            if (-not $isLib -or $AllowedRids -notcontains $rid.ToLowerInvariant()) { $skipped.otherRid++; continue }
        }

        try { $info = Read-AssemblyMetadata $file.FullName }
        catch { $skipped.unreadable++; Write-Verbose "Unreadable: $($file.FullName): $($_.Exception.Message)"; continue }
        if ($info.Kind -eq 'nonManaged') { $skipped.nonManaged++; continue }
        if ($info.Kind -eq 'netmodule') { $skipped.netmodule++; continue }

        $assemblies.Add([ordered]@{
                path           = $relative
                root           = $rootIndex
                name           = $info.Name
                version        = $info.Version
                publicKeyToken = $info.PublicKeyToken
                fileVersion    = Get-FileVersionOrNull $file.FullName
                culture        = $info.Culture
                rid            = $rid
                references     = $info.References
            })
    }
}

# Application name: from <App>.runtimeconfig.json (preferring one with a matching .deps.json), else
# the folder above bin\.
$appName = $null
$runtimeConfigPath = $null
$runtimeConfigs = @(Get-ChildItem -LiteralPath $scanRoots[0] -File -Filter '*.runtimeconfig.json' | Where-Object { $_.Name -notlike '*.runtimeconfig.dev.json' } | Sort-Object Name)
if ($runtimeConfigs.Count -gt 0) {
    $preferred = $runtimeConfigs | Where-Object { Test-Path -LiteralPath (Join-Path $scanRoots[0] ($_.Name -replace '\.runtimeconfig\.json$', '.deps.json')) } | Select-Object -First 1
    $chosen = if ($preferred) { $preferred } else { $runtimeConfigs[0] }
    $runtimeConfigPath = $chosen.FullName
    $appName = $chosen.Name -replace '\.runtimeconfig\.json$', ''
    if ($runtimeConfigs.Count -gt 1) { Write-Warning "Several runtimeconfig.json files in $($scanRoots[0]); using $($chosen.Name)." }
}
if (-not $appName) {
    $parts = $scanRoots[0] -split '[\\/]'
    $binIndex = [array]::LastIndexOf([string[]]($parts | ForEach-Object { $_.ToLowerInvariant() }), 'bin')
    $appName = if ($binIndex -gt 0) { $parts[$binIndex - 1] } else { $parts[-1] }
}

$framework = [System.Collections.Generic.List[object]]::new()
$frameworks = [System.Collections.Generic.List[object]]::new()
$frameworkSkipped = 0
if ($IncludeFramework) {
    if (-not $runtimeConfigPath) {
        Write-Warning "No <App>.runtimeconfig.json in $($scanRoots[0]); framework assemblies not listed."
    }
    else {
        $config = Get-Content -LiteralPath $runtimeConfigPath -Raw | ConvertFrom-Json
        $options = $config.runtimeOptions
        $requested = @()
        if ($options.framework) { $requested += $options.framework }
        if ($options.frameworks) { $requested += @($options.frameworks) }
        if ($options.includedFrameworks) {
            Write-Warning 'Self-contained app: the framework assemblies are already in BinPath; nothing to add from DotnetRoot.'
        }
        foreach ($fw in $requested) {
            $fwRoot = Join-Path (Join-Path $DotnetRoot 'shared') $fw.name
            $exactFolder = Join-Path $fwRoot $fw.version
            $usedVersion = $null
            if (Test-Path -LiteralPath $exactFolder -PathType Container) {
                $usedVersion = [string]$fw.version
            }
            elseif (Test-Path -LiteralPath $fwRoot -PathType Container) {
                $want = [System.Management.Automation.SemanticVersion]::new(0)
                if ([System.Management.Automation.SemanticVersion]::TryParse([string]$fw.version, [ref]$want)) {
                    $best = $null
                    foreach ($dir in Get-ChildItem -LiteralPath $fwRoot -Directory) {
                        $candidate = [System.Management.Automation.SemanticVersion]::new(0)
                        if (-not [System.Management.Automation.SemanticVersion]::TryParse($dir.Name, [ref]$candidate)) { continue }
                        if ($candidate.Major -ne $want.Major -or $candidate.Minor -ne $want.Minor) { continue }
                        if ($null -eq $best -or $candidate -gt $best.Version) { $best = @{ Version = $candidate; Name = $dir.Name } }
                    }
                    if ($best) { $usedVersion = $best.Name }
                }
            }
            if (-not $usedVersion) {
                Write-Warning "Framework $($fw.name) $($fw.version) is not installed under $fwRoot (no folder with the same major.minor)."
                $frameworks.Add([ordered]@{ name = $fw.name; requestedVersion = [string]$fw.version; usedVersion = $null; exact = $false; path = $null })
                continue
            }
            $folder = Join-Path $fwRoot $usedVersion
            $frameworks.Add([ordered]@{ name = $fw.name; requestedVersion = [string]$fw.version; usedVersion = $usedVersion; exact = ($usedVersion -eq [string]$fw.version); path = $folder })
            foreach ($file in Get-ChildItem -LiteralPath $folder -File -Filter '*.dll' | Sort-Object Name) {
                try { $info = Read-AssemblyMetadata $file.FullName } catch { $frameworkSkipped++; continue }
                if ($info.Kind -ne 'assembly') { $frameworkSkipped++; continue }
                $framework.Add([ordered]@{ name = $info.Name; version = $info.Version; framework = $fw.name; publicKeyToken = $info.PublicKeyToken })
            }
        }
    }
}

$manifest = [ordered]@{
    schema      = 1
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    tool        = 'Export-AssemblyManifest.ps1'
    appName     = $appName
    roots       = $roots
    frameworks  = $frameworks
    skipped     = $skipped
    assemblies  = $assemblies
    framework   = $framework
}

if (-not (Test-Path -LiteralPath $ResultsFolder)) {
    New-Item -ItemType Directory -Path $ResultsFolder | Out-Null
}
$safeName = $appName -replace '[^A-Za-z0-9._-]+', '_'
$fileName = 'AssemblyManifest_{0}_{1}.json' -f $safeName, (Get-Date -Format 'yyyyMMdd_HHmm')
$outputPath = Join-Path (Resolve-Path -LiteralPath $ResultsFolder).Path $fileName
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $outputPath -Encoding UTF8

$referenceCount = ($assemblies | ForEach-Object { $_.references.Count } | Measure-Object -Sum).Sum
Write-Host ('Assemblies: {0} ({1} references) in {2} root(s)' -f $assemblies.Count, [int]$referenceCount, $roots.Count)
Write-Host ('Skipped: {0} non-.NET, {1} netmodule, {2} under ref\, {3} other RID, {4} unreadable' -f $skipped.nonManaged, $skipped.netmodule, $skipped.refFolder, $skipped.otherRid, $skipped.unreadable)
foreach ($fw in $frameworks) {
    if ($fw.usedVersion) {
        Write-Host ('Framework {0}: requested {1}, used {2}{3}' -f $fw.name, $fw.requestedVersion, $fw.usedVersion, $(if ($fw.exact) { '' } else { ' (highest installed patch)' }))
    }
}
if ($IncludeFramework) { Write-Host ('Framework assemblies: {0} ({1} non-.NET skipped)' -f $framework.Count, $frameworkSkipped) }
Write-Host 'Manifest written to:'
Write-Host $outputPath
Write-Host 'Upload to OneDrive: https://inscriptrx-my.sharepoint.com/'
