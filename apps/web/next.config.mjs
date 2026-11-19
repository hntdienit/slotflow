/** The browser only talks to /api/*; Next forwards it to the Nest API, so there is no CORS to configure. */
const API_URL = globalThis.process?.env.API_URL ?? "http://localhost:3000";

/** @type {import('next').NextConfig} */
export default {
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_URL}/:path*` }];
  },
};
