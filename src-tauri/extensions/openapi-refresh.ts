import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { serverUrl, type Contract } from "./openapi-catalog";

const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const digest = (document: unknown) =>
  createHash("sha256").update(JSON.stringify(document)).digest("hex");

function documentUrl(target: string, base?: string) {
  const url = new URL(target, base);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("document_url_blocked");
  return url;
}

async function download(target: string, signal?: AbortSignal) {
  let url = documentUrl(target);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url, {
      redirect: "manual",
      cache: "no-store",
      headers: { "cache-control": "no-cache", pragma: "no-cache" },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("document_redirect_missing_location");
      url = documentUrl(location, url.href);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`document_http_${response.status}`);
    }
    if (Number(response.headers.get("content-length")) > MAX_DOCUMENT_BYTES) {
      await response.body?.cancel();
      throw new Error("document_exceeds_8_MB");
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader) {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_DOCUMENT_BYTES)
            throw new Error("document_exceeds_8_MB");
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
    }
    return { url: url.href, text: Buffer.concat(chunks).toString("utf8") };
  }
  throw new Error("document_too_many_redirects");
}

function literals(source: string, key: string) {
  // Read literal configuration only; never execute downloaded JavaScript.
  const expression = new RegExp(
    `(?:^|[\\s{,])['"]?${key}['"]?\\s*:\\s*(['"])([^'"\\r\\n]+)\\1`,
    "gm",
  );
  return [...source.replace(/^\s*\/\/.*$/gm, "").matchAll(expression)].map(
    (match) => match[2],
  );
}

async function loadSource(source: string, signal?: AbortSignal) {
  const root = await download(source, signal);
  const parsed = (() => {
    try {
      return JSON.parse(root.text);
    } catch {
      return undefined;
    }
  })();
  if (
    parsed?.paths &&
    typeof parsed.paths === "object" &&
    !Array.isArray(parsed.paths)
  )
    return [{ source_url: root.url, document: parsed }];
  let config = parsed;
  let base = root.url;
  if (!config) {
    const query = new URL(root.url).searchParams;
    let script = root.text;
    const explicitConfig =
      query.get("configUrl") || literals(script, "configUrl")[0];
    const explicitDocument = query.get("url");
    if (explicitDocument) config = { url: explicitDocument };
    else if (explicitConfig) {
      const downloaded = await download(
        documentUrl(explicitConfig, root.url).href,
        signal,
      );
      config = JSON.parse(downloaded.text);
      base = downloaded.url;
    } else {
      if (!literals(script, "url").length) {
        const initializer =
          root.text.match(
            /<script\b[^>]*\bsrc\s*=\s*['"]([^'"]*(?:swagger-initializer|swagger-ui-init)\.js[^'"]*)['"]/i,
          )?.[1] || "swagger-initializer.js";
        const downloaded = await download(
          documentUrl(initializer, root.url).href,
          signal,
        );
        script = downloaded.text;
        base = downloaded.url;
      }
      const configUrl = literals(script, "configUrl")[0];
      if (configUrl) {
        const downloaded = await download(
          documentUrl(configUrl, base).href,
          signal,
        );
        config = JSON.parse(downloaded.text);
        base = downloaded.url;
      } else config = { urls: literals(script, "url").map((url) => ({ url })) };
    }
  }
  const targets = [
    ...new Set(
      [
        ...(Array.isArray(config?.urls)
          ? config.urls.map((entry: any) => entry?.url)
          : []),
        config?.url,
      ].filter(
        (value): value is string => typeof value === "string" && !!value,
      ),
    ),
  ];
  if (!targets.length) throw new Error("swagger_document_url_not_found");
  if (targets.length > 100) throw new Error("swagger_document_limit_exceeded");
  const documents: Array<{ source_url: string; document: any }> = [];
  for (const target of targets) {
    const downloaded = await download(documentUrl(target, base).href, signal);
    const document = JSON.parse(downloaded.text);
    if (
      !document.paths ||
      typeof document.paths !== "object" ||
      Array.isArray(document.paths)
    )
      throw new Error("document_paths_unavailable");
    documents.push({ source_url: downloaded.url, document });
  }
  return documents;
}

export async function saveContracts(path: string, contracts: Contract[]) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(contracts), { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function refreshContracts(
  previous: Contract[],
  input: { contractId?: string },
  signal?: AbortSignal,
) {
  const requested = input.contractId
    ? previous.filter((contract) => contract.id === input.contractId)
    : previous;
  if (!requested.length) throw new Error("contract_not_found");
  const source = (contract: Contract) =>
    contract.configured_source || contract.source_url;
  const roots = new Set(requested.map(source));
  const refreshed = previous.filter((contract) => !roots.has(source(contract)));
  for (const configured of roots) {
    const old = previous.filter((contract) => source(contract) === configured);
    const checked_at = Date.now();
    try {
      if (!configured)
        throw new Error(
          "saved_source_url_unavailable; refresh project API settings",
        );
      const documents = await loadSource(configured, signal);
      for (const [index, { document, source_url }] of documents.entries()) {
        const existing =
          old.find((contract) => contract.source_url === source_url) ||
          (old.length === 1 &&
          (documents.length === 1 ||
            (index === 0 && old[0].source_url === configured))
            ? old[0]
            : undefined);
        const content_hash = digest(document);
        const contract: Contract = {
          id: existing?.id || `api-${digest(source_url).slice(0, 16)}`,
          origin: "",
          base_url: "",
          document,
          source_url,
          configured_source: configured,
          fetched_at: checked_at,
          checked_at,
          content_hash,
          refresh_status:
            existing && digest(existing.document) === content_hash
              ? "unchanged"
              : "updated",
          stale: false,
          load_error: null,
        };
        try {
          contract.base_url = serverUrl(document, source_url);
          contract.origin = new URL(contract.base_url).origin;
        } catch (error) {
          contract.load_error = `API server unavailable: ${String(error)}`;
        }
        refreshed.push(contract);
      }
    } catch (error) {
      refreshed.push(
        ...old.map((contract) => ({
          ...contract,
          stale: true,
          load_error: String(error),
          checked_at,
          refresh_status: "failed" as const,
        })),
      );
    }
  }
  return refreshed;
}
