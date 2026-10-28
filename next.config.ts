import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'export',
  allowedDevOrigins: [
    "vuedev.yoyowu.uk",
  ],
};

export default nextConfig;
