import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { isPublicIp } from "./agent-reach-security";
import { refreshContracts, saveContracts } from "./openapi-refresh";
import {
  operations,
  searchOperations,
  selectOperation,
  operationDetail,
  operationBaseUrl,
  parameters,
  reference,
  requiredFields,
  type Contract,
  type Operation,
} from "./openapi-catalog";

const MAX_BODY = 100_000;
const API_AUTH_WORKFLOW = `## Direct API testing and authentication
For Swagger/backend API tests, start with api_find_operations(refresh:true), then call api_operation_detail and api_contract_test directly. To inspect or update the latest Swagger, always refresh the saved sources; report fetchedAt, contentHash, operation counts, refreshStatus, and persistence results. Never claim latest or saved data when a fetch or write failed. An unchanged hash is a successful live verification, not a failure to refresh. Browser login, a working browser host, workspace credentials, and access to the application's frontend are not prerequisites.
Never search .env files, browser cookies, or workspace files for a user's access token. Never ask the user to log in through the browser or generate a JWT. Call the API tool: it owns a private token dialog and retries authentication when needed. Set authenticated:true when the task explicitly requires a bearer token even if Swagger omits its security declaration. Set authenticated:false only for an intentional anonymous/unauthorized test; expectedStatus:401 prevents token prompting for that negative test.
When the user asks to enter, change, switch, or remove a token, call api_authenticate directly with action:set or action:clear. This tool works independently of operation resolution and does not send an API request. A saved token is reused by authenticated:true; use refreshAuthentication:true on a request to replace it before execution. Never claim there is no tool to reopen the dialog. If contract_required occurs, inspect its inventory and select contractId or origin; use api_find_operations with refresh:true to retry loading saved sources before asking the user to change project settings.
Cookie sessions: when the backend authenticates with a cookie (for example AUTH_TOKEN), call api_authenticate with mode:"cookie" and cookieName; the user enters the value in the private dialog. Requests on that origin then send only that cookie. Choose credentials explicitly with auth:"bearer", auth:"cookie" (optionally cookieName) or auth:"none"; Kern never sends a bearer token and a cookie together. Never put cookie or token values in tool arguments, headers or chat.
If the user cancels the token dialog, report authentication_required. If an authenticated request still fails, report the actual HTTP response. A browser_host_closing error does not block direct API testing. Use browser tools when the user explicitly requests UI/browser verification.`;
const tokens = new Map<string, string>();
const mutationOrigins = new Set<string>();
/** Credential the user last set per origin, used when a request does not pick one. */
const preferred = new Map<
  string,
  { mode: "bearer" | "cookie"; cookieName?: string }
>();
/** Values typed into the dialog but not stored yet (e.g. a failed attempt). */
const pendingSecrets = new Set<string>();
const authenticationKey = (origin: string, header: string, prefix: string) =>
  JSON.stringify([origin, header, prefix]);
const cookieKey = (origin: string, name: string) =>
  authenticationKey(origin, `cookie:${name}`, "");
export type AuthMode = "bearer" | "cookie" | "none";
/** How one request authenticates: exactly one credential, never two. */
export type AuthScheme = {
  kind: "bearer" | "header" | "cookie";
  authHeader: string;
  authPrefix: string;
  cookieName?: string;
};
const BEARER: AuthScheme = {
  kind: "bearer",
  authHeader: "authorization",
  authPrefix: "Bearer ",
};
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,200}$/;
// RFC 6265 cookie-octet: no whitespace, DQUOTE, comma, semicolon or backslash.
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]{1,8192}$/;

/** Remove every credential value and credential header from tool output. */
export function redact(text: string, secrets: Iterable<string>) {
  let out = text;
  for (const secret of [...secrets]
    .filter((value) => value.length >= 4)
    .sort((a, b) => b.length - a.length))
    out = out.split(secret).join("[REDACTED]");
  return out
    .replace(
      /(\b(?:authorization|cookie|set-cookie)\b\\?["']?\s*[:=]\s*\\?["']?)[^"'\\\r\n]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9\-._~+/]{8,}=*/g, "Bearer [REDACTED]");
}
const knownSecrets = () => [...tokens.values(), ...pendingSecrets];
const result = (data: unknown, isError = false) => {
  const text = redact(JSON.stringify(data) ?? "null", knownSecrets());
  return {
    content: [{ type: "text" as const, text }],
    details: JSON.parse(text),
    isError,
  };
};

function privateAddress(address: string) {
  return /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^(fc|fd)/i.test(address);
}
function apiUrl(path: string, baseUrl: string) {
  return new URL(path.replace(/^\/+/, ""), `${baseUrl.replace(/\/?$/, "/")}`);
}

