import { application, boardPhotoOrigin, browserOrigins, issuer } from "../../../shared/identity.js";

const domains = new Set(browserOrigins.map((origin) => new URL(origin).hostname));
const appHost = new URL(application).hostname;
const csp = [
  "default-src 'self'",
  `script-src 'self' ${issuer} https://challenges.cloudflare.com https://*.protect.clerk.com`,
  "frame-src 'self' https://challenges.cloudflare.com https://*.protect.clerk.com",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  `connect-src 'self' ${issuer} https://*.protect.clerk.com:*`,
  `img-src 'self' ${boardPhotoOrigin} https://img.clerk.com`,
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");
export default {
  async fetch(req, env) {
    const u = new URL(req.url),
      local = ["localhost", "127.0.0.1"].includes(u.hostname);
    if (!local && !domains.has(u.hostname))
      return new Response("Unknown host", { status: 404 });
    if (u.pathname.startsWith("/backend/")) {
      u.pathname = u.pathname.slice(8);
      return env.API.fetch(new Request(u, req));
    }
    if (
      !local &&
      /^\/devices(\/|$)/.test(u.pathname) &&
      u.hostname !== appHost
    ) {
      u.hostname = appHost;
      return Response.redirect(u, 302);
    }
    if (u.pathname === "/" && u.hostname === appHost)
      return Response.redirect(new URL("/devices", u), 302);
    const appRoute =
      ["GET", "HEAD"].includes(req.method) &&
      (["/", "/devices", "/devices/"].includes(u.pathname) ||
        /^\/boards(?:\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*)?\/?$/.test(
          u.pathname,
        ) ||
        /^\/projects(?:\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})?\/?$/i.test(
          u.pathname,
        ));
    const res = await env.ASSETS.fetch(
      appRoute ? new Request(new URL("/ui/", u), req) : req,
    );
    const out = new Response(res.body, res);
    out.headers.set("Referrer-Policy", "no-referrer");
    out.headers.set("X-Content-Type-Options", "nosniff");
    out.headers.set("Content-Security-Policy", csp);
    return out;
  },
};
