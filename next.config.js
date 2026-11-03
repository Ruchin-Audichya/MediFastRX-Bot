module.exports = {
  reactStrictMode: true,
  devIndicators: false,
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `http://127.0.0.1:${process.env.API_PORT || 3101}/api/:path*`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};
