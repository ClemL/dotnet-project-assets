// PowerShell scripts shown on the Collect scripts tab. Scripts in public/scripts are fetched at run
// time (one copy, also downloadable from /scripts/); the source-map script is embedded.

import { SOURCE_MAP_SCRIPT } from '../input/sourceMapScript';

export type ScriptSource = { url: string } | { text: string };

export interface CollectScript {
  id: string;
  file: string;
  title: string;
  purpose: string;
  /** Where the output goes in this app. */
  feeds: string;
  /** Default places searched. */
  searches: string[];
  /** Where the copies land under the collection folder. */
  output: string;
  requires: 'Windows PowerShell 5.1 or PowerShell 7' | 'PowerShell 7+';
  /** Example invocation with every parameter spelled out at its default (or a typical value). */
  example: string;
  source: ScriptSource;
}

export const COLLECTION_FOLDER = 'C:\\dev\\results\\AssetsGraphInputs_yyyyMMdd_HHmm';

/** Shared first line of every example: one collection folder per PowerShell session. */
const DEST = "if (-not $dest) { $dest = 'C:\\dev\\results\\AssetsGraphInputs_{0}' -f (Get-Date -Format 'yyyyMMdd_HHmm') }";

export const SETUP_SNIPPET = `# Save the scripts below into C:\\dev\\scripts (each card has Download and Copy), then in PowerShell:
New-Item -ItemType Directory -Path 'C:\\dev\\scripts' -Force | Out-Null
Set-Location 'C:\\dev\\scripts'
# Files downloaded from a browser are blocked until unblocked.
Get-ChildItem -Filter '*.ps1' | Unblock-File
# Allow local scripts in this window only.
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
# One collection folder for everything you run in this window.
$dest = 'C:\\dev\\results\\AssetsGraphInputs_{0}' -f (Get-Date -Format 'yyyyMMdd_HHmm')`;

export const RUN_ALL_SNIPPET = `# Run in PowerShell 7 (pwsh) from C:\\dev\\scripts so the assembly manifests are exported too.
Set-Location 'C:\\dev\\scripts'
$dest = 'C:\\dev\\results\\AssetsGraphInputs_{0}' -f (Get-Date -Format 'yyyyMMdd_HHmm')

.\\Collect-ProjectAssets.ps1 -SourceRoots @('C:\\dev\\git') -Destination $dest
.\\Collect-BuildOutputs.ps1 -SourceRoots @('C:\\dev\\git') -Configuration 'Debug' -RunManifest $true -Destination $dest
# Deployed apps: narrow with -NameFilter 'YourPrefix*'; run elevated to include IIS sites.
.\\Collect-DeployedApps.ps1 -NameFilter '*' -RunManifest $true -Destination $dest
.\\Export-NuGetSourceMap.ps1 -OutputFolder (Join-Path $dest 'source-map')
.\\Export-PackageAssemblyMap.ps1 -ResultsFolder (Join-Path $dest 'fix-planner')

# One zip to move or upload.
Compress-Archive -Path (Join-Path $dest '*') -DestinationPath "$dest.zip" -Force
Write-Host "Collected: $dest"
Write-Host "Zip:       $dest.zip"
Write-Host 'Upload to OneDrive: https://inscriptrx-my.sharepoint.com/'`;

const LAYOUT_ROWS: [string, string][] = [
  ['  project-assets\\1_git\\<Repo>\\<Project>\\obj\\project.assets.json', '-> Inputs: Choose folder... (pick project-assets)'],
  ['  binding\\<App>\\Debug_net10.0\\', '-> Inputs: Runtime binding inputs'],
  ['      <App>.deps.json, <App>.runtimeconfig.json, AssemblyManifest_<App>_yyyyMMdd_HHmm.json', ''],
  ['  deployed\\<App>_<folder>\\', '-> Inputs: Runtime binding inputs (same three files)'],
  ['  source-map\\NuGetSourceMap_yyyyMMdd_HHmm.json', '-> Inputs: Package source metadata > Bundled map'],
  ['  fix-planner\\PackageAssemblyMap_*.json, AssemblyReferences_*.csv', '-> Inputs: Runtime binding inputs (or paste the scan on Fix planner)'],
  ['  Collect-*_yyyyMMdd_HHmm.csv', '   copy logs: source path, destination, date'],
];
const LAYOUT_WIDTH = Math.max(...LAYOUT_ROWS.filter(([, note]) => note).map(([path]) => path.length)) + 2;

export const LAYOUT_SNIPPET = [`${COLLECTION_FOLDER}\\`, ...LAYOUT_ROWS.map(([path, note]) => (note ? path.padEnd(LAYOUT_WIDTH) + note : path))].join('\n');