function operationAuthentication(selected: Operation) {
  const document = selected.contract.document;
  const security = selected.operation.security ?? document.security ?? [];
  const anonymous =
    !security.length ||
    security.some((option: object) => !Object.keys(option).length);
  const schemes =
    document.components?.securitySchemes || document.securityDefinitions || {};
  const authentication = security
    .map((option: object) => {
      const names = Object.keys(option);
      if (names.length !== 1) return undefined;
      const scheme = reference(schemes[names[0]], document);
      if (
        scheme?.type === "oauth2" ||
        scheme?.type === "openIdConnect" ||
        (scheme?.type === "http" &&
          String(scheme.scheme).toLowerCase() === "bearer")
      )
        return BEARER;
      if (
        scheme?.type === "apiKey" &&
        scheme.in === "header" &&
        typeof scheme.name === "string"
      )
        return {
          kind: "header",
          authHeader: scheme.name.toLowerCase(),
          authPrefix: "",
        } as AuthScheme;
      if (
        scheme?.type === "apiKey" &&
        scheme.in === "cookie" &&
        typeof scheme.name === "string" &&
        COOKIE_NAME.test(scheme.name)
      )
        return {
          kind: "cookie",
          authHeader: "cookie",
          authPrefix: "",
          cookieName: scheme.name,
        } as AuthScheme;
      return undefined;
    })
    .find(Boolean) as AuthScheme | undefined;
  return { security, anonymous, authentication };
}

async function promptToken(
  ctx: any,
  origin: string,
  scheme: AuthScheme,
  replacing = false,
) {
  if (scheme.kind === "cookie") {
    const name = scheme.cookieName!;
    let value =
      (
        await ctx.ui.input(
          `${replacing ? "Replace API cookie" : "Backend API cookie"} · ${origin} · ${name}`,
          `Paste the ${name} cookie value only (kept in memory for this chat only)`,
        )
      )?.trim() || "";
    // Accept "Cookie: NAME=value" or "NAME=value" pastes; keep only the value.
    value = value.replace(/^cookie:\s*/i, "");
    if (value.startsWith(`${name}=`)) value = value.slice(name.length + 1);
    value = value.replace(/^"(.*)"$/, "$1");
    if (value) pendingSecrets.add(value);
    if (value && !COOKIE_VALUE.test(value)) return { token: "", invalid: true };
    return { token: value, invalid: false };
  }
  let token =
    (
      await ctx.ui.input(
        `${replacing ? "Replace API token" : "Backend API authentication"} · ${origin} · ${scheme.authHeader}`,
        scheme.authPrefix
          ? "Paste the token only (kept in memory for this chat only)"
          : `Paste the exact ${scheme.authHeader} header value, including its required prefix (kept in memory for this chat only)`,
      )
    )?.trim() || "";
  if (scheme.authPrefix === "Bearer ")
    token = token.replace(/^Bearer\s+/i, "").trim();
  if (token) pendingSecrets.add(token);
  return { token, invalid: false };
}

/**
 * The single credential a request uses: an explicit `auth` choice wins, then
 * the operation's documented scheme, then what the user last set for this
 * origin, then bearer. `none` (or authenticated:false) means anonymous.
 */
export function resolveScheme(
  origin: string,
  choice: { auth?: AuthMode; cookieName?: string },
  documented?: AuthScheme,
): AuthScheme | null | { error: string } {
  if (choice.auth === "none") return null;
  const remembered = preferred.get(origin);
  if (choice.auth === "cookie") {
    const name =
      choice.cookieName ||
      (documented?.kind === "cookie" ? documented.cookieName : undefined) ||
      remembered?.cookieName;
    if (!name) return { error: "cookie_name_required" };
    if (!COOKIE_NAME.test(name)) return { error: "cookie_name_invalid" };
    return {
      kind: "cookie",
      authHeader: "cookie",
      authPrefix: "",
      cookieName: name,
    };
  }
  if (choice.auth === "bearer") return BEARER;
  if (documented) return documented;
  if (remembered?.mode === "cookie" && remembered.cookieName)
    return {
      kind: "cookie",
      authHeader: "cookie",
      authPrefix: "",
      cookieName: remembered.cookieName,
    };
  return BEARER;
}
const schemeKey = (origin: string, scheme: AuthScheme) =>
  scheme.kind === "cookie"
    ? cookieKey(origin, scheme.cookieName!)
    : authenticationKey(origin, scheme.authHeader, scheme.authPrefix);

async function validateUrl(raw: string, allowedOrigin: string) {
  if (!allowedOrigin) throw new Error("api_origin_not_allowed");
  const url = apiUrl(raw, allowedOrigin);
  if (url.origin !== new URL(allowedOrigin).origin)
    throw new Error("api_origin_not_allowed");
  const localHost =
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    /^127\./.test(url.hostname) ||
    ["::1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && localHost)) ||
    url.username ||
    url.password
  )
    throw new Error("api_url_blocked");
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error("api_dns_empty");
  const classes = new Set(
    addresses.map(({ address }) =>
      isPublicIp(address)
        ? "public"
        : localHost && (/^127\./.test(address) || address === "::1")
          ? "loopback"
          : privateAddress(address)
            ? "private"
            : "blocked",
    ),
  );
  if (
    classes.size !== 1 ||
    classes.has("blocked") ||
    (localHost && !classes.has("loopback"))
  )
    throw new Error("api_destination_blocked");
  return url;
}

