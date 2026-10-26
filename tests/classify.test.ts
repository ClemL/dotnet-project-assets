import { describe, expect, it } from 'vitest';
import { classifyAndOrder } from '../lib/analyze';
import { classifyAll, DEFAULT_SETTINGS, matchPrefix } from '../lib/classify';
import { parseSourceMap } from '../lib/metadata';
import type { ClassifyInput, ClassifySettings, NugetLookup, Origin, SourceMap } from '../lib/types';
import { analyzeFixtures, fixtureText } from './helpers';

const FEED = 'https://pkgs.dev.azure.com/inscriptrx/_packaging/acme/nuget/v3/index.json';
const NUGET = 'https://api.nuget.org/v3/index.json';

function classify(
  fixtures: string[],
  settings: Partial<ClassifySettings>,
  extra: { lookups?: Record<string, NugetLookup>; metadata?: SourceMap; overrides?: Record<string, Origin> } = {},
) {
  const a = analyzeFixtures(...fixtures);
  const input: ClassifyInput = {
    packages: a.packages,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    lookups: extra.lookups ?? {},
    metadata: extra.metadata ?? {},
    overrides: extra.overrides ?? {},
  };
  return classifyAll(input);
}

const originsOf = (out: ReturnType<typeof classifyAll>) => Object.fromEntries(Object.entries(out.byId).map(([k, v]) => [k, v.origin]));

describe('offline classification', () => {
  it('uses prefix rules only and leaves unknown packages Unclassified', () => {
    const out = classify(['acme-web.assets.json'], { offline: true, internalPrefixes: ['Acme.'] });
    expect(originsOf(out)).toEqual({
      'acme.core': 'Private',
      'acme.data': 'Project',
      'acme.logging': 'Private',
      'acme.web': 'Project',
      'contoso.plugin': 'Unclassified',
      'microsoft.entityframeworkcore': 'System',
      'microsoft.extensions.logging': 'System',
      'newtonsoft.json': 'Unclassified',
    });
    expect(out.byPackage['newtonsoft.json/13.0.1']).toEqual({ origin: 'Unclassified', code: 'offline', reason: 'offline mode: no prefix rule matched' });
    expect(out.byPackage['acme.core/1.0.0']?.reason).toBe('internal prefix: Acme.');
    expect(out.byPackage['microsoft.extensions.logging/8.0.0']?.reason).toBe('system prefix: Microsoft.');
    expect(out.lookupCandidates).toEqual(['contoso.plugin', 'newtonsoft.json']);
  });

  it('without internal prefixes, internal packages are Unclassified too', () => {
    const out = classify(['acme-web.assets.json'], { offline: true });
    expect(out.byId['acme.core']?.origin).toBe('Unclassified');
  });

  it('matches the longest prefix, case-insensitively', () => {
    expect(matchPrefix('Microsoft.NETCore.App', DEFAULT_SETTINGS.systemPrefixes)).toBe('Microsoft.NETCore.');
    expect(matchPrefix('system.memory', DEFAULT_SETTINGS.systemPrefixes)).toBe('System.');
    expect(matchPrefix('SystemX', DEFAULT_SETTINGS.systemPrefixes)).toBeUndefined();
  });
});

