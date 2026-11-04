const http = require("http");
const https = require("https");

const PORT = 20129;
const UPSTREAM = "http://127.0.0.1:20128";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Max-Age", "86400");
}

const server = http.createServer((req, res) => {
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const target = new URL(UPSTREAM + req.url);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.toLowerCase() === "host") continue;
    headers[k] = v;
  }

  const proxy = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: req.method,
      headers,
    },
    (pres) => {
      res.writeHead(pres.statusCode, pres.headers);
      pres.pipe(res);
    }
  );

  proxy.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "proxy upstream error: " + e.message } }));
  });

  req.pipe(proxy);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[cors-proxy] listening on http://127.0.0.1:${PORT} -> ${UPSTREAM}`);
});
