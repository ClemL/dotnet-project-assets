# assets-graph

Client-side analyzer for NuGet `obj/project.assets.json` files: dependency list, duplicates, dependency
trees (`dotnet nuget why` style), origin classification, and an internal build order grouped into
parallel waves.

Everything runs in the browser. The site is a static Next.js export with no server functions, no API
routes, no database, and no analytics. File contents never leave the tab. The only network requests are
optional nuget.org lookups, which send package Ids (not file contents) and run only when you click
**Look up N packages on nuget.org**. The `Content-Security-Policy` in `vercel.json` enforces this:
`connect-src 'self' https://api.nuget.org`.

## Quick start

```powershell
npm ci
npm run dev        # http://localhost:3000
npm test           # Vitest unit tests (lib/ and client/nugetLookup)
npm run typecheck
npm run build      # static export to out/
```

Node 20.9 or later.

## Using it

| Tab | What it does |
| --- | --- |
| Inputs | Paste (one body per box, **+ Add another**), upload `.json` files, or scan a folder. Folder scans keep only `**/obj/project.assets.json` and skip `node_modules`, `bin`, `.vs`, `.git`; the match count is shown before anything is analyzed. Optional `.nupkg.metadata` sources go here too. |
| Classification | Offline toggle, nuget.org lookups, system/internal prefixes, internal feeds, manual overrides. |
| Dependencies | Sortable, filterable list: Id, resolved version(s), type, direct/transitive, origin, reason, projects. Override any origin per Id. |
| Duplicates | Across target frameworks, across projects (drift), range conflicts, redundant direct references, case-only Id collisions. |
| Tree | Per project and target. `Id (requested range → resolved)`, `(*)` jumps to the first expansion, cycles are flagged, and the search box highlights every path to an Id. |
| Build order | Internal nodes only, public chains collapsed, Kahn waves, cycle paths when no order exists, and a DAG colored by wave. |
| Version skew | Stale internal builds: per-package skew (requested vs resolved build, spread, oldest requester, severity), consumer ranking with the outlier, a wave-ordered rebuild plan (with cascade), and floating/unpinned direct references with lock-file and Central Package Management status. Settings (build-number regex, thresholds, rebuild minimum, cascade, public packages) are saved in the browser. |
| Binding check | Enabled once `<App>.deps.json` and an assembly manifest are loaded (Inputs → Runtime binding inputs). Paste a FileNotFoundException / FileLoadException to find every requester of that exact assembly version, what is deployed instead, and the NuGet packages on both sides. Also lists every reference by classification, assemblies with multiple copies, and package version ↔ AssemblyVersion correlation. |
| Export | Markdown, JSON, and CSV (`-Dependencies`, `-BuildOrder`, `-VersionSkew`) named `AssetsGraph_<ProjectNameOrMerged>_yyyyMMdd_HHmm.<ext>`. |

The **Scope** selector switches every results tab between the merged graph and a single file.

On Edge and Chrome, **Choose folder…** uses `showDirectoryPicker()` and never enters ignored folders.
Other browsers fall back to `<input webkitdirectory>`, which lists every file under the folder before the
app can filter them and may show an "upload" confirmation. Nothing is uploaded in either case.

### Origin classification

First match wins:

1. Manual override (saved in `localStorage`).
2. Source metadata for the exact Id + version:
   - `https://api.nuget.org/v3/index.json` → **Public**, or **System** if a system prefix also matches.
   - A configured internal feed → **Private**.
   - Local paths and unconfigured feeds → noted, then fall through.
3. `type: project` → **Project**.
4. System prefix (`System.`, `Microsoft.`, `runtime.`, `NETStandard.`, `Microsoft.NETCore.` by default) → **System**.
5. Internal prefix → **Private**.
6. nuget.org flat container (8 concurrent requests, 7-day `localStorage` cache):
   - Version listed → **Public**.
   - 404, or the Id exists but that version is not listed → **Private (inferred)**.
   - Offline mode, or a failed lookup → **Unclassified**.

If every public-looking package with metadata reports the same non-nuget.org feed, the app shows a
warning: the feed proxies nuget.org, so metadata cannot separate internal from public packages.
Metadata from that feed is then ignored, unless you tick **Trust this feed's metadata anyway**.

### Source metadata map

`scripts/Export-NuGetSourceMap.ps1` writes `results\NuGetSourceMap_yyyyMMdd_HHmm.json` from your global
packages folder. Load it under **Inputs → Package source metadata → c. Bundled map**.

```powershell
.\scripts\Export-NuGetSourceMap.ps1
.\scripts\Export-NuGetSourceMap.ps1 -PackagesPath "$env:USERPROFILE\.nuget\packages" -OutputFolder ".\results" -IdFilter "*"
```

## Deploying to Vercel

The repository root is the app, so no Root Directory setting is needed. Vercel detects Next.js and serves
the static export; `vercel.json` adds the CSP and other security headers.

```powershell
npm i -g vercel
vercel login
vercel link            # first time: create or select the project, e.g. "assets-graph"
vercel                 # preview deployment
vercel --prod          # production deployment
```

Leave Vercel Web Analytics and Speed Insights off for this project. They load from the same origin, so the CSP
would not stop them.

### Keeping the URL private (Deployment Protection)

1. Open the Vercel dashboard → project **assets-graph** → **Settings** → **Deployment Protection**.
2. Turn on **Vercel Authentication**. Only signed-in members of your Vercel team can open the site,
   plus anyone you grant access through a shareable link or an access request.
