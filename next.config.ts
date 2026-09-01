import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    "vuedev.yoyowu.uk",
  ],

  experimental: {
    serverActions: {
      allowedOrigins: [
        "vuedev.yoyowu.uk",
      ],
    },
  },
};

export default nextConfig;