// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  operations,
  operationDetail,
  requiredFields,
  searchOperations,
  selectOperation,
  serverUrl,
  type Contract,
} from "./openapi-catalog";

const contract = (id: string, paths: object): Contract => ({
  id,
  origin: "https://api.example.com",
  base_url: "https://api.example.com/v1",
  source_url: `https://api.example.com/${id}.json`,
  document: { paths },
});
describe("complete Swagger discovery", () => {
  it("searches every document and paginates the complete inventory rather than the prompt preview", () => {
    const a = contract("first", {
      "/users": {
        get: { operationId: "listUsers", tags: ["Users"] },
        parameters: [],
      },
    });
    const b = contract("second", {
      "/personnel/{id}": {
        get: {
          operationId: "getPersonnel",
          summary: "Employee detail",
          parameters: [{ name: "employeeNumber", in: "query" }],
        },
      },
    });
    expect(
      searchOperations([a, b], { query: "Employee detail" }).operations[0]
        .contractId,
    ).toBe("second");
    expect(
      searchOperations([a, b], { query: "employeeNumber" }).totalMatches,
    ).toBe(1);
    const page = searchOperations([a, b], { limit: 1 });
    expect(page.totalOperations).toBe(2);
    expect(page.hasMore).toBe(true);
    expect(searchOperations([a, b], { offset: 1, limit: 1 }).hasMore).toBe(
      false,
    );
  });
  it("does not turn failed, stale, or external-reference documents into proof of absence", () => {
    const failed = { ...contract("failed", {}), load_error: "fetch timeout" };
    const external = contract("external", {
      "/external": { $ref: "other.json#/paths/external" },
    });
    const result = searchOperations([failed, external], { query: "employee" });
    expect(result.status).toBe("partial");
    expect(result.issues).toHaveLength(2);
    expect(result.guidance).toContain("Do not conclude");
    expect(
      searchOperations([{ ...contract("cached", {}), stale: true }], {}).status,
    ).toBe("partial");
  });
  it("rejects ambiguous operation IDs and inconsistent selectors instead of choosing the first", () => {
    const a = contract("a", { "/users": { get: { operationId: "read" } } }),
      b = contract("b", { "/employees": { get: { operationId: "read" } } });
    expect(selectOperation([a, b], { operationId: "read" }).code).toBe(
      "operation_ambiguous",
    );
    expect(
      selectOperation([a, b], { operationId: "read", contractId: "b" }).selected
        ?.path,
    ).toBe("/employees");
    expect(
      selectOperation([a, b], {
        operationId: "read",
        contractId: "b",
        path: "/users",
      }).code,
    ).toBe("operation_not_found");
  });
  it("resolves path items, inherited parameters, escaped refs, and composed required fields", () => {
    const c = contract("references", {
      "/employees/{id}": { $ref: "#/components/pathItems/Employee" },
    });
    c.document.components = {
      pathItems: {
        Employee: {
          parameters: [{ $ref: "#/components/parameters/Id" }],
          post: {
            operationId: "saveEmployee",
            parameters: [
              {
                name: "id",
                in: "path",
                required: true,
                description: "override",
              },
            ],
            requestBody: { $ref: "#/components/requestBodies/Employee" },
            responses: { 201: { description: "Created" } },
          },
        },
      },
      parameters: { Id: { name: "id", in: "path", required: true } },
      requestBodies: {
        Employee: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Employee~1Create" },
            },
          },
        },
      },
      schemas: {
        "Employee/Create": {
          allOf: [
            {
              type: "object",
              required: ["name", "serverId"],
              properties: { serverId: { readOnly: true } },
            },
            { required: ["organizationId"] },
          ],
        },
      },
    };
    const item = operations([c]).items[0],
      detail = operationDetail(item);
    expect(detail.parameters).toHaveLength(1);
    expect(detail.parameters[0].description).toBe("override");
    expect(
      requiredFields(
        detail.requestBody.content["application/json"].schema,
        c.document,
      ),
    ).toEqual(["name", "organizationId"]);
    expect(detail.referenceWarnings).toEqual([]);
  });
  it("resolves relative/default servers, variables, operation overrides, and Swagger 2 base paths", () => {
    expect(
      serverUrl(
        { openapi: "3.0.3" },
        "https://api.example.com/docs/openapi.json",
      ),
    ).toBe("https://api.example.com");
    expect(
      serverUrl(
        {
          servers: [
            {
              url: "../api/{version}",
              variables: { version: { default: "v2" } },
            },
          ],
        },
        "https://api.example.com/docs/openapi.json",
      ),
    ).toBe("https://api.example.com/api/v2");
    expect(
      serverUrl(
        { swagger: "2.0", host: "backend.example.com", basePath: "/v1" },
        "https://api.example.com/swagger.json",
      ),
    ).toBe("https://backend.example.com/v1");
    expect(
      serverUrl({}, "https://api.example.com/openapi.json", [
        { url: "/override" },
      ]),
    ).toBe("https://api.example.com/override");
  });
});