async function request(
  input: {
    method: string;
    path: string;
    body?: unknown;
    authenticated?: boolean;
    refreshAuthentication?: boolean;
    authenticateOnChallenge?: boolean;
    origin?: string;
    headers?: Record<string, string>;
    expectedStatus?: number;
    /** Credential to use; null = anonymous. Defaults to bearer. */
    scheme?: AuthScheme | null;
    contentType?: string;
  },
  signal: AbortSignal | undefined,
  ctx: any,
  onUpdate?: (update: ReturnType<typeof result>) => void,
) {
  if (
    input.refreshAuthentication &&
    (input.authenticated === false || input.expectedStatus === 401)
  )
    return result(
      {
        status: "blocked",
        code: "authentication_refresh_conflicts_with_anonymous_test",
      },
      true,
    );
  const update = (stage: string, activity: string, status?: number) =>
    onUpdate?.(
      result({
        activity,
        stage,
        method: input.method,
        path: apiUrl(input.path, input.origin || "").pathname,
        ...(status !== undefined && { httpStatus: status }),
      }),
    );
  update("destination", "Validating API destination");
  const url = await validateUrl(input.path, input.origin || "");
  const readOnly = ["GET", "HEAD", "OPTIONS"].includes(input.method);
  if (
    !readOnly &&
    !mutationOrigins.has(url.origin) &&
    !(await ctx.ui.confirm(
      "Allow API mutations for this chat?",
      `${input.method} ${url.pathname}${url.search}\nAllow subsequent POST, PUT, PATCH, and DELETE requests in this chat without asking again.`,
    ))
  )
    return result({ status: "blocked", code: "user_rejected" }, true);
  if (!readOnly) mutationOrigins.add(url.origin);
  const scheme = input.scheme === undefined ? BEARER : input.scheme;
  const tokenKey = scheme ? schemeKey(url.origin, scheme) : "";
  const shouldAuthenticate =
    !!scheme &&
    (input.refreshAuthentication ||
      (input.authenticated ?? input.expectedStatus !== 401));
  if (input.refreshAuthentication && tokenKey) tokens.delete(tokenKey);
  let authToken = shouldAuthenticate ? tokens.get(tokenKey) || "" : "";
  const ask = async (replacing: boolean) => {
    const answer = await promptToken(ctx, url.origin, scheme!, replacing);
    return answer;
  };
  if (shouldAuthenticate && !authToken) {
    update("authentication", "Waiting for private authentication");
    const answer = await ask(!!input.refreshAuthentication);
    if (answer.invalid)
      return result({ status: "blocked", code: "cookie_value_invalid" }, true);
    authToken = answer.token;
    if (!authToken)
      return result(
        { status: "blocked", code: "authentication_required" },
        true,
      );
  }
  if (authToken) tokens.set(tokenKey, authToken);
  const credentialHeader = (): Record<string, string> =>
    !authToken || !scheme
      ? {}
      : scheme.kind === "cookie"
        ? { cookie: `${scheme.cookieName}=${authToken}` }
        : { [scheme.authHeader]: `${scheme.authPrefix}${authToken}` };
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  const send = () =>
    fetch(url, {
      method: input.method,
      signal: requestSignal,
      // Never follow: a redirect could carry the credential to another origin.
      redirect: "manual",
      headers: {
        accept: "application/json, application/problem+json",
        "accept-language": "id",
        "kai-client-app": "APP_ROLINK",
        ...input.headers,
        ...(input.body !== undefined && {
          "content-type": input.contentType || "application/json",
        }),
        // Exactly one credential: a bearer token or a cookie, never both.
        ...credentialHeader(),
      },
      ...(input.body !== undefined && { body: JSON.stringify(input.body) }),
    });
  update("request", "Waiting for backend response");
  let response = await send();
  update("response", "Reading response body", response.status);
  let raw = await response.text();
  if (
    scheme &&
    (shouldAuthenticate || input.authenticateOnChallenge) &&
    input.expectedStatus !== response.status &&
    (response.status === 401 ||
      (response.status === 400 &&
        /"type"\s*:\s*"invalid_(?:token|request)"[\s\S]*Sesi telah berakhir/i.test(
          raw,
        )))
  ) {
    const tokenWasSent = !!authToken;
    if (tokenWasSent) tokens.delete(tokenKey);
    authToken = tokenWasSent ? "" : tokens.get(tokenKey) || "";
    if (!authToken) {
      update(
        "authentication",
        "API requires authentication · Waiting for a token",
      );
      const answer = await ask(tokenWasSent);
      if (answer.invalid)
        return result(
          { status: "blocked", code: "cookie_value_invalid" },
          true,
        );
      authToken = answer.token;
    }
    if (!authToken)
      return result(
        { status: "blocked", code: "authentication_required" },
        true,
      );
    tokens.set(tokenKey, authToken);
    update("retry", "Retrying request with fresh token");
    response = await send();
    update(
      "validation",
      "Validating response against contract",
      response.status,
    );
    raw = await response.text();
    if (response.status === 401) tokens.delete(tokenKey);
  }
  const location = response.headers.get("location");
  let redirect: string | undefined;
  if (response.status >= 300 && response.status < 400 && location) {
    try {
      const target = new URL(location, url);
      // Origin + path only: a query string may carry tokens.
      redirect = `${target.origin}${target.pathname}`;
    } catch {
      redirect = "[unparseable location]";
    }
  }
  update("validation", "Validating response against contract", response.status);
  const text = raw.slice(0, MAX_BODY);
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* bounded text */
  }
  return result(
    {
      status:
        response.ok || input.expectedStatus === response.status
          ? "ok"
          : "error",
      validationScope: "http_response_only",
      httpStatus: response.status,
      method: input.method,
      path: `${url.pathname}${url.search}`,
      traceId:
        response.headers.get("x-trace-id") ||
        response.headers.get("x-request-id"),
      body,
      truncated: raw.length > MAX_BODY,
      auth: scheme
        ? scheme.kind === "cookie"
          ? "cookie"
          : scheme.kind
        : "none",
      ...(scheme?.kind === "cookie" && { cookieName: scheme.cookieName }),
      ...(redirect && {
        redirect,
        redirectFollowed: false,
        guidance:
          "Redirects are not followed, so credentials never reach another URL. Request the target path directly if it is on this API origin.",
      }),
      ...(response.status === 401 &&
        input.expectedStatus !== 401 && {
          code: "authentication_failed",
          guidance:
            "The API returned 401. Use this tool's private token dialog with authenticated:true; browser login and workspace credential searches are not prerequisites.",
        }),
    },
    !response.ok && input.expectedStatus !== response.status,
  );
}

