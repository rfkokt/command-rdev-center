import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { isPublicIp } from "./agent-reach-security";

const allowedOrigin = process.env.CRC_API_ALLOWED_ORIGIN || "";
const contractPath = process.env.CRC_API_CONTRACT_PATH || "";
const MAX_BODY = 100_000;
let authToken = "";
let mutationsAllowed = false;
const result = (data: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
  details: data,
  isError,
});

function privateAddress(address: string) {
  return /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^(fc|fd)/i.test(address);
}
async function validateUrl(raw: string) {
  const url = new URL(raw, allowedOrigin);
  if (!allowedOrigin || url.origin !== allowedOrigin)
    throw new Error("api_origin_not_allowed");
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("api_url_blocked");
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error("api_dns_empty");
  const classes = new Set(
    addresses.map(({ address }) =>
      isPublicIp(address)
        ? "public"
        : privateAddress(address)
          ? "private"
          : "blocked",
    ),
  );
  if (classes.size !== 1 || classes.has("blocked"))
    throw new Error("api_destination_blocked");
  return url;
}

async function request(
  input: {
    method: string;
    path: string;
    body?: unknown;
    authenticated?: boolean;
  },
  signal: AbortSignal,
  ctx: any,
  onUpdate?: (update: ReturnType<typeof result>) => void,
) {
  const update = (stage: string, activity: string, status?: number) =>
    onUpdate?.(
      result({
        activity,
        stage,
        method: input.method,
        path: new URL(input.path, allowedOrigin).pathname,
        ...(status !== undefined && { httpStatus: status }),
      }),
    );
  update("destination", "Validating API destination");
  const url = await validateUrl(input.path);
  if (
    input.method !== "GET" &&
    !mutationsAllowed &&
    !(await ctx.ui.confirm(
      "Allow API mutations for this chat?",
      `${input.method} ${url.pathname}${url.search}\nAllow subsequent POST, PUT, PATCH, and DELETE requests in this chat without asking again.`,
    ))
  )
    return result({ status: "blocked", code: "user_rejected" });
  if (input.method !== "GET") mutationsAllowed = true;
  if (input.authenticated !== false && !authToken) {
    update("authentication", "Waiting for private authentication");
    authToken =
      (
        await ctx.ui.input(
          "Backend API authentication",
          "Paste the token only (kept in memory for this chat only)",
        )
      )
        ?.trim()
        .replace(/^Bearer\s+/i, "") || "";
    if (!authToken)
      return result({ status: "blocked", code: "authentication_required" });
  }
  const send = () =>
    fetch(url, {
      method: input.method,
      signal,
      redirect: "error",
      headers: {
        accept: "application/json, application/problem+json",
        "accept-language": "id",
        "kai-client-app": "APP_ROLINK",
        ...(input.body !== undefined && {
          "content-type": "application/json",
        }),
        ...(authToken && { authorization: `Bearer ${authToken}` }),
      },
      ...(input.body !== undefined && { body: JSON.stringify(input.body) }),
    });
  update("request", "Waiting for backend response");
  let response = await send();
  update("response", "Reading response body", response.status);
  let raw = await response.text();
  if (
    input.authenticated !== false &&
    response.status === 400 &&
    /"type"\s*:\s*"invalid_(?:token|request)"[\s\S]*Sesi telah berakhir/i.test(
      raw,
    )
  ) {
    authToken = "";
    update("authentication", "Session expired · Waiting for a fresh token");
    authToken =
      (
        await ctx.ui.input(
          "API session expired",
          "Paste a fresh token (kept in memory for this chat only)",
        )
      )
        ?.trim()
        .replace(/^Bearer\s+/i, "") || "";
    if (!authToken)
      return result({ status: "blocked", code: "authentication_required" });
    update("retry", "Retrying request with fresh token");
    response = await send();
    update(
      "validation",
      "Validating response against contract",
      response.status,
    );
    raw = await response.text();
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
      status: response.ok ? "ok" : "error",
      httpStatus: response.status,
      method: input.method,
      path: `${url.pathname}${url.search}`,
      traceId:
        response.headers.get("x-trace-id") ||
        response.headers.get("x-request-id"),
      body,
      truncated: raw.length > MAX_BODY,
    },
    !response.ok,
  );
}