3. Pick the scope:
   - **Standard Protection** (all plans) protects preview URLs and generated deployment URLs, but
     **not** the production domain.
   - **All Deployments** also protects the production domain. It requires a Pro or Enterprise plan.
4. On Hobby, either avoid production deployments and share preview URLs only (`vercel`, not
   `vercel --prod`), or upgrade.
5. **Password Protection** is available on Enterprise, or as a paid add-on on Pro.

Plan availability changes; check <https://vercel.com/docs/deployment-protection> before relying on it.

## Code layout

```
lib/        pure analysis code, no React or DOM: parse, graph, duplicates, classify, metadata, export, versions, framework, paths,
            skew + floating (Version skew), binding + bindingInputs (Binding check)
workers/    analyze.worker.ts (wraps lib) and the message protocol
client/     browser side effects with injectable dependencies: nuget.org lookups, localStorage, file and folder picking, downloads
components/ React UI
tests/      Vitest suites and hand-written fixtures
scripts/    Export-NuGetSourceMap.ps1
public/scripts/  Export-AssemblyManifest.ps1 (downloadable from the Binding check tab)
```

## Binding check rules

The assembly manifest comes from `public/scripts/Export-AssemblyManifest.ps1` (PowerShell 7+), which reads
metadata with `PEReader`/`MetadataReader` and never loads an assembly. Package versions and AssemblyVersions
are never compared with each other; deps.json is the only mapping between them.

Verified on .NET 10.0.13 (default load context) by swapping DLLs under a test app:

1. A deployed version lower than the reference fails with FileNotFoundException "The system cannot find the
   file specified", the same exception as a missing file. The exception type does not separate the two.
2. A DLL in `bin\` that `<App>.deps.json` does not list is not loadable (same FileNotFoundException).
3. The public key token is not checked: a different key, signed → unsigned, and unsigned → signed all bind.
   TOKEN_MISMATCH is therefore a warning, not an error (.NET Framework would fail).
4. When the app and the shared framework both ship an assembly, the higher version wins, compared using the
   `assemblyVersion` recorded in deps.json. Without that field, the framework copy wins.
5. deps.json records `assemblyVersion` for package and project-reference assets; only the application's own
   entry has none. RID-specific assets (`runtimes/win/lib/...`) are under `runtimeTargets`.

Plugin folders (manifest roots after the first) resolve from their own folder first, then the app folder.

## Version skew rules

- Requested version = the range's lower bound; a bare `10.0.0-13243` is its own lower bound. A floating range
  that the resolved version satisfies requests the resolved version (it picked the newest match), so a direct
  `[10.0.*-*, )` reference is never stale.
- Lag = resolved build − requested build, only when both share major.minor.patch and the build-number regex
  (default `-(?:[A-Za-z]+\.)?(\d+)$`) matches both. Otherwise the SemVer difference is shown (major → high,
  minor → medium, patch/prerelease → low).
- Internal = Project, Private, or Private (inferred). Unclassified packages count as public.
- Edges to `type: project` children are skipped: a project's version is not a package version.

Verified against `project.assets.json` written by .NET SDK 10.0.113 (NuGet 7.x) and the NuGet.ProjectModel
writer from 5.11 through 7.9:

1. `project.restore.restoreLockProperties.restorePackagesWithLockFile` is a string (`"true"`), and the whole
   object is written only when a lock property is set.
2. `centralPackageVersionsManagementEnabled`, `CentralPackageTransitivePinningEnabled` (capital C),
   `restoreLockedMode`, and per-dependency `versionCentrallyManaged` / `autoReferenced` are written only when
   true. Absent therefore means unknown, not disabled.
3. An exact pin `[2.1.35]` is written as `[2.1.35, 2.1.35]`; floats as `[13.0.*, )` and `[4.*-*, )`;
   `projectFileDependencyGroups` writes `Newtonsoft.Json >= 13.0.*`.
4. `VersionOverride` writes the override into `version` plus `versionOverride`, without `versionCentrallyManaged`.
5. SDK 10 adds `project.frameworks[tfm].packagesToPrune` (272 entries for net10.0). Pruned Ids can appear in a
   parent's dependency list with no entry in `targets`; those edges are skipped.

## Assumptions about project.assets.json to verify against real files

1. `targets` keys are either short (`net8.0`) or long (`.NETCoreApp,Version=v8.0`), optionally followed
   by `/<rid>`. `projectFileDependencyGroups` keys use a form that normalizes to the same framework.
2. `projectFileDependencyGroups` entries look like `Id >= 1.2.3` or `Id >= 1.0.0 < 2.0.0` and list
   PackageReferences.
3. Project references come from `project.restore.frameworks[alias].projectReferences`. They are matched to
   `libraries[*].msbuildProject` after resolving that relative path against `project.restore.projectPath`.
4. A referenced project's library Id equals `project.restore.projectName` in that project's own assets
   file. Cross-file merging and the build order depend on this.
5. Each Id resolves to exactly one version per target, and versions are normalized (no `+metadata`, no
   trailing `.0` fourth part).
6. `targets[...].dependencies` values are NuGet range strings: a bare `1.2.3` means ≥ 1.2.3.
7. The global packages folder layout is `<id-lowercase>/<version-lowercase>/.nupkg.metadata`.
