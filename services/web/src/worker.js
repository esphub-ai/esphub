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
      /^\/(devices?|account|explorer)(\/|$)/.test(u.pathname) &&
      u.hostname !== "app.esphub.ai"
    ) {
      u.hostname = "app.esphub.ai";
      return Response.redirect(u, 302);
    }
    let res = await env.ASSETS.fetch(req);
    if (
      res.status === 404 &&
      req.method === "GET" &&
      !u.pathname.split("/").pop().includes(".")
    ) {
      res = await env.ASSETS.fetch(new URL("/index.html", u));
    }
    const out = new Response(res.body, res);
    out.headers.set("Referrer-Policy", "no-referrer");
    out.headers.set("X-Content-Type-Options", "nosniff");
    out.headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' https://clerk.esphub.ai https://challenges.cloudflare.com https://*.protect.clerk.com; frame-src 'self' https://challenges.cloudflare.com https://*.protect.clerk.com; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' https://clerk.esphub.ai https://api.esphub.ai https://*.protect.clerk.com:*; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    return out;
  },
};
