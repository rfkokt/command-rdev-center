import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { classifyAddress, createEnforcingProxy, resolveDestination } from "../proxy.mjs";

const token = "a".repeat(64);
const auth = `Basic ${Buffer.from(`Bearer:${token}`).toString("base64")}`;
const request = (proxy, url, headers = {}) => new Promise((resolve, reject) => {
  const target = new URL(proxy);
  const call = http.request({ hostname: target.hostname, port: target.port, path: url, headers }, (response) => {
    response.resume();
    response.on("end", () => resolve(response.statusCode));
  });
  call.on("error", reject);
  call.end();
});

async function fixture() {
  const server = http.createServer((req, res) => req.url === "/redirect" ? (res.writeHead(302, { location: "http://169.254.169.254/latest" }), res.end()) : res.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("central address classification denies privileged ranges and mapped private", () => {
  for (const address of ["10.0.0.1", "172.16.0.1", "192.168.1.1", "fd00::1"]) assert.equal(classifyAddress(address), "private");
  assert.equal(classifyAddress("169.254.169.254"), "metadata");
  assert.equal(classifyAddress("fe80::1"), "link-local");
  assert.equal(classifyAddress("::ffff:192.168.1.1"), "mapped-private");
  assert.equal(classifyAddress("127.0.0.1"), "loopback");
  for (const address of ["192.0.2.1", "198.51.100.1", "203.0.113.1", "240.0.0.1", "2001:db8::1"]) assert.equal(classifyAddress(address), "reserved");
  assert.equal(classifyAddress("93.184.216.34"), "public");
});

test("mixed DNS answers fail closed", async () => {
  await assert.rejects(resolveDestination("mixed.test", async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }]), /dns_mixed_class/);
});

test("authenticated proxy allows loopback and blocks unauthorized, LAN, metadata and credentials before connect", async (t) => {
  const app = await fixture();
  const connections = [];
  const proxy = createEnforcingProxy({ token, connect: (options) => { connections.push(options); return net.connect(options); } });
  const url = await proxy.listen();
  t.after(async () => { await proxy.close(); await app.close(); });
  assert.equal(await request(url, `${app.url}/`, { "proxy-authorization": auth }), 200);
  assert.equal(await request(url, `${app.url}/`, {}), 407);
  assert.equal(await request(url, "http://192.168.1.1/", { "proxy-authorization": auth }), 403);
  assert.equal(await request(url, "http://169.254.169.254/latest", { "proxy-authorization": auth }), 403);
  assert.equal(await request(url, "http://user:pass@127.0.0.1/", { "proxy-authorization": auth }), 403);
  assert.equal(connections.length, 0, "denied HTTP destinations never opened a CONNECT socket");
});

test("redirect target is revalidated on its next proxied request", async (t) => {
  const app = await fixture();
  const proxy = createEnforcingProxy({ token });
  const url = await proxy.listen();
  t.after(async () => { await proxy.close(); await app.close(); });
  assert.equal(await request(url, `${app.url}/redirect`, { "proxy-authorization": auth }), 302);
  assert.equal(await request(url, "http://169.254.169.254/latest", { "proxy-authorization": auth }), 403);
  assert.equal(proxy.events.at(-1).code, "destination_blocked:metadata");
});
