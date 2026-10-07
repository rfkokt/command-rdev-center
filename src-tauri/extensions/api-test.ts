import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { isPublicIp } from "./agent-reach-security";
import {
  operations,
  searchOperations,
  selectOperation,
  operationDetail,
  operationBaseUrl,
  parameters,
  reference,
  requiredFields,
  serverUrl,
  type Contract,
} from "./openapi-catalog";

const MAX_BODY = 100_000;
const API_AUTH_WORKFLOW = `## Direct API testing and authentication
For Swagger/backend API tests, call api_find_operations, api_operation_detail, and api_contract_test directly. Browser login, a working browser host, workspace credentials, and access to the application's frontend are not prerequisites.
Never search .env files, browser cookies, or workspace files for a user's access token. Never ask the user to log in through the browser or generate a JWT. Call the API tool: it owns a private token dialog and retries authentication when needed. Set authenticated:true when the task explicitly requires a bearer token even if Swagger omits its security declaration. Set authenticated:false only for an intentional anonymous/unauthorized test; expectedStatus:401 prevents token prompting for that negative test.
If the user cancels the token dialog, report authentication_required. If an authenticated request still fails, report the actual HTTP response. A browser_host_closing error does not block direct API testing. Use browser tools when the user explicitly requests UI/browser verification.`;
const tokens = new Map<string, string>();
const mutationOrigins = new Set<string>();
const result = (data: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
  details: data,
  isError,
});

