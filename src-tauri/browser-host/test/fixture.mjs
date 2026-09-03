import { createServer } from "node:http";

export function fixture() {
  const server = createServer((request, response) => {
    if (request.url === "/slow")
      return setTimeout(() => response.end("slow"), 5_000);
    if (request.url === "/submit" && request.method === "POST") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      return response.end("<!doctype html><p>Submitted safely</p>");
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      `<!doctype html><title>Browser host spike</title><main><h1>Ready</h1><form action="/submit" method="post"><label>Name <input aria-label="Name" value="Ada"></label><label>Email <input placeholder="work@example.com"></label><label>Password <input type="password" value="never-visible"></label><label>OTP <input autocomplete="one-time-code"></label><label>Card number <input autocomplete="cc-number"></label><label>Passkey <input name="webauthn-passkey"></label><input aria-label="API token" value="secret-token"><button type="submit">Verify</button></form><button disabled>Disabled action</button><button class="duplicate">Duplicate</button><button class="duplicate">Duplicate</button><p>Visible proof text</p><div id="late" hidden>Late proof</div><script>console.error("fixture-console-proof"); fetch("/evidence", {headers:{"x-kern-request-id":"evidence-1"}}); setTimeout(()=>document.querySelector("#late").hidden=false,150)</script></main>`,
    );
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      }),
    ),
  );
}
