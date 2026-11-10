import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  devIndicators: false,
  // Fixa a raiz neste projeto: um lockfile numa pasta acima faria o Next escolher a raiz errada.
  outputFileTracingRoot: __dirname,
}

export default nextConfig