function privateAddress(address: string) {
  return /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^(fc|fd)/i.test(address);
}
function apiUrl(path: string, baseUrl: string) {
  return new URL(path.replace(/^\/+/, ""), `${baseUrl.replace(/\/?$/, "/")}`);
}
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
    authenticateOnChallenge?: boolean;
    origin?: string;
    headers?: Record<string, string>;
    expectedStatus?: number;
    authHeader?: string;
    authPrefix?: string;
    contentType?: string;
  },
  signal: AbortSignal | undefined,
  ctx: any,
  onUpdate?: (update: ReturnType<typeof result>) => void,
) {
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
  const authHeader = input.authHeader || "authorization";
  const authPrefix = input.authPrefix ?? "Bearer ";
  const tokenKey = `${url.origin}:${authHeader}:${authPrefix}`;
  const shouldAuthenticate =
    input.authenticated ?? input.expectedStatus !== 401;
  let authToken = shouldAuthenticate ? tokens.get(tokenKey) || "" : "";
  if (shouldAuthenticate && !authToken) {
    update("authentication", "Waiting for private authentication");
    authToken =
      (
        await ctx.ui.input(
          `Backend API authentication · ${url.origin} · ${authHeader}`,
          authPrefix
            ? "Paste the token only (kept in memory for this chat only)"
            : `Paste the exact ${authHeader} header value, including its required prefix (kept in memory for this chat only)`,
        )
      )?.trim() || "";
    if (authPrefix === "Bearer ")
      authToken = authToken.replace(/^Bearer\s+/i, "");
    if (!authToken)
      return result(
        { status: "blocked", code: "authentication_required" },
        true,
      );
  }
  if (authToken) tokens.set(tokenKey, authToken);
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  const send = () =>
    fetch(url, {
      method: input.method,
      signal: requestSignal,
      redirect: "error",
      headers: {
        accept: "application/json, application/problem+json",
        "accept-language": "id",
        "kai-client-app": "APP_ROLINK",
        ...input.headers,
        ...(input.body !== undefined && {
          "content-type": input.contentType || "application/json",
        }),
        ...(authToken && { [authHeader]: `${authPrefix}${authToken}` }),
      },
      ...(input.body !== undefined && { body: JSON.stringify(input.body) }),
    });
  update("request", "Waiting for backend response");
  let response = await send();
  update("response", "Reading response body", response.status);
  let raw = await response.text();
  if (
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
      authToken =
        (
          await ctx.ui.input(
            `${tokenWasSent ? "API session expired" : "Backend API authentication"} · ${url.origin} · ${authHeader}`,
            authPrefix
              ? "Paste the token only (kept in memory for this chat only)"
              : `Paste the exact ${authHeader} header value, including its required prefix (kept in memory for this chat only)`,
          )
        )?.trim() || "";
    }
    if (authPrefix === "Bearer ")
      authToken = authToken.replace(/^Bearer\s+/i, "");
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
    name: "api_find_operations",
    label: "Search all Swagger operations",
    description:
      "Search the complete saved Swagger/OpenAPI inventory by operation ID, path, summary, description, tags, or parameter names. Empty query lists all operations. Results are paginated; load failures and stale contracts are disclosed. Use refresh before concluding an endpoint is absent.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ maxLength: 500 })),
      contractId: selector.contractId,
      method: selector.method,
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      refresh: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, input, signal) {
      if (input.refresh) {
        // Refresh only saved sources. Model input cannot supply a destination.
        contracts = await Promise.all(
          contracts.map(async (contract) => {
            if (!contract.source_url)
              return {
                ...contract,
                stale: true,
                load_error:
                  "saved_source_url_unavailable; refresh project API settings",
              };
            try {
              const url = new URL(contract.source_url);
              if (
                !["http:", "https:"].includes(url.protocol) ||
                url.username ||
                url.password
              )
                throw new Error("document_url_blocked");
              const response = await fetch(url, {
                redirect: "error",
                signal: signal
                  ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
                  : AbortSignal.timeout(10_000),
              });
              if (!response.ok)
                throw new Error(`document_http_${response.status}`);
              const raw = await response.text();
              if (raw.length > 8 * 1024 * 1024)
                throw new Error("document_exceeds_8_MB");
              const document = JSON.parse(raw);
              if (!document.paths || typeof document.paths !== "object")
                throw new Error("document_paths_unavailable");
              try {
                const base_url = serverUrl(document, contract.source_url);
                return {
                  ...contract,
                  document,
                  base_url,
                  origin: new URL(base_url).origin,
                  stale: false,
                  load_error: null,
                };
              } catch (error) {
                // The document was loaded. Keep its searchable operations even
                // when connectivity metadata cannot yet construct a target URL.
                return {
                  ...contract,
                  document,
                  base_url: "",
                  origin: "",
                  stale: false,
                  load_error: `API server unavailable: ${String(error)}`,
                };
              }
            } catch (error) {
              return { ...contract, stale: true, load_error: String(error) };
            }
          }),
        );
      }
      return result(searchOperations(contracts, input));
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
      "Send one HTTP request to a configured API origin. Prefer api_contract_test for documented operations; raw api_request can exercise deliberate invalid-input cases that contract preflight blocks. Select contractId when multiple contracts exist. Tokens are collected privately per origin; mutations require confirmation. A successful response alone does not prove business behavior.",
    parameters: Type.Object({
      method: Type.Union(
        ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"].map(
          (method) => Type.Literal(method),
        ),
      ),
      path: Type.String({ minLength: 1, maxLength: 4000 }),
      body: Type.Optional(Type.Unknown()),
      authenticated: Type.Optional(Type.Boolean()),
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
        const origin =
          input.origin ||
          contract?.base_url ||
          contract?.origin ||
          (available.length === 1
            ? available[0].base_url || available[0].origin
            : "");
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
            },
            true,
          );
        return await request({ ...input, origin }, signal, ctx, onUpdate);
      } catch (error) {
        return result({ status: "error", code: String(error) }, true);
      }
    },
  });
  pi.registerTool({
    name: "api_contract_test",
    label: "Test Swagger operation",
    description:
      "Execute one exact saved Swagger/OpenAPI operation after api_operation_detail. Call directly; no browser login or workspace token search is needed. Credentials are collected in a private token dialog. If Swagger omits security, an unexpected 401 opens the dialog and retries once. Use authenticated:true to request a bearer token up front, authenticated:false for an intentional anonymous test. Checks required parameters, top-level body fields, and documented HTTP status; full response schemas and business rules need separate assertions. Supply explicit expectedStatus for a negative test.",
    parameters: Type.Object({
      ...selector,
      pathParams: Type.Optional(Type.Record(Type.String(), Type.String())),
      query: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      headers: Type.Optional(Type.Record(Type.String(), Type.String())),
      body: Type.Optional(Type.Unknown()),
      authenticated: Type.Optional(Type.Boolean()),
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
        const security = selected.operation.security ?? document.security ?? [];
        const anonymous =
          !security.length ||
          security.some((option: object) => !Object.keys(option).length);
        const schemes =
          document.components?.securitySchemes ||
          document.securityDefinitions ||
          {};
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
              return { authHeader: "authorization", authPrefix: "Bearer " };
            if (
              scheme?.type === "apiKey" &&
              scheme.in === "header" &&
              typeof scheme.name === "string"
            )
              return {
                authHeader: scheme.name.toLowerCase(),
                authPrefix: "",
              };
            return undefined;
          })
          .find(Boolean);
        if (
          !anonymous &&
          !authentication &&
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
            ...authentication,
            authenticated:
              input.authenticated ??
              (input.expectedStatus === 401 ? false : !anonymous),
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
          },
          !pass,
        );
      } catch (error) {
        return result({ status: "error", code: String(error) }, true);
      }
    },
  });
}
