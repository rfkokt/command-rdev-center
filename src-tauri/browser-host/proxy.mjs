import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import { isIP } from "node:net";

const METADATA = new Set(["169.254.169.254", "fd00:ec2::254"]);

function ipv4Class(value) {
  const bytes = value.split(".").map(Number);
  if (bytes.length !== 4 || bytes.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return "invalid";
  const [a, b, c] = bytes;
  if (value === "169.254.169.254") return "metadata";
  if (a === 127) return "loopback";
  if (a === 0) return "unspecified";
  if (a === 169 && b === 254) return "link-local";
  if (a >= 224 && a <= 239) return "multicast";
  if (a === 10 || (a === 100 && b >= 64 && b <= 127) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
  if ((a === 192 && b === 0 && [0, 2].includes(c)) || (a === 192 && b === 88 && c === 99) || (a === 198 && [18, 19].includes(b)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || a >= 240) return "reserved";
  return "public";
}

export function classifyAddress(address) {
  const value = address.toLowerCase().split("%")[0];
  if (isIP(value) === 4) return ipv4Class(value);
  if (METADATA.has(value)) return "metadata";
  if (value === "::1") return "loopback";
  if (value === "::") return "unspecified";
  if (/^fe[89ab]/.test(value)) return "link-local";
  if (value.startsWith("ff")) return "multicast";
  if (/^(fc|fd)/.test(value)) return "private";
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return classifyAddress(mapped[1]) === "public" ? "public" : "mapped-private";
  if (/^(2001:db8|2001:10|2001:2|2001:0|100:)/.test(value)) return "reserved";
  return isIP(value) === 6 ? "public" : "invalid";
}

export async function resolveDestination(hostname, lookup = dns.lookup) {
  const records = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!records.length) throw new Error("dns_empty");
  const classes = new Set(records.map(({ address }) => classifyAddress(address)));
  if (classes.size !== 1) throw new Error("dns_mixed_class");
  return { records, networkClass: [...classes][0] };
}

function authorize(headers, token) {
  const value = headers["proxy-authorization"];
  return value === `Basic ${Buffer.from(`Bearer:${token}`).toString("base64")}` || value === `Bearer ${token}`;
}

function parseAuthority(authority) {
  const parsed = new URL(`http://${authority}`);
  return { hostname: parsed.hostname.replace(/^\[|\]$/g, ""), port: Number(parsed.port || 443) };
}

export function createEnforcingProxy({ token, allowLoopback = true, allowPublicHttps = false, lookup = dns.lookup, connect = net.connect } = {}) {
  if (!token || token.length < 32) throw new Error("proxy_token_required");
  const events = [];
  const validate = async (hostname, scheme, port) => {
    const { records, networkClass } = await resolveDestination(hostname, lookup);
    const allowed = (networkClass === "loopback" && allowLoopback)
      || (networkClass === "public" && allowPublicHttps && scheme === "https:" && port === 443);
    if (!allowed) throw new Error(`destination_blocked:${networkClass}`);
    return { address: records[0].address, family: records[0].family, networkClass };
  };
  const deny = (socket, status, code) => {
    events.push({ disposition: "blocked", code });
    const statusCode = Number.parseInt(status, 10);
    if (typeof socket.writeHead === "function") {
      socket.writeHead(statusCode, statusCode === 407 ? { "proxy-authenticate": "Basic realm=\"Kern Browser Host\"", connection: "close" } : { connection: "close" });
    } else {
      const challenge = statusCode === 407 ? "Proxy-Authenticate: Basic realm=\"Kern Browser Host\"\r\n" : "";
      socket.write?.(`HTTP/1.1 ${status}\r\n${challenge}Connection: close\r\n\r\n`);
    }
    socket.end();
  };
  const server = http.createServer(async (request, response) => {
    if (!authorize(request.headers, token)) return deny(response, "407 Proxy Authentication Required", "proxy_unauthorized");
    let target;
    try {
      target = new URL(request.url);
      if (target.username || target.password || target.protocol !== "http:") throw new Error("unsupported_or_credential_url");
      const destination = await validate(target.hostname, target.protocol, Number(target.port || 80));
      const headers = { ...request.headers, host: target.host };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      const upstream = http.request({ hostname: destination.address, family: destination.family, port: Number(target.port || 80), method: request.method, path: `${target.pathname}${target.search}`, headers }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.on("error", () => deny(response, "502 Bad Gateway", "upstream_failed"));
      request.pipe(upstream);
      events.push({ disposition: "allowed", networkClass: destination.networkClass, scheme: "http:" });
    } catch (error) { deny(response, "403 Forbidden", error.message); }
  });
  server.on("connect", async (request, client, head) => {
    if (!authorize(request.headers, token)) return deny(client, "407 Proxy Authentication Required", "proxy_unauthorized");
    try {
      const { hostname, port } = parseAuthority(request.url);
      const destination = await validate(hostname, "https:", port);
      const upstream = connect({ host: destination.address, family: destination.family, port });
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
      upstream.on("error", () => client.destroy());
      events.push({ disposition: "allowed", networkClass: destination.networkClass, scheme: "https:" });
    } catch (error) { deny(client, "403 Forbidden", error.message); }
  });
  return {
    events,
    url: undefined,
    async listen() { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); this.url = `http://127.0.0.1:${server.address().port}`; return this.url; },
    async close() { await new Promise((resolve) => server.close(resolve)); },
  };
}
