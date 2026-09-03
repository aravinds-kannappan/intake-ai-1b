/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    // mammoth ships a browser build; keep Node bits out of the client bundle.
    config.resolve.alias = {
      ...config.resolve.alias,
      mammoth: 'mammoth/mammoth.browser.js',
    };
    return config;
  },
};

export default nextConfig;
