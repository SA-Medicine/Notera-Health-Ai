/** @type {import('next').NextConfig} */
const BACKEND = process.env.BACKEND_URL || 'http://localhost:8080';

const nextConfig = {
  reactStrictMode: true,
  // Compile the shared design system straight from source (no prebuild step).
  transpilePackages: ['@notera/ui'],
  // The admin/lab client calls /backend/api/* — proxy those to the Express backend
  // so the browser stays same-origin and Next's own /api/* (clinician BFF) is free.
  async rewrites() {
    return [
      { source: '/backend/:path*', destination: `${BACKEND}/:path*` },
    ];
  },
};

module.exports = nextConfig;
