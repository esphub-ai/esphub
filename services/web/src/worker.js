const domains = new Set(["esphub.ai", "www.esphub.ai", "app.esphub.ai"]);
export default {
  async fetch(req, env) {
    const u = new URL(req.url),
      local = ["localhost", "127.0.0.1"].includes(u.hostname);
    if (!local && !domains.has(u.hostname))
      return new Response("Unknown host", { status: 404 });
    if (["/sign-in", "/sign-up"].includes(u.pathname)) {
      const url = new URL(u.pathname, "https://accounts.esphub.ai");
      url.searchParams.set("redirect_url", "https://app.esphub.ai/devices");
      return Response.redirect(url.href, 302);
    }
    if (u.pathname.startsWith("/backend/")) {
      u.pathname = u.pathname.slice(8);
      return env.API.fetch(new Request(u, req));
    }
    if (
      !local &&
      /^\/devices(\/|$)/.test(u.pathname) &&
      u.hostname !== "app.esphub.ai"
    ) {
      u.hostname = "app.esphub.ai";
      return Response.redirect(u, 302);
    }
    if (["/mcp", "/mcp/"].includes(u.pathname))
      return Response.redirect(new URL("/", u), 302);
    if (u.pathname === "/" && u.hostname === "app.esphub.ai")
      return Response.redirect(new URL("/devices", u), 302);
    if (u.pathname === "/home/" || u.pathname === "/home")
      return Response.redirect(new URL("/", u), 302);
    const appRoute =
      ["GET", "HEAD"].includes(req.method) &&
      ["/", "/devices", "/devices/"].includes(u.pathname);
    const res = await env.ASSETS.fetch(
      appRoute ? new Request(new URL("/ui/", u), req) : req,
    );
    const out = new Response(res.body, res);
    out.headers.set("Referrer-Policy", "no-referrer");
    out.headers.set("X-Content-Type-Options", "nosniff");
    out.headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' https://clerk.esphub.ai https://challenges.cloudflare.com https://*.protect.clerk.com; frame-src 'self' https://challenges.cloudflare.com https://*.protect.clerk.com; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' https://clerk.esphub.ai https://api.esphub.ai https://*.protect.clerk.com:*; img-src 'self' https://cdn.esphub.ai; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    return out;
  },
};
