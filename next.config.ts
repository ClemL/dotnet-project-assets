import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NextConfig } from 'next';

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version?: string };

// Stamped once per build and inlined into the bundle, so the static HTML and the client render the
// same string. Formatting a date at render time would differ by timezone and break hydration.
const buildTime = `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;

// Static export: the app is plain HTML/JS on Vercel's CDN, with no server functions.
const nextConfig: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  reactStrictMode: true,
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version ?? '0.0.0',
    NEXT_PUBLIC_BUILD_TIME: buildTime,
  },
};

export default nextConfig;
