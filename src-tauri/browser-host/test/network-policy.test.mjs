import assert from "node:assert/strict";
import test from "node:test";
import { approvedOrigin, parseApprovedOrigins, requestPolicy, validateDestinationUrl, validateNavigationUrl, validateRequestNetwork } from "../network-policy.mjs";

const origins = parseApprovedOrigins("http://127.0.0.1:3000,https://staging.example.com");

test("approved origins accept only http/https origins without credentials", () => {
  assert.equal(approvedOrigin("https://staging.example.com"), "https://staging.example.com");
  assert.throws(() => approvedOrigin("file:///tmp/a"), /scheme_blocked/);
  assert.throws(() => approvedOrigin("https://user:pass@example.com"), /credential_url_blocked/);
  assert.throws(() => approvedOrigin("https://example.com/path"), /origin_invalid/);
});

test("top-level navigation requires exact approved origin", () => {
  assert.equal(validateNavigationUrl("https://staging.example.com/page", origins).pathname, "/page");
  assert.throws(() => validateNavigationUrl("https://other.example.com", origins), /origin_approval_required/);
  assert.throws(() => validateNavigationUrl("javascript:alert(1)", origins), /scheme_blocked/);
});

test("passive cross-origin retrieval is bounded and mutation is blocked", () => {
  assert.equal(requestPolicy({ url: "https://cdn.example.com/app.js", method: "GET", documentOrigin: "https://staging.example.com", approvedOrigins: origins }).reason, "passive_subresource");
  assert.throws(() => requestPolicy({ url: "https://cdn.example.com/api", method: "POST", documentOrigin: "https://staging.example.com", approvedOrigins: origins }), /cross_origin_mutation_blocked/);
  assert.throws(() => requestPolicy({ url: "http://cdn.example.com/app.js", method: "GET", documentOrigin: "https://staging.example.com", approvedOrigins: origins }), /cross_origin_class_transition_blocked/);
});

test("DNS classification blocks privilege transitions and permits approved public HTTPS", async () => {
  const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
  const privateLookup = async () => [{ address: "192.168.1.4", family: 4 }];
  assert.equal((await validateDestinationUrl("https://staging.example.com", origins, publicLookup)).networkClass, "public");
  await assert.rejects(validateDestinationUrl("https://staging.example.com", origins, privateLookup), /destination_blocked:private/);
  const transitionLookup = async (hostname) => [{ address: hostname === "staging.example.com" ? "93.184.216.34" : "127.0.0.1", family: 4 }];
  await assert.rejects(validateRequestNetwork("http://127.0.0.1/resource", "https://staging.example.com", transitionLookup), /cross_origin_class_transition_blocked/);
});
