// @vitest-environment node
import { describe, expect, test } from "vitest";
import source from "./kern-sheet-writer.gs?raw";

const VALUE_IN_LIST = "VALUE_IN_LIST";

/** Runs the Apps Script against an in-memory sheet. */
function writer(rows: string[][], dropdown?: string[]) {
  const writes: Array<[number, number, string]> = [];
  const sheet = {
    getName: () => "Backlogs",
    getSheetId: () => 584496886,
    getDataRange: () => ({ getDisplayValues: () => rows }),
    getRange: (row: number, column: number) => ({
      getDataValidation: () =>
        dropdown && {
          getCriteriaType: () => VALUE_IN_LIST,
          getCriteriaValues: () => [dropdown],
        },
      setValue: (value: string) => {
        writes.push([row, column, value]);
        rows[row - 1][column - 1] = value;
      },
    }),
  };
  const globals = {
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: () => "s3cret" }),
    },
    LockService: {
      getDocumentLock: () => ({ waitLock() {}, releaseLock() {} }),
    },
    SpreadsheetApp: {
      DataValidationCriteria: { VALUE_IN_LIST, VALUE_IN_RANGE: "RANGE" },
      getActiveSpreadsheet: () => ({
        getSheetByName: (name: string) => (name === "Backlogs" ? sheet : null),
        getSheets: () => [sheet],
      }),
    },
    ContentService: {
      MimeType: { JSON: "json" },
      createTextOutput: (text: string) => ({ setMimeType: () => text }),
    },
  };
  const doPost = new Function(
    ...Object.keys(globals),
    `${source}\nreturn doPost;`,
  )(...Object.values(globals));
  const post = (request: object) =>
    JSON.parse(
      doPost({
        postData: {
          contents: JSON.stringify({
            secret: "s3cret",
            sheet: "Backlogs",
            pics: ["Rifky"],
            ...request,
          }),
        },
      }),
    );
  return { post, writes };
}

const sheetRows = () => [
  ["Column 1", "Tugas", "PIC", "Status"],
  ["352", "Draft dates", "Rifky", "Testing"],
  ["329", "Non roster", "Rifky", "Done"],
  ["329", "Non roster params", "Rifky", "Testing"],
  ["400", "Someone else", "Regi Abdul", "To Do"],
];

describe("kern sheet writer (Apps Script)", () => {
  test("updates one status cell and reports before and after", () => {
    const { post, writes } = writer(sheetRows(), ["Testing", "Done"]);
    expect(
      post({ no: "352", status: "Done", expected: "Testing", row: 2 }),
    ).toEqual({
      ok: true,
      sheet: "Backlogs",
      row: 2,
      no: "352",
      pic: "Rifky",
      before: "Testing",
      after: "Done",
    });
    expect(writes).toEqual([[2, 4, "Done"]]);
  });

  test("refuses unsafe writes", () => {
    const { post, writes } = writer(sheetRows(), ["Testing", "Done"]);
    expect(post({ secret: "wrong", no: "352", status: "Done" }).error).toBe(
      "unauthorized",
    );
    expect(post({ no: "329", status: "Done" })).toMatchObject({
      error: "task_ambiguous",
      rows: [3, 4],
    });
    expect(post({ no: "400", status: "Done" }).error).toBe("pic_not_allowed");
    expect(post({ no: "352", status: "Selesai" })).toMatchObject({
      error: "invalid_status",
      statuses: ["Testing", "Done"],
    });
    expect(
      post({ no: "352", status: "Done", expected: "To Do" }),
    ).toMatchObject({ error: "status_changed", before: "Testing" });
    expect(writes).toEqual([]);
  });

  test("lists dropdown statuses, else the values already used", () => {
    expect(
      writer(sheetRows(), ["A", "B"]).post({ action: "statuses" }),
    ).toEqual({ ok: true, statuses: ["A", "B"] });
    expect(writer(sheetRows()).post({ action: "statuses" }).statuses).toEqual([
      "Testing",
      "Done",
      "To Do",
    ]);
  });
});
