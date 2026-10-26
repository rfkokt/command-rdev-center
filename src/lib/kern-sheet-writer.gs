/**
 * Kern sheet writer — lets Kern change a task's Status cell after you approve
 * the change in the app. Nothing else in the spreadsheet is written.
 *
 * Setup (once per spreadsheet):
 * 1. Extensions → Apps Script, replace the code with this file, save.
 * 2. Project Settings (gear) → Script properties → add KERN_SECRET with the
 *    secret shown in Kern → Project Settings → Tasks.
 * 3. Deploy → New deployment → Web app. Execute as: Me. Who has access:
 *    Anyone. Copy the Web app URL into Kern.
 */
function doPost(event) {
  try {
    const request = JSON.parse(event.postData.contents);
    const secret =
      PropertiesService.getScriptProperties().getProperty("KERN_SECRET");
    if (!secret || request.secret !== secret)
      return reply({ ok: false, error: "unauthorized" });
    const sheet = findSheet(request);
    if (!sheet) return reply({ ok: false, error: "sheet_not_found" });
    const lock = LockService.getDocumentLock();
    lock.waitLock(10000);
    try {
      return reply(handle(request, sheet));
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    return reply({ ok: false, error: String(error) });
  }
}

function handle(request, sheet) {
  const values = sheet.getDataRange().getDisplayValues();
  const headers = (values[0] || []).map(normalize);
  const column = (names) => headers.findIndex((name) => names.includes(name));
  const statusColumn = column(["status", "state"]);
  const picColumn = column(["pic", "assignee", "owner", "penanggungjawab"]);
  const noColumn = Math.max(column(["no", "nomor", "id", "key"]), 0);
  if (statusColumn < 0) return { ok: false, error: "status_column_not_found" };
  const valid = statuses(sheet, statusColumn, values);
  if (request.action === "statuses") return { ok: true, statuses: valid };

  const no = String(request.no).trim();
  let rows = [];
  values.forEach((row, index) => {
    if (index > 0 && String(row[noColumn]).trim() === no) rows.push(index + 1);
  });
  if (request.row) rows = rows.filter((row) => row === Number(request.row));
  if (!rows.length) return { ok: false, error: "task_not_found" };
  if (rows.length > 1) return { ok: false, error: "task_ambiguous", rows };
  const row = rows[0];
  const record = values[row - 1];
  const pic = picColumn < 0 ? "" : String(record[picColumn]).trim();
  const pics = (request.pics || []).map((name) =>
    String(name).trim().toLowerCase(),
  );
  if (!pics.includes(pic.toLowerCase()))
    return { ok: false, error: "pic_not_allowed", pic };
  const before = String(record[statusColumn]);
  if (
    request.expected != null &&
    before.trim() !== String(request.expected).trim()
  )
    return { ok: false, error: "status_changed", before };
  if (valid.length && !valid.includes(request.status))
    return { ok: false, error: "invalid_status", statuses: valid };
  sheet.getRange(row, statusColumn + 1).setValue(request.status);
  return {
    ok: true,
    sheet: sheet.getName(),
    row,
    no,
    pic,
    before,
    after: request.status,
  };
}

/** The Status column's dropdown values, else the values already used. */
function statuses(sheet, statusColumn, values) {
  const rule =
    values.length > 1
      ? sheet.getRange(2, statusColumn + 1).getDataValidation()
      : null;
  const criteria = SpreadsheetApp.DataValidationCriteria;
  if (rule && rule.getCriteriaType() === criteria.VALUE_IN_LIST)
    return rule.getCriteriaValues()[0].map(String);
  if (rule && rule.getCriteriaType() === criteria.VALUE_IN_RANGE)
    return rule.getCriteriaValues()[0].getDisplayValues().flat().filter(String);
  const used = values.slice(1).map((row) => String(row[statusColumn]).trim());
  return [...new Set(used.filter(Boolean))];
}

function findSheet(request) {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  if (request.sheet) return book.getSheetByName(request.sheet);
  if (request.gid == null) return book.getSheets()[0];
  return book
    .getSheets()
    .find((sheet) => String(sheet.getSheetId()) === String(request.gid));
}

function normalize(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function reply(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