describe('nuget.org lookups', () => {
  it('maps listed / unlisted / 404 / error results', () => {
    const base = { offline: false, internalPrefixes: ['Acme.'] };
    const listed = classify(['acme-web.assets.json'], base, {
      lookups: {
        'contoso.plugin': { status: 'found', versions: ['1.0.0', '2.0.0'], fetchedAt: 0 },
        'newtonsoft.json': { status: 'found', versions: ['13.0.1', '13.0.3'], fetchedAt: 0 },
      },
    });
    expect(listed.byId['contoso.plugin']?.origin).toBe('Public');
    expect(listed.byId['newtonsoft.json']?.origin).toBe('Public');

    const other = classify(['acme-web.assets.json'], base, {
      lookups: {
        'contoso.plugin': { status: 'found', versions: ['1.0.0'], fetchedAt: 0 },
        'newtonsoft.json': { status: 'error', message: 'HTTP 503' },
      },
    });
    expect(other.byPackage['contoso.plugin/2.0.0']).toMatchObject({ origin: 'PrivateInferred', code: 'nuget-unlisted-version' });
    expect(other.byPackage['newtonsoft.json/13.0.1']).toMatchObject({ origin: 'Unclassified', code: 'nuget-error' });

    const missing = classify(['acme-web.assets.json'], base, { lookups: { 'contoso.plugin': { status: 'notFound', fetchedAt: 0 } } });
    expect(missing.byPackage['contoso.plugin/2.0.0']).toMatchObject({ origin: 'PrivateInferred', code: 'nuget-not-found' });
    expect(missing.byPackage['newtonsoft.json/13.0.1']).toMatchObject({ origin: 'Unclassified', code: 'nuget-pending' });
  });

  it('rolls up per Id and flags mixed versions', () => {
    const out = classify(['case-a.assets.json', 'case-b.assets.json'], {}, { lookups: { 'acme.utils': { status: 'found', versions: ['1.0.0'], fetchedAt: 0 } } });
    expect(out.byId['acme.utils']).toEqual({
      origin: 'PrivateInferred',
      mixed: true,
      reasons: ['1.0.0: nuget.org: 1.0.0 listed', '1.2.0: nuget.org: Id exists but 1.2.0 is not listed'],
    });
  });

  it('manual overrides beat every rule', () => {
    const out = classify(['acme-web.assets.json'], { offline: true }, { overrides: { 'contoso.plugin': 'Private', 'acme.data': 'Public' }, metadata: { 'contoso.plugin/2.0.0': NUGET } });
    expect(out.byPackage['contoso.plugin/2.0.0']).toEqual({ origin: 'Private', code: 'override', reason: 'manual override' });
    expect(out.byId['acme.data']?.origin).toBe('Public');
  });
});

