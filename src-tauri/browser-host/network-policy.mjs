import { classifyAddress, resolveDestination } from "./proxy.mjs";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function parseApprovedOrigins(value = "") {
  return new Set(value.split(",").map((item) => item.trim()).filter(Boolean).map((item) => approvedOrigin(item)));
}

export function approvedOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("url_invalid"); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("scheme_blocked");
  if (url.username || url.password) throw new Error("credential_url_blocked");
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("origin_invalid");
  return url.origin;
}

export function validateNavigationUrl(value, approvedOrigins) {
  let url;
  try { url = new URL(value); } catch { throw new Error("url_invalid"); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("scheme_blocked");
  if (url.username || url.password) throw new Error("credential_url_blocked");
  if (!approvedOrigins.has(url.origin)) throw new Error("origin_approval_required");
  return url;
}

export function requestPolicy({ url: value, method, navigation, topLevel, documentOrigin, approvedOrigins }) {
  const url = validateUrl(value);
  if (navigation || topLevel) {
    if (!approvedOrigins.has(url.origin)) throw new Error("origin_approval_required");
    return { disposition: "allowed", reason: "approved_origin" };
  }
  if (approvedOrigins.has(url.origin)) return { disposition: "allowed", reason: "approved_origin" };
  if (!SAFE_METHODS.has(method.toUpperCase())) throw new Error("cross_origin_mutation_blocked");
  if (!documentOrigin) throw new Error("document_origin_missing");
  const document = validateUrl(documentOrigin);
  if (document.protocol !== url.protocol) throw new Error("cross_origin_class_transition_blocked");
  return { disposition: "allowed", reason: "passive_subresource" };
}

export async function validateDestinationUrl(value, approvedOrigins, lookup) {
  const url = validateNavigationUrl(value, approvedOrigins);
  return validateResolvedUrl(url, lookup);
}

export async function validateRequestNetwork(value, documentOrigin, lookup) {
  const target = await validateResolvedUrl(validateUrl(value), lookup);
  if (!documentOrigin) return target;
  const document = await validateResolvedUrl(validateUrl(documentOrigin), lookup);
  if (target.networkClass !== document.networkClass) throw new Error("cross_origin_class_transition_blocked");
  return target;
}

async function validateResolvedUrl(url, lookup) {
  const { networkClass } = await resolveDestination(url.hostname, lookup);
  const allowed = networkClass === "loopback" || (networkClass === "public" && url.protocol === "https:");
  if (!allowed) throw new Error(`destination_blocked:${networkClass}`);
  return { origin: url.origin, networkClass };
}

function validateUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("url_invalid"); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("scheme_blocked");
  if (url.username || url.password) throw new Error("credential_url_blocked");
  return url;
}

export { classifyAddress };
