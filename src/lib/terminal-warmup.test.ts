import { describe, expect, it } from "vitest";
import { terminalEventId } from "./terminal-warmup";

// Same cases as `event_ids_use_only_tauri_safe_characters` in terminal.rs.
describe("terminalEventId", () => {
  it("encodes characters Tauri rejects in event names", () => {
    expect(terminalEventId("chat-123__0")).toBe("chat-123__0");
    expect(terminalEventId("antifraud-deployment-3.0-1792655__0")).toBe(
      "antifraud-deployment-3:2E0-1792655__0",
    );
    expect(terminalEventId("a:b é")).toBe("a:3Ab:20:C3:A9");
  });
});
