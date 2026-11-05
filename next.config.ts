import type { NextConfig } from "next";

/**
 * Static export: the dashboard is plain HTML built from /data at build time, so it
 * deploys to GitHub Pages or Vercel Hobby with no server and no secrets.
 * NEXT_BASE_PATH is set by the Pages workflow when the site lives at /<repo>/.
 */
const basePath = process.env.NEXT_BASE_PATH || "";

const config: NextConfig = {
  output: "export",
  trailingSlash: true,
  basePath,
  images: { unoptimized: true },
};

export default config;