export const COLLECT_SCRIPTS: CollectScript[] = [
  {
    id: 'project-assets',
    file: 'Collect-ProjectAssets.ps1',
    title: 'project.assets.json files',
    purpose: 'Copies every obj\\project.assets.json under your source folders, keeping the folder structure. Restore or build first so the files are current; the summary prints the oldest restore found.',
    feeds: 'Inputs → Choose folder… (or Upload files). Drives Dependencies, Duplicates, Tree, Build order, and Version skew.',
    searches: ['C:\\dev\\git', 'C:\\dev\\repos', '%USERPROFILE%\\source\\repos', 'Skips node_modules, bin, .vs, .git, packages, and junctions'],
    output: 'project-assets\\<n>_<root>\\…\\obj\\project.assets.json',
    requires: 'Windows PowerShell 5.1 or PowerShell 7',
    example: `${DEST}\n.\\Collect-ProjectAssets.ps1 -SourceRoots @('C:\\dev\\git', 'C:\\dev\\repos', "$env:USERPROFILE\\source\\repos") -Destination $dest -MaxAgeDays 0 -SkipFolders @('node_modules', 'bin', '.vs', '.git', 'packages', '.idea')`,
    source: { url: '/scripts/Collect-ProjectAssets.ps1' },
  },
  {
    id: 'build-outputs',
    file: 'Collect-BuildOutputs.ps1',
    title: 'Build outputs: deps.json, runtimeconfig.json, assembly manifest',
    purpose:
      'Finds applications in bin\\<Configuration>\\ (including <rid>\\ and publish\\ folders), copies <App>.deps.json and <App>.runtimeconfig.json, and in PowerShell 7 runs Export-AssemblyManifest.ps1 for each. Class libraries and test projects are skipped. In Windows PowerShell 5.1 it prints the manifest commands to run in pwsh.',
    feeds: 'Inputs → Runtime binding inputs, then the Binding check tab.',
    searches: ['bin\\Debug\\ under C:\\dev\\git, C:\\dev\\repos, %USERPROFILE%\\source\\repos', "-Configuration 'Release' or '*' for other builds"],
    output: 'binding\\<App>\\<Configuration>_<tfm>[_<rid>][_publish]\\',
    requires: 'Windows PowerShell 5.1 or PowerShell 7',
    example: `${DEST}\n.\\Collect-BuildOutputs.ps1 -SourceRoots @('C:\\dev\\git', 'C:\\dev\\repos', "$env:USERPROFILE\\source\\repos") -Configuration 'Debug' -NameFilter '*' -ExcludeNames @('*.Tests', '*.Test', '*.UnitTests', '*.IntegrationTests', 'testhost*') -RunManifest $true -ManifestScript '.\\Export-AssemblyManifest.ps1' -DotnetRoot 'C:\\Program Files\\dotnet' -SkipFolders @('node_modules', 'obj', '.vs', '.git', 'packages', '.idea') -Destination $dest`,
    source: { url: '/scripts/Collect-BuildOutputs.ps1' },
  },
  {
    id: 'deployed-apps',
    file: 'Collect-DeployedApps.ps1',
    title: 'Deployed apps: IIS, Windows services, install folders',
    purpose:
      'A FileNotFoundException comes from the folder the process actually runs from. This finds deployed .NET apps (IIS sites from applicationHost.config, Windows services, common install folders), copies their deps.json and runtimeconfig.json, and in PowerShell 7 exports a manifest with plugin subfolders as separate roots. Run elevated to include IIS. On Azure App Service (Kudu), use -Destination D:\\home\\data\\AssetsGraphInputs.',
    feeds: 'Inputs → Runtime binding inputs, then the Binding check tab (paste the exception into the error lookup).',
    searches: ['IIS site and application folders', 'Windows services with a matching <Name>.runtimeconfig.json', 'C:\\inetpub\\wwwroot, C:\\Program Files, C:\\Program Files (x86), C:\\Services, C:\\Apps, D:\\home\\site\\wwwroot (4 levels deep)', 'Skips SDKs and tools (dotnet, Visual Studio, PowerShell, …)'],
    output: 'deployed\\<App>_<folder>\\',
    requires: 'Windows PowerShell 5.1 or PowerShell 7',
    example: `${DEST}\n.\\Collect-DeployedApps.ps1 -DeployRoots @('C:\\inetpub\\wwwroot', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\Services', 'C:\\Apps', 'D:\\home\\site\\wwwroot') -MaxDepth 4 -IncludeIis $true -IncludeServices $true -NameFilter '*' -ExcludePaths @('*\\dotnet\\*', '*\\Microsoft Visual Studio\\*', '*\\PowerShell\\*', '*\\WindowsApps\\*', '*\\Common Files\\*', '*\\Reference Assemblies\\*', '*\\MSBuild\\*', '*\\Microsoft SQL Server*', '*\\Microsoft\\Edge*', '*\\JetBrains\\*', '*\\Azure Data Studio\\*') -RunManifest $true -MaxManifests 25 -ManifestScript '.\\Export-AssemblyManifest.ps1' -DotnetRoot 'C:\\Program Files\\dotnet' -PluginFolders @('plugins', 'modules', 'extensions', 'addins') -Destination $dest`,
    source: { url: '/scripts/Collect-DeployedApps.ps1' },
  },
  {
    id: 'assembly-manifest',
    file: 'Export-AssemblyManifest.ps1',
    title: 'Assembly manifest for one folder',
    purpose:
      'Reads the name, version, public key token, and references of every managed DLL with PEReader/MetadataReader (never loads them), plus the shared framework named by runtimeconfig.json. The two collect scripts above call it; run it directly for a single folder.',
    feeds: "Inputs → Runtime binding inputs, together with the same folder's deps.json.",
    searches: ['-BinPath and any -ExtraPaths (plugin folders)', '<DotnetRoot>\\shared\\<framework>\\<version>\\'],
    output: 'AssemblyManifest_<App>_yyyyMMdd_HHmm.json in -ResultsFolder',
    requires: 'PowerShell 7+',
    example: `${DEST}\n.\\Export-AssemblyManifest.ps1 -BinPath 'C:\\dev\\git\\<Repo>\\<Project>\\bin\\Debug\\net10.0' -ExtraPaths @() -IncludeFramework $true -DotnetRoot 'C:\\Program Files\\dotnet' -ResultsFolder (Join-Path $dest 'binding')`,
    source: { url: '/scripts/Export-AssemblyManifest.ps1' },
  },
  {
    id: 'assembly-references',
    file: 'Find-AssemblyReference.ps1',
    title: 'Who references the assembly that failed (REFERENCER scan)',
    purpose:
      'The runtime reports only the first reference that fails. This lists every DLL in the failing folder that references the named assembly, with the exact version each was compiled against, plus the deployed copies, and prints the required minimum (the highest RefersTo).',
    feeds: 'Fix planner: paste the printed table, or load the CSV under Inputs → Runtime binding inputs.',
    searches: ['-Path (the bin or deployed folder that failed) and its subfolders'],
    output: 'fix-planner\\AssemblyReferences_<Name>_yyyyMMdd_HHmm.csv (columns Kind, Assembly, AssemblyVersion, ReferencesVersion, Path)',
    requires: 'PowerShell 7+',
    example: `${DEST}\n.\\Find-AssemblyReference.ps1 -Path 'C:\\dev\\git\\<Repo>\\<Project>\\bin\\Debug\\net10.0' -Name 'Model.Import' -Recurse $true -ResultsFolder (Join-Path $dest 'fix-planner')`,
    source: { url: '/scripts/Find-AssemblyReference.ps1' },
  },
  {
    id: 'package-assembly-map',
    file: 'Export-PackageAssemblyMap.ps1',
    title: 'Package → assembly map (which package version ships which AssemblyVersion)',
    purpose:
      'Reads lib\\<tfm>\\*.dll of every cached version of each internal package (metadata only) and records its AssemblyVersion and FileVersion. The Fix planner uses it to find the lowest package version whose assembly is new enough to pin. The cache holds only what was restored locally; the script prints the dotnet package search command that lists every version on the feed.',
    feeds: 'Fix planner → Option 1 (pin), via Inputs → Runtime binding inputs.',
    searches: ['%USERPROFILE%\\.nuget\\packages, Ids matching ^(model|plugin|datalayer|feature|linql)\\.', 'lib\\net10.0\\ (else the highest other lib\\ folder)'],
    output: 'fix-planner\\PackageAssemblyMap_yyyyMMdd_HHmm.json',
    requires: 'PowerShell 7+',
    example: `${DEST}\n.\\Export-PackageAssemblyMap.ps1 -PackagesPath "$env:USERPROFILE\\.nuget\\packages" -IdPattern '^(model|plugin|datalayer|feature|linql)\\.' -Tfm 'net10.0' -ResultsFolder (Join-Path $dest 'fix-planner')`,
    source: { url: '/scripts/Export-PackageAssemblyMap.ps1' },
  },
  {
    id: 'source-map',
    file: 'Export-NuGetSourceMap.ps1',
    title: 'NuGet source map (which feed each package came from)',
    purpose: 'Reads every <id>\\<version>\\.nupkg.metadata in the NuGet global packages folder and writes one JSON map of package → source feed. Lets the Classification tab tell internal packages from public ones without nuget.org lookups.',
    feeds: 'Inputs → Package source metadata → Bundled map.',
    searches: ['$env:NUGET_PACKAGES, else %USERPROFILE%\\.nuget\\packages'],
    output: 'source-map\\NuGetSourceMap_yyyyMMdd_HHmm.json',
    requires: 'Windows PowerShell 5.1 or PowerShell 7',
    example: `${DEST}\n.\\Export-NuGetSourceMap.ps1 -PackagesPath "$env:USERPROFILE\\.nuget\\packages" -OutputFolder (Join-Path $dest 'source-map') -IdFilter '*'`,
    source: { text: SOURCE_MAP_SCRIPT },
  },
];
