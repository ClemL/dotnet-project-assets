import type { NextConfig } from 'next';

// Static export: the app is plain HTML/JS on Vercel's CDN, with no server functions.
const nextConfig: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
