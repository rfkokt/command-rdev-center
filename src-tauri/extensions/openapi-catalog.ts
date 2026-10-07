export type Contract = {
  id: string;
  origin: string;
  base_url?: string;
  source_url?: string;
  load_error?: string | null;
  stale?: boolean;
  document: any;
};
export type Operation = {
  contract: Contract;
  path: string;
  method: string;
  operation: any;
  pathItem: any;
};
export const METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
]);

export function reference(value: any, document: any): any {
  const seen = new Set<string>();
  while (value && typeof value === "object" && typeof value.$ref === "string") {
    const ref = value.$ref;
    if (!ref.startsWith("#/"))
      throw new Error(`external_reference_unavailable: ${ref}`);
    if (seen.has(ref)) throw new Error(`cyclic_reference: ${ref}`);
    seen.add(ref);
    value = ref
      .slice(2)
      .split("/")
      .map((part: string) =>
        decodeURIComponent(part).replace(/~1/g, "/").replace(/~0/g, "~"),
      )
      .reduce((node: any, part: string) => node?.[part], document);
    if (value === undefined) throw new Error(`reference_not_found: ${ref}`);
  }
  return value;
}

export function operations(contracts: Contract[]) {
  const items: Operation[] = [],
    issues: Array<{ contractId: string; source?: string; code: string }> = [];
  for (const contract of contracts) {
    if (contract.load_error || contract.stale)
      issues.push({
        contractId: contract.id,
        source: contract.source_url,
        code: contract.load_error || "cached_contract_may_be_stale",
      });
    if (
      !contract.document?.paths ||
      typeof contract.document.paths !== "object"
    ) {
      if (!contract.load_error)
        issues.push({
          contractId: contract.id,
          source: contract.source_url,
          code: "paths_unavailable",
        });
      continue;
    }
    for (const [path, raw] of Object.entries(contract.document.paths)) {
      if (!path.startsWith("/")) continue;
      try {
        const pathItem = reference(raw, contract.document);
        for (const [method, rawOperation] of Object.entries(pathItem ?? {})) {
          if (!METHODS.has(method.toLowerCase())) continue;
          const operation = reference(rawOperation, contract.document);
          if (operation && typeof operation === "object")
            items.push({
              contract,
              path,
              method: method.toUpperCase(),
              operation,
              pathItem,
            });
        }
      } catch (error) {
        issues.push({
          contractId: contract.id,
          source: contract.source_url,
          code: `${path}: ${String(error)}`,
        });
      }
    }
  }
  items.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.method.localeCompare(b.method) ||
      a.contract.id.localeCompare(b.contract.id),
  );
  return { items, issues };
}

function normalize(value: string) {
  return value
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
export function operationSummary(item: Operation) {
  return {
    contractId: item.contract.id,
    origin: item.contract.origin,
    baseUrl: item.contract.base_url,
    method: item.method,
    path: item.path,
    operationId: item.operation.operationId,
    summary: item.operation.summary,
    tags: item.operation.tags,
    source: item.contract.source_url,
  };
}
export function searchOperations(
  contracts: Contract[],
  input: {
    query?: string;
    contractId?: string;
    method?: string;
    offset?: number;
    limit?: number;
  },
) {
  const catalog = operations(contracts);
  const terms = normalize(input.query || "")
    .split(" ")
    .filter(Boolean);
  const candidates = catalog.items.filter(
    (item) =>
      (!input.contractId || item.contract.id === input.contractId) &&
      (!input.method || item.method === input.method.toUpperCase()),
  );
  const matches = candidates
    .map((item) => {
      const text = normalize(
        [
          item.path,
          item.method,
          item.operation.operationId,
          item.operation.summary,
          item.operation.description,
          ...(item.operation.tags || []),
          ...(item.operation.parameters || []).map(
            (parameter: any) => parameter.name,
          ),
        ]
          .filter(Boolean)
          .join(" "),
      );
      return {
        item,
        score: terms.filter((term) => text.includes(term)).length,
      };
    })
    .filter(({ score }) => !terms.length || score > 0)
    .sort((a, b) => b.score - a.score);
  const offset = input.offset ?? 0,
    limit = input.limit ?? 30;
  return {
    status: catalog.issues.length ? "partial" : "ok",
    totalOperations: catalog.items.length,
    totalMatches: matches.length,
    offset,
    hasMore: offset + limit < matches.length,
    operations: matches
      .slice(offset, offset + limit)
      .map(({ item }) => operationSummary(item)),
    contracts: contracts.map((contract) => ({
      id: contract.id,
      source: contract.source_url,
      origin: contract.origin,
      stale: !!contract.stale,
      loadError: contract.load_error || null,
      operationCount: catalog.items.filter(
        (item) => item.contract.id === contract.id,
      ).length,
    })),
    issues: catalog.issues,
    guidance: matches.length
      ? "Matches are candidates. Inspect api_operation_detail before choosing an operation. Paginate with offset while hasMore is true."
      : catalog.issues.length
        ? "Inventory is incomplete or stale. Do not conclude the endpoint is absent. Refresh or resolve the reported contract issue."
        : "No match for these keywords. Try alternate names/tags and browse the full inventory with an empty query before concluding absence.",
  };
}

export function selectOperation(
  contracts: Contract[],
  input: {
    contractId?: string;
    origin?: string;
    operationId?: string;
    method?: string;
    path?: string;
  },
) {
  const catalog = operations(contracts);
  if (!input.operationId && !(input.method && input.path))
    return {
      code: "operation_selector_required",
      candidates: [],
      issues: catalog.issues,
    };
  const matches = catalog.items.filter(
    (item) =>
      (!input.contractId || item.contract.id === input.contractId) &&
      (!input.origin || item.contract.origin === input.origin) &&
      (!input.operationId ||
        item.operation.operationId === input.operationId) &&
      (!input.method || item.method === input.method.toUpperCase()) &&
      (!input.path || item.path === input.path),
  );
  return matches.length === 1
    ? { selected: matches[0] }
    : {
        code: matches.length ? "operation_ambiguous" : "operation_not_found",
        candidates: matches.map(operationSummary),
        issues: catalog.issues,
      };
}

export function parameters(item: Operation): any[] {
  const document = item.contract.document;
  const merged = new Map<string, any>();
  for (const raw of [
    ...(item.pathItem.parameters || []),
    ...(item.operation.parameters || []),
  ]) {
    const parameter = reference(raw, document);
    merged.set(`${parameter.in}:${parameter.name}`, parameter);
  }
  return [...merged.values()];
}

export function expandReferences(value: any, document: any) {
  const warnings = new Set<string>();
  let budget = 2000;
  const visit = (node: any, seen: Set<string>, depth: number): any => {
    if (!node || typeof node !== "object") return node;
    if (--budget < 0 || depth > 15) {
      warnings.add(
        "schema_expansion_bounded; inspect remaining $ref in the source contract",
      );
      return node.$ref ? { $ref: node.$ref } : { omitted: true };
    }
    if (node.$ref) {
      if (seen.has(node.$ref)) return { $ref: node.$ref };
      try {
        return visit(
          reference(node, document),
          new Set([...seen, node.$ref]),
          depth + 1,
        );
      } catch (error) {
        warnings.add(String(error));
        return node;
      }
    }
    if (Array.isArray(node))
      return node.map((value) => visit(value, seen, depth + 1));
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [
        key,
        visit(value, seen, depth + 1),
      ]),
    );
  };
  const resolved = visit(value, new Set(), 0);
  return { resolved, warnings: [...warnings] };
}

