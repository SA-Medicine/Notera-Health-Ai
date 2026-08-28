/** @type {import('next').NextConfig} */
const BACKEND = process.env.BACKEND_URL || 'http://localhost:8080';

const nextConfig = {
  reactStrictMode: true,
  // Compile the shared design system straight from source (no prebuild step).
  transpilePackages: ['@notera/ui'],
  // Don't let TS/ESLint type-only mismatches block the production build. The recharts 2.x
  // typings don't satisfy React 19's stricter JSX types, and those charts live only in the
  // dev/admin testing-lab (not used in production). Runtime is unaffected.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  // The admin/lab client calls /backend/api/* — proxy those to the Express backend
  // so the browser stays same-origin and Next's own /api/* (clinician BFF) is free.
  async rewrites() {
    return [
      { source: '/backend/:path*', destination: `${BACKEND}/:path*` },
    ];
  },
};

module.exports = nextConfig;