describe('source metadata (step 0)', () => {
  const map = (() => {
    const r = parseSourceMap(fixtureText('metadata/source-map.json'));
    if (!r.ok) throw new Error(r.error);
    return r.map;
  })();

  it('classifies by source and reports coverage', () => {
    const out = classify(['acme-web.assets.json'], { offline: true, internalFeeds: [FEED] }, { metadata: map });
    expect(out.byPackage['acme.core/1.0.0']).toEqual({ origin: 'Private', code: 'metadata-internal-feed', reason: `metadata: ${FEED}` });
    expect(out.byPackage['newtonsoft.json/13.0.1']).toEqual({ origin: 'Public', code: 'metadata-public', reason: `metadata: ${NUGET}` });
    expect(out.byPackage['microsoft.extensions.logging/8.0.0']).toEqual({ origin: 'System', code: 'metadata-system', reason: `metadata: ${NUGET}; system prefix: Microsoft.` });
    // A local source falls through to the remaining rules.
    expect(out.byPackage['contoso.plugin/2.0.0']?.origin).toBe('Unclassified');
    expect(out.byPackage['contoso.plugin/2.0.0']?.reason).toMatch(/^metadata: C:\\Program Files.*\(local source\); offline mode/);
    expect(out.coverage).toEqual({ withMetadata: 5, total: 6 });
    expect(out.proxyWarning).toBeUndefined();
  });

  it('falls through for a feed that is not configured as internal', () => {
    const out = classify(['acme-web.assets.json'], { offline: true }, { metadata: { 'acme.core/1.0.0': FEED } });
    expect(out.byPackage['acme.core/1.0.0']).toMatchObject({ origin: 'Unclassified', reason: `metadata: ${FEED} (unconfigured feed); offline mode: no prefix rule matched` });
  });

  it('outranks the nuget.org lookup', () => {
    // nuget.org metadata on another public package rules out the proxy-feed case.
    const out = classify(['acme-web.assets.json'], { internalFeeds: [FEED] }, {
      metadata: { 'contoso.plugin/2.0.0': FEED, 'microsoft.extensions.logging/8.0.0': NUGET },
      lookups: { 'contoso.plugin': { status: 'found', versions: ['2.0.0'], fetchedAt: 0 } },
    });
    expect(out.byPackage['contoso.plugin/2.0.0']?.origin).toBe('Private');
    expect(out.lookupCandidates).not.toContain('contoso.plugin');
  });

  it('warns when every public-looking package reports the same internal feed, and ignores that feed', () => {
    const proxied: SourceMap = {
      'acme.core/1.0.0': FEED,
      'microsoft.extensions.logging/8.0.0': FEED,
      'microsoft.entityframeworkcore/8.0.0': FEED,
      'newtonsoft.json/13.0.1': FEED,
    };
    const lookups: Record<string, NugetLookup> = { 'newtonsoft.json': { status: 'found', versions: ['13.0.1'], fetchedAt: 0 } };
    const out = classify(['acme-web.assets.json'], { internalFeeds: [FEED], internalPrefixes: ['Acme.'] }, { metadata: proxied, lookups });
    expect(out.proxyWarning).toEqual({ feed: FEED, publicLookingCount: 3, ignored: true });
    expect(out.byPackage['microsoft.extensions.logging/8.0.0']).toMatchObject({ origin: 'System', code: 'system-prefix' });
    expect(out.byPackage['microsoft.extensions.logging/8.0.0']?.reason).toContain('(ignored: feed proxies nuget.org)');
    expect(out.byPackage['newtonsoft.json/13.0.1']?.origin).toBe('Public');
    expect(out.byPackage['acme.core/1.0.0']).toMatchObject({ origin: 'Private', code: 'internal-prefix' });

    const trusted = classify(['acme-web.assets.json'], { internalFeeds: [FEED], trustProxyFeedMetadata: true }, { metadata: proxied, lookups });
    expect(trusted.proxyWarning).toEqual({ feed: FEED, publicLookingCount: 3, ignored: false });
    expect(trusted.byPackage['microsoft.extensions.logging/8.0.0']?.origin).toBe('Private');
  });

  it('does not warn once any public-looking package reports nuget.org', () => {
    const out = classify(['acme-web.assets.json'], { internalFeeds: [FEED] }, {
      metadata: { 'microsoft.extensions.logging/8.0.0': FEED, 'microsoft.entityframeworkcore/8.0.0': NUGET },
    });
    expect(out.proxyWarning).toBeUndefined();
  });
});

describe('suggestions and build order integration', () => {
  it('suggests internal prefixes from project names and feeds from restore sources', () => {
    const a = analyzeFixtures('acme-web.assets.json');
    expect(a.suggestions.internalPrefixes).toEqual([{ prefix: 'Acme.', count: 2, examples: ['Acme.Data', 'Acme.Web'] }]);
    expect(a.suggestions.internalFeeds).toEqual([FEED]);
  });

  it('treats inferred-private packages as internal in the build order', () => {
    const a = analyzeFixtures('acme-web.assets.json');
    const { buildOrders } = classifyAndOrder(
      a,
      { settings: { ...DEFAULT_SETTINGS, internalPrefixes: ['Acme.'] }, lookups: { 'contoso.plugin': { status: 'notFound', fetchedAt: 0 } }, metadata: {}, overrides: {} },
      { includeProjects: true },
    );
    const view = buildOrders.merged;
    expect(view?.graph.nodes).toContain('contoso.plugin');
    expect(view?.graph.edges.find((e) => e.from === 'acme.web' && e.to === 'acme.core')).toBeUndefined();
    expect(view?.order.ok && view.order.waves).toEqual([['acme.core', 'acme.logging'], ['acme.data', 'contoso.plugin'], ['acme.web']]);
  });
});
