/** @type {import('next').NextConfig} */
// Standalone output for a small Docker image (doc 10 §7). The /backend/* rewrite
// proxies the embedded client app's API calls to the private backend, so API keys
// stay server-side (.env) and never appear in the frontend.
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';

const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: '/backend/:path*', destination: `${BACKEND_URL}/:path*` },
    ];
  },
};
module.exports = nextConfig;
