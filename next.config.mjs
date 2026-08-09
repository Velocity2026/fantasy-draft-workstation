/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Single-user private app: skip lint/type gating during `next build` so a
  // draft-day build never fails on a cosmetic issue. `npm run typecheck` still exists.
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  serverExternalPackages: ['@prisma/client', 'prisma'],
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'sleepercdn.com' },
    ],
  },
};

export default nextConfig;