export default async function (pi: ExtensionAPI) {
  const contractsPath = process.env.CRC_API_CONTRACTS_PATH;
  if (!contractsPath) return;
  let contracts: Contract[] = JSON.parse(await readFile(contractsPath, "utf8"));
  if (!contracts.length) return;
  let apiOnlyTask = false;
  const reset = () => {
    tokens.clear();
    preferred.clear();
    pendingSecrets.clear();
    mutationOrigins.clear();
    apiOnlyTask = false;
  };
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("before_agent_start", (event) => {
    const prompt = event.prompt.trim();
    if (
      !/^(?:continue|lanjut(?:in|kan)?|retry|coba lagi|teruskan|go on|oke lanjut)[.!\s]*$/i.test(
        prompt,
      )
    ) {
      const scope = prompt.replace(
        /\b(?:jangan|tanpa|tidak perlu|ga(?:k)? perlu|don't|do not|without)\s+(?:(?:pakai|gunakan|use|buka|open)\s+)?(?:browser|ui|frontend)\b/gi,
        "",
      );
      const uiRequested =
        /\b(?:browser|frontend|front-end|ui|tampilan|halaman)\b/i.test(scope);
      apiOnlyTask =
        !uiRequested &&
        /\b(?:api|swagger|openapi|endpoint|jwt)\b/i.test(scope) &&
        /\b(?:test(?:ing)?|tes|uji|cek|check|verify|verifikasi|hit|call|panggil|token)\b/i.test(
          scope,
        );
    }
    return { systemPrompt: `${event.systemPrompt}\n\n${API_AUTH_WORKFLOW}` };
  });
  pi.on("tool_call", (event) => {
    if (
      apiOnlyTask &&
      event.toolName.startsWith("browser_") &&
      event.toolName !== "browser_close"
    )
      return {
        block: true,
        reason:
          "Direct API testing does not require browser login. Use api_find_operations, api_operation_detail, then api_contract_test. The API tool opens a private token dialog. Browser tools remain available when the user requests UI/browser verification.",
      };
  });
  const selector = {
    operationId: Type.Optional(Type.String({ maxLength: 300 })),
    method: Type.Optional(Type.String({ maxLength: 10 })),
    path: Type.Optional(Type.String({ maxLength: 2000 })),
    contractId: Type.Optional(Type.String({ maxLength: 300 })),
    origin: Type.Optional(Type.String({ maxLength: 2000 })),
  };
  const find = (input: any) => {
    const selection = selectOperation(contracts, input);
    if (selection.selected) return { selected: selection.selected };
    return {
      error: result(
        {
          status: "error",
          ...selection,
          inventory: searchOperations(contracts, {
            query: input.operationId || input.path,
            limit: 10,
          }),
          guidance:
            "This exact selector was not resolved. Search api_find_operations across all contracts, inspect candidates with api_operation_detail, and refresh before claiming absence. An unavailable contract is not a missing endpoint.",
        },
        true,
      ),
    };
  };
  pi.registerTool({
    name: "api_authenticate",
    label: "Set, replace, or clear API token",
    description:
      'Open the private dialog to set or replace a credential, or clear saved credentials for an API origin. mode:"bearer" (default) stores an Authorization bearer token; mode:"cookie" with cookieName (e.g. AUTH_TOKEN, or taken from a Swagger apiKey-in-cookie scheme) stores a session cookie that later requests on this origin send instead of a bearer token. action:"clear" removes all credentials for the origin, or only one mode. Works even when a saved Swagger source cannot load; does not execute an HTTP request. Select contractId or origin if multiple API origins exist. Never pass credential values in tool arguments or chat.',
    parameters: Type.Object({
      ...selector,
      action: Type.Union([Type.Literal("set"), Type.Literal("clear")]),
      mode: Type.Optional(
        Type.Union([Type.Literal("bearer"), Type.Literal("cookie")]),
      ),
      cookieName: Type.Optional(Type.String({ maxLength: 200 })),
    }),
    async execute(_id, input, _signal, _onUpdate, ctx) {
      try {
        const contract = contracts.find((item) => item.id === input.contractId);
        if (input.contractId && !contract)
          return result({ status: "error", code: "contract_not_found" }, true);
        let selected: Operation | undefined;
        if (input.operationId || input.method || input.path) {
          const selection = find(input);
          if (selection.error) return selection.error;
          selected = selection.selected;
        }
        const candidates = selected
          ? [selected.contract]
          : contract
            ? [contract]
            : contracts;
        // A failed contract still has a configured source origin. Collecting a
        // token there does not authorize HTTP execution against that source.
        const origins = new Set(
          selected
            ? [new URL(operationBaseUrl(selected)).origin]
            : candidates
                .map((item) => {
                  const target =
                    item.origin || item.base_url || item.source_url;
                  return target ? new URL(target).origin : "";
                })
                .filter(Boolean),
        );
        const origin = input.origin
          ? new URL(input.origin).origin
          : origins.size === 1
            ? [...origins][0]
            : "";
        if (!origin || !origins.has(origin))
          return result(
            {
              status: "blocked",
              code: "authentication_origin_required",
              origins: [...origins],
              inventory: searchOperations(contracts, { limit: 5 }),
              guidance:
                "Select a configured contractId or origin, then call api_authenticate again. A loaded operation is not required.",
            },
            true,
          );
        const url = new URL(origin);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.origin === "null"
        )
          return result({ status: "blocked", code: "api_url_blocked" }, true);
        if (input.action === "clear") {
          let cleared = 0;
          for (const key of [...tokens.keys()]) {
            const [keyOrigin, header] = JSON.parse(key);
            if (keyOrigin !== origin) continue;
            const isCookie = String(header).startsWith("cookie:");
            if (
              (input.mode === "cookie" && !isCookie) ||
              (input.mode === "bearer" && isCookie)
            )
              continue;
            tokens.delete(key);
            cleared++;
          }
          if (!input.mode || preferred.get(origin)?.mode === input.mode)
            preferred.delete(origin);
          return result({
            status: "ok",
            action: "clear",
            origin,
            mode: input.mode ?? "all",
            cleared,
          });
        }
        const auth = selected ? operationAuthentication(selected) : undefined;
        if (auth && !auth.anonymous && !auth.authentication)
          return result(
            {
              status: "blocked",
              code: "security_scheme_not_supported",
              security: auth.security,
            },
            true,
          );
        const scheme = resolveScheme(
          origin,
          { auth: input.mode, cookieName: input.cookieName },
          auth?.authentication,
        );
        if (!scheme)
          return result({ status: "blocked", code: "mode_required" }, true);
        if ("error" in scheme)
          return result(
            {
              status: "blocked",
              code: scheme.error,
              guidance:
                "Pass cookieName (for example AUTH_TOKEN). Swagger did not declare an apiKey cookie scheme for this origin.",
            },
            true,
          );
        const key = schemeKey(origin, scheme);
        const replacing = tokens.has(key);
        // Canceling replacement must not silently retain the previous identity.
        tokens.delete(key);
        const answer = await promptToken(ctx, origin, scheme, replacing);
        if (answer.invalid)
          return result(
            {
              status: "blocked",
              code: "cookie_value_invalid",
              guidance:
                "A cookie value cannot contain spaces, quotes, commas, semicolons or backslashes. Paste only the value.",
            },
            true,
          );
        if (!answer.token)
          return result(
            { status: "blocked", code: "authentication_required", origin },
            true,
          );
        tokens.set(key, answer.token);
        preferred.set(
          origin,
          scheme.kind === "cookie"
            ? { mode: "cookie", cookieName: scheme.cookieName }
            : { mode: "bearer" },
        );
        return result({
          status: "ok",
          action: "set",
          origin,
          mode: scheme.kind === "cookie" ? "cookie" : "bearer",
          ...(scheme.kind === "cookie"
            ? { cookieName: scheme.cookieName }
            : { authHeader: scheme.authHeader }),
          replaced: replacing,
        });
      } catch (error) {
        return result({ status: "error", code: String(error) }, true);
      }
    },
  });
  pi.registerTool({
    name: "api_find_operations",
    label: "Search all Swagger operations",
    description:
      "Search the complete saved Swagger/OpenAPI inventory by operation ID, path, summary, description, tags, or parameter names. Empty query lists all operations. Results are paginated; load failures and stale contracts are disclosed. Set refresh:true to fetch saved JSON/Swagger UI sources from the network with cache revalidation, update the full inventory, and persist it for this session and app restarts. Reports fetchedAt, checkedAt, contentHash, refreshStatus, and persistence results; unchanged means verified with identical content, failed retains stale data. Cached data alone does not prove it is latest. Refresh before concluding an endpoint is absent.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ maxLength: 500 })),
      contractId: selector.contractId,
      method: selector.method,
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      refresh: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, input, signal) {
      let refresh: unknown;
      if (input.refresh) {
        try {
          const sources = new Set(
            contracts
              .filter(
                (contract) =>
                  !input.contractId || contract.id === input.contractId,
              )
              .map(
                (contract) => contract.configured_source || contract.source_url,
              ),
          );
          contracts = await refreshContracts(contracts, input, signal);
          const persistence = { session: false, sharedCache: false };
          const cachePath = process.env.CRC_API_CONTRACT_CACHE_PATH;
          let persistenceError: string | undefined;
          if (cachePath) {
            try {
              await saveContracts(cachePath, contracts);
              persistence.sharedCache = true;
            } catch (error) {
              persistenceError = `shared_cache_write_failed: ${String(error)}`;
            }
          }
          if (persistenceError)
            contracts = contracts.map((contract) => ({
              ...contract,
              persistence_error: persistenceError,
            }));
          try {
            await saveContracts(contractsPath, contracts);
            persistence.session = true;
          } catch (error) {
            contracts = contracts.map((contract) => ({
              ...contract,
              persistence_error: [
                contract.persistence_error,
                `session_cache_write_failed: ${String(error)}`,
              ]
                .filter(Boolean)
                .join("; "),
            }));
          }
          const checked = contracts.filter((contract) =>
            sources.has(contract.configured_source || contract.source_url),
          );
          refresh = {
            checkedAt: Date.now(),
            updated: checked.filter(
              (contract) => contract.refresh_status === "updated",
            ).length,
            unchanged: checked.filter(
              (contract) => contract.refresh_status === "unchanged",
            ).length,
            failed: checked.filter(
              (contract) => contract.refresh_status === "failed",
            ).length,
            persisted: persistence,
          };
        } catch (error) {
          return result({ status: "error", code: String(error) }, true);
        }
      }
      return result({
        ...searchOperations(contracts, input),
        ...(refresh && { refresh }),
      });
    },
  });
  pi.registerTool({
    name: "api_operation_detail",
    label: "Read Swagger operation requirements",
    description:
      "Get the exact operation's inherited parameters, request body, response definitions, security, server overrides, and resolved local schema references. Resolve ambiguity with contractId and exact method/path before executing.",
    parameters: Type.Object(selector),
    async execute(_id, input) {
      try {
        const selected = find(input);
        return selected.error || result(operationDetail(selected.selected!));
      } catch (error) {
        return result({ status: "error", code: String(error) }, true);
      }
    },
  });
  pi.registerTool({
    name: "api_request",
    label: "Test backend API",
    description:
      "Send one HTTP request to a configured API origin. Prefer api_contract_test for documented operations; raw api_request can exercise deliberate invalid-input cases that contract preflight blocks. Select contractId when multiple API base URLs exist. Credentials are collected privately per origin; auth (bearer, cookie or none) picks exactly one (default: what the user last set for the origin, else bearer). Use refreshAuthentication:true to replace a cached credential before execution, or api_authenticate to manage credentials without a request. Redirects are reported, never followed. Mutations require confirmation. A successful response alone does not prove business behavior.",
    parameters: Type.Object({
      method: Type.Union(
        ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"].map(
          (method) => Type.Literal(method),
        ),
      ),
      path: Type.String({ minLength: 1, maxLength: 4000 }),
      body: Type.Optional(Type.Unknown()),
      authenticated: Type.Optional(Type.Boolean()),
      refreshAuthentication: Type.Optional(Type.Boolean()),
      auth: Type.Optional(
        Type.Union([
          Type.Literal("bearer"),
          Type.Literal("cookie"),
          Type.Literal("none"),
        ]),
      ),
      cookieName: Type.Optional(Type.String({ maxLength: 200 })),
      expectedStatus: Type.Optional(
        Type.Integer({ minimum: 100, maximum: 599 }),
      ),
      contractId: selector.contractId,
      origin: selector.origin,
    }),
    async execute(_id, input, signal, onUpdate, ctx) {
      try {
        const contract = contracts.find(
          (contract) => contract.id === input.contractId,
        );
        if (input.contractId && !contract)
          return result({ status: "error", code: "contract_not_found" }, true);
        const available = contracts.filter((contract) => contract.origin);
        const baseUrls = [
          ...new Set(available.map((item) => item.base_url || item.origin)),
        ];
        const origin =
          input.origin ||
          contract?.base_url ||
          contract?.origin ||
          (baseUrls.length === 1 ? baseUrls[0] : "");
        if (
          !origin ||
          !available.some(
            (contract) => contract.origin === new URL(origin).origin,
          )
        )
          return result(
            {
              status: "error",
              code: "contract_required",
              inventory: searchOperations(contracts, { limit: 5 }),
              guidance:
                "Select contractId or an available API origin from the inventory. If sources failed to load, call api_find_operations with refresh:true. To enter or replace a token independently, call api_authenticate; authentication does not require a loaded operation.",
            },
            true,
          );
        const scheme =
          input.authenticated === false
            ? null
            : resolveScheme(new URL(origin).origin, input);
        if (scheme && "error" in scheme)
          return result({ status: "blocked", code: scheme.error }, true);
        return await request(
          { ...input, origin, scheme },
          signal,
          ctx,
          onUpdate,
        );
      } catch (error) {
        return result({ status: "error", code: String(error) }, true);
      }
    },
  });
  pi.registerTool({
    name: "api_contract_test",
    label: "Test Swagger operation",
    description:
      "Execute one exact saved Swagger/OpenAPI operation after api_operation_detail. Call directly; no browser login or workspace token search is needed. Credentials are collected in a private token dialog. If Swagger omits security, an unexpected 401 opens the dialog and retries once. Use authenticated:true to request a credential up front, auth cookie (with cookieName unless Swagger declares an apiKey cookie) or auth bearer to choose exactly one credential, auth none or authenticated:false for an intentional anonymous test, refreshAuthentication:true to replace a cached credential. Use api_authenticate to manage tokens without executing an operation. Checks required parameters, top-level body fields, and documented HTTP status; full response schemas and business rules need separate assertions. Supply explicit expectedStatus for a negative test.",
    parameters: Type.Object({
      ...selector,
      pathParams: Type.Optional(Type.Record(Type.String(), Type.String())),
      query: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      headers: Type.Optional(Type.Record(Type.String(), Type.String())),
      body: Type.Optional(Type.Unknown()),
      authenticated: Type.Optional(Type.Boolean()),
      refreshAuthentication: Type.Optional(Type.Boolean()),
      auth: Type.Optional(
        Type.Union([
          Type.Literal("bearer"),
          Type.Literal("cookie"),
          Type.Literal("none"),
        ]),
      ),
      cookieName: Type.Optional(Type.String({ maxLength: 200 })),
      expectedStatus: Type.Optional(
        Type.Integer({ minimum: 100, maximum: 599 }),
      ),
      serverIndex: Type.Optional(Type.Integer({ minimum: 0, maximum: 50 })),
    }),
    async execute(_id, input, signal, onUpdate, ctx) {
      try {
        onUpdate?.(
          result({
            activity: "Resolving operation from all Swagger contracts",
            stage: "contract",
            operationId: input.operationId,
            method: input.method,
            path: input.path,
          }),
        );
        const selection = find(input);
        if (selection.error) return selection.error;
        const selected = selection.selected!,
          document = selected.contract.document;
        const params = parameters(selected);
        const missingPath = [...selected.path.matchAll(/\{([^}]+)\}/g)]
          .map((match) => match[1])
          .filter((name) => !input.pathParams?.[name]);
        if (missingPath.length)
          return result(
            {
              status: "error",
              code: "path_parameter_required",
              missing: missingPath,
              operation: operationDetail(selected),
            },
            true,
          );
        if (
          Object.values(input.pathParams || {}).some(
            (value) => value === "." || value === "..",
          )
        )
          return result(
            { status: "error", code: "path_parameter_invalid" },
            true,
          );
        const missing = params
          .filter(
            (parameter) =>
              parameter.required &&
              (parameter.in === "query"
                ? input.query?.[parameter.name] == null
                : parameter.in === "header"
                  ? !Object.keys(input.headers || {}).some(
                      (key) =>
                        key.toLowerCase() === parameter.name.toLowerCase(),
                    )
                  : parameter.in === "path"
                    ? !input.pathParams?.[parameter.name]
                    : parameter.in === "body"
                      ? input.body === undefined
                      : false),
          )
          .map((parameter) => ({ in: parameter.in, name: parameter.name }));
        if (missing.length)
          return result(
            { status: "error", code: "required_parameters_missing", missing },
            true,
          );
        if (
          Object.keys(input.headers || {}).some((name) =>
            /^(authorization|cookie)$/i.test(name),
          )
        )
          return result(
            { status: "blocked", code: "use_private_authentication_dialog" },
            true,
          );
        const requestBody = reference(selected.operation.requestBody, document);
        if (requestBody?.required && input.body === undefined)
          return result(
            { status: "error", code: "request_body_required" },
            true,
          );
        const bodyParameter = params.find(
          (parameter) => parameter.in === "body",
        );
        const content = requestBody?.content || {};
        const jsonMedia = Object.keys(content).find(
          (type) => type === "application/json" || type.endsWith("+json"),
        );
        const consumes = selected.operation.consumes || document.consumes;
        if (
          input.body !== undefined &&
          ((Object.keys(content).length && !jsonMedia) ||
            (consumes?.length &&
              !consumes.some(
                (type: string) =>
                  type === "application/json" || type.endsWith("+json"),
              )))
        )
          return result(
            {
              status: "blocked",
              code: "request_media_type_not_supported",
              documentedMediaTypes: Object.keys(content).length
                ? Object.keys(content)
                : consumes,
              guidance:
                "The operation exists. This tool currently sends JSON bodies; use a project client for the documented serialization.",
            },
            true,
          );
        const required = requiredFields(
          content[jsonMedia || "application/json"]?.schema ||
            bodyParameter?.schema,
          document,
        );
        const missingFields = required.filter(
          (key) =>
            !input.body ||
            typeof input.body !== "object" ||
            !(key in input.body),
        );
        if (missingFields.length)
          return result(
            {
              status: "error",
              code: "required_body_fields_missing",
              missing: missingFields,
            },
            true,
          );
        const { security, anonymous, authentication } =
          operationAuthentication(selected);
        if (
          !anonymous &&
          !authentication &&
          !input.auth &&
          (input.authenticated ?? input.expectedStatus !== 401)
        )
          return result(
            {
              status: "blocked",
              code: "security_scheme_not_supported",
              security,
              guidance:
                "The operation exists, but its security scheme needs a project client. Do not interpret this as a missing endpoint.",
            },
            true,
          );
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(input.query || {})) {
          const parameter = params.find(
            (parameter) => parameter.in === "query" && parameter.name === key,
          );
          if (value == null) continue;
          if (typeof value === "object" && !Array.isArray(value)) {
            if (parameter?.style !== "deepObject")
              return result(
                {
                  status: "blocked",
                  code: "query_serialization_not_supported",
                  parameter: key,
                },
                true,
              );
            for (const [field, entry] of Object.entries(value))
              query.append(`${key}[${field}]`, String(entry));
          } else if (Array.isArray(value)) {
            const format = parameter?.collectionFormat;
            const repeated =
              document.swagger === "2.0"
                ? format === "multi"
                : (parameter?.explode ??
                  (parameter?.style || "form") === "form");
            const delimiter =
              parameter?.style === "spaceDelimited" || format === "ssv"
                ? " "
                : parameter?.style === "pipeDelimited" || format === "pipes"
                  ? "|"
                  : format === "tsv"
                    ? "\t"
                    : ",";
            if (repeated)
              value.forEach((entry) => query.append(key, String(entry)));
            else query.append(key, value.join(delimiter));
          } else query.append(key, String(value));
        }
        const path = selected.path.replace(
          /\{([^}]+)\}/g,
          (_: string, name: string) =>
            encodeURIComponent(input.pathParams![name]),
        );
        const origin = operationBaseUrl(selected, input.serverIndex);
        const scheme =
          input.authenticated === false
            ? null
            : resolveScheme(new URL(origin).origin, input, authentication);
        if (scheme && "error" in scheme)
          return result({ status: "blocked", code: scheme.error }, true);
        const execution = await request(
          {
            method: selected.method,
            path: `${path}${query.size ? `?${query}` : ""}`,
            body: input.body,
            contentType:
              jsonMedia ||
              consumes?.find(
                (type: string) =>
                  type === "application/json" || type.endsWith("+json"),
              ),
            scheme,
            refreshAuthentication: input.refreshAuthentication,
            authenticated:
              input.authenticated ??
              (input.refreshAuthentication ||
                (input.expectedStatus === 401 ? false : !anonymous)),
            authenticateOnChallenge:
              input.authenticated === undefined && anonymous,
            origin,
            headers: input.headers,
            expectedStatus: input.expectedStatus,
          },
          signal,
          ctx,
          onUpdate,
        );
        const details = execution.details as any;
        const documented = Object.keys(selected.operation.responses || {});
        const statusMatches =
          documented.includes(String(details.httpStatus)) ||
          documented.some(
            (status) =>
              status.toUpperCase() === `${String(details.httpStatus)[0]}XX`,
          ) ||
          documented.includes("default");
        const expectedMatches =
          input.expectedStatus === undefined ||
          input.expectedStatus === details.httpStatus;
        const skipped =
          details.status === "blocked" ||
          typeof details.httpStatus !== "number";
        const pass =
          !skipped &&
          !execution.isError &&
          statusMatches &&
          expectedMatches &&
          !details.truncated;
        return result(
          {
            ...details,
            status: skipped ? "blocked" : pass ? "ok" : "error",
            contractId: selected.contract.id,
            origin,
            operationId: selected.operation.operationId,
            contractStatus: skipped ? "blocked" : pass ? "pass" : "fail",
            documentedStatuses: documented,
            expectedStatus: input.expectedStatus,
            validationScope:
              "required_parameters_and_top_level_body_fields; documented_http_status",
            responseSchemaValidation: "not_performed",
            businessValidation: "not_performed",
            contractStale: !!selected.contract.stale,
            contractFetchedAt: selected.contract.fetched_at || null,
            contractContentHash: selected.contract.content_hash || null,
          },
          !pass,
        );
      } catch (error) {
        return result({ status: "error", code: String(error) }, true);
      }
    },
  });
}
