import { createServer } from "node:http";

function toCamelCase(value) {
  if (Array.isArray(value)) return value.map(toCamelCase);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      const camelKey = key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
      out[camelKey] = toCamelCase(v);
    }
    return out;
  }
  return value;
}

/**
 * A deliberately small router: register(method, path, ...handlers), each
 * handler is `async (ctx) => void`. Handlers run in sequence (like Express
 * middleware); calling `ctx.json(status, body)` sends the response and stops
 * the chain. Supports path params (`/orders/:id`). This exists only because
 * npm's registry isn't reachable in this sandbox (no Express install possible);
 * the shape below is close enough to Express that swapping in real Express
 * later is a mechanical, low-risk change — see README.md.
 */
export function createApp() {
  const routes = []; // { method, segments, handlers }

  function route(method, pathPattern, ...handlers) {
    const segments = pathPattern.split("/").filter(Boolean);
    routes.push({ method, segments, handlers });
  }

  function matchRoute(method, urlPath) {
    const reqSegments = urlPath.split("/").filter(Boolean);
    for (const r of routes) {
      if (r.method !== method) continue;
      if (r.segments.length !== reqSegments.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < r.segments.length; i++) {
        const seg = r.segments[i];
        if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(reqSegments[i]);
        else if (seg !== reqSegments[i]) { ok = false; break; }
      }
      if (ok) return { route: r, params };
    }
    return null;
  }

  async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return {};
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    const sendJson = (status, payload) => {
      if (res.writableEnded) return;
      res.writeHead(status, {
        "Content-Type": "application/json",
        // Production would restrict this to the real app origins, not "*" —
        // fine here since every "client" in this sandbox is a curl command.
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify(toCamelCase(payload)));
    };

    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type,Authorization",
        });
        return res.end();
      }

      const match = matchRoute(req.method, url.pathname);
      if (!match) return sendJson(404, { error: "Not found" });

      const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await readJsonBody(req) : {};
      const ctx = {
        params: match.params,
        query: Object.fromEntries(url.searchParams),
        body,
        headers: req.headers,
        json: sendJson,
      };

      for (const handler of match.route.handlers) {
        await handler(ctx);
        if (res.writableEnded) break;
      }
      if (!res.writableEnded) sendJson(500, { error: "Route did not send a response" });
    } catch (err) {
      sendJson(500, { error: "Internal server error", detail: String(err?.message ?? err) });
    }
  });

  return {
    get: (p, ...h) => route("GET", p, ...h),
    post: (p, ...h) => route("POST", p, ...h),
    put: (p, ...h) => route("PUT", p, ...h),
    delete: (p, ...h) => route("DELETE", p, ...h),
    listen: (port, cb) => server.listen(port, cb),
    close: (cb) => server.close(cb),
  };
}