export function serverUrl(
  document: any,
  source: string,
  servers?: any[],
  index = 0,
) {
  const base = new URL(source);
  if (document.swagger === "2.0") {
    return new URL(
      `${document.schemes?.[index] || base.protocol.slice(0, -1)}://${document.host || base.host}${document.basePath || "/"}`,
    ).href.replace(/\/$/, "");
  }
  const server = servers?.length
    ? servers[index]
    : document.servers?.length
      ? document.servers[index]
      : { url: "/" };
  if (!server) throw new Error("server_index_not_found");
  const target = String(server.url).replace(
    /\{([^}]+)\}/g,
    (_: string, name: string) => {
      const value = server.variables?.[name]?.default;
      if (typeof value !== "string")
        throw new Error(`server_variable_required: ${name}`);
      return value;
    },
  );
  return new URL(target, base).href.replace(/\/$/, "");
}

export function operationBaseUrl(item: Operation, index = 0) {
  const overrides = item.operation.servers || item.pathItem.servers;
  if (!overrides?.length && index === 0 && item.contract.base_url)
    return item.contract.base_url;
  return serverUrl(
    item.contract.document,
    item.contract.source_url || item.contract.base_url || item.contract.origin,
    overrides,
    index,
  );
}

export function operationDetail(item: Operation) {
  const expanded = expandReferences(
    {
      parameters: parameters(item),
      requestBody: item.operation.requestBody,
      responses: item.operation.responses,
      security:
        item.operation.security ?? item.contract.document.security ?? [],
      securitySchemes:
        item.contract.document.components?.securitySchemes ||
        item.contract.document.securityDefinitions ||
        {},
      servers:
        item.operation.servers ||
        item.pathItem.servers ||
        item.contract.document.servers,
      consumes: item.operation.consumes || item.contract.document.consumes,
    },
    item.contract.document,
  );
  return {
    ...operationSummary(item),
    description: item.operation.description,
    contractStale: !!item.contract.stale,
    ...expanded.resolved,
    referenceWarnings: expanded.warnings,
    guidance:
      "Use api_contract_test with this exact contractId and method/path. Missing credentials are collected privately by the API tools; an HTTP status check alone does not verify business behavior.",
  };
}

export function requiredFields(
  schema: any,
  document: any,
  seen = new Set<any>(),
): string[] {
  schema = reference(schema, document);
  if (!schema || seen.has(schema)) return [];
  seen.add(schema);
  return [
    ...new Set<string>([
      ...(schema.required || []).filter(
        (key: string) =>
          !reference(schema.properties?.[key], document)?.readOnly,
      ),
      ...(schema.allOf || []).flatMap((child: any) =>
        requiredFields(child, document, seen),
      ),
    ]),
  ];
}
