/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@rukwaride/shared"],
  output: "standalone", // slim Docker runtime (infra/docker-compose.prod.yml)
};

export default nextConfig;