export default function (pi: ExtensionAPI) {
  if (!allowedOrigin) return;
  pi.registerTool({
    name: "api_request",
    label: "Test backend API",
    description:
      "Send one bounded HTTP request directly to this project's configured API origin. Authentication is collected privately and mutations require confirmation.",
    parameters: Type.Object({
      method: Type.Union([
        Type.Literal("GET"),
        Type.Literal("POST"),
        Type.Literal("PUT"),
        Type.Literal("PATCH"),
        Type.Literal("DELETE"),
      ]),
      path: Type.String({ minLength: 1, maxLength: 4000 }),
      body: Type.Optional(Type.Unknown()),
      authenticated: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, input, signal, onUpdate, ctx) {
      try {
        return await request(input, signal, ctx, onUpdate);
      } catch (error) {
        return result(
          {
            status: "error",
            code: error instanceof Error ? error.message : String(error),
          },
          true,
        );
      }
    },
  });

  if (contractPath)
    pi.registerTool({
      name: "api_contract_test",
      label: "Test Swagger operation",
      description:
        "Run one operation from the project's saved Swagger/OpenAPI contract and compare the HTTP status with documented responses.",
      parameters: Type.Object({
        operationId: Type.Optional(Type.String({ maxLength: 300 })),
        method: Type.Optional(Type.String({ maxLength: 10 })),
        path: Type.Optional(Type.String({ maxLength: 2000 })),
        pathParams: Type.Optional(Type.Record(Type.String(), Type.String())),
        query: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        body: Type.Optional(Type.Unknown()),
      }),
      async execute(_id, input, signal, onUpdate, ctx) {
        try {
          onUpdate(
            result({
              activity: "Resolving operation from Swagger",
              stage: "contract",
              operationId: input.operationId,
              method: input.method,
              path: input.path,
            }),
          );
          const contract = JSON.parse(await readFile(contractPath, "utf8"));
          let selected: any;
          for (const [path, methods] of Object.entries(contract.paths || {}))
            for (const [method, operation] of Object.entries(methods as object))
              if (
                (input.operationId &&
                  (operation as any).operationId === input.operationId) ||
                (!input.operationId &&
                  method.toUpperCase() === input.method?.toUpperCase() &&
                  path === input.path)
              )
                selected = { method: method.toUpperCase(), path, operation };
          if (!selected)
            return result(
              { status: "error", code: "operation_not_found" },
              true,
            );
          let path = selected.path.replace(
            /\{([^}]+)\}/g,
            (_: string, name: string) =>
              encodeURIComponent(input.pathParams?.[name] ?? `{${name}}`),
          );
          if (path.includes("{"))
            return result(
              { status: "error", code: "path_parameter_required" },
              true,
            );
          const query = new URLSearchParams();
          for (const [key, value] of Object.entries(input.query || {}))
            query.set(key, String(value));
          const required = (selected.operation.requestBody?.content?.[
            "application/json"
          ]?.schema?.required || []) as string[];
          const missing = required.filter(
            (key) =>
              !(
                input.body &&
                typeof input.body === "object" &&
                key in input.body
              ),
          );
          if (missing.length)
            return result(
              {
                status: "error",
                code: "required_body_fields_missing",
                missing,
              },
              true,
            );
          const execution = await request(
            {
              method: selected.method,
              path: `${path}${query.size ? `?${query}` : ""}`,
              body: input.body,
            },
            signal,
            ctx,
            onUpdate,
          );
          const details = execution.details as any;
          const documented = Object.keys(selected.operation.responses || {});
          return result(
            {
              ...details,
              operationId: selected.operation.operationId,
              contractStatus:
                documented.includes(String(details.httpStatus)) ||
                documented.includes("default")
                  ? "pass"
                  : "fail",
              documentedStatuses: documented,
            },
            details.status === "error",
          );
        } catch (error) {
          return result(
            {
              status: "error",
              code: error instanceof Error ? error.message : String(error),
            },
            true,
          );
        }
      },
    });
}
