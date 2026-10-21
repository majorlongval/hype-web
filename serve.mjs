import { createServer } from "node:http";
import { createReadStream, readdirSync, statSync } from "node:fs";
import { extname, join, normalize, relative, resolve } from "node:path";

const port = Number(process.env.PORT ?? 8080);
const webRoot = resolve("dist/web");
const discRoot = process.env.HYPE_DISC ? resolve(process.env.HYPE_DISC) : null;
const types = { ".html": "text/html", ".js": "text/javascript", ".map": "application/json", ".json": "application/json", ".wasm": "application/wasm" };

function manifest(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push([relative(dir, p).split("/").join("\\"), statSync(p).size]);
    }
  };
  walk(dir);
  return out;
}

function safeJoin(root, urlPath) {
  const p = normalize(join(root, decodeURIComponent(urlPath)));
  return p.startsWith(root) ? p : null;
}

createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let file;
  if (url.pathname.startsWith("/disc/")) {
    if (!discRoot) return res.writeHead(404).end("no disc configured (set HYPE_DISC)");
    if (url.pathname === "/disc/manifest.json") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(manifest(discRoot)));
    }
    file = safeJoin(discRoot, url.pathname.slice(6));
  } else file = safeJoin(webRoot, url.pathname === "/" ? "index.html" : url.pathname.slice(1));
  let st;
  try {
    st = file && statSync(file);
  } catch {}
  if (!st || !st.isFile()) return res.writeHead(404).end("not found");
  const headers = { "content-type": types[extname(file)] ?? "application/octet-stream", "accept-ranges": "bytes", "cache-control": "no-cache" };
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
  if (range) {
    const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, "content-length": st.size });
  createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}/${discRoot ? "?disc=http" : ""}`));
