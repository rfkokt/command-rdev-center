// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import PrReviewDialog from "./PrReviewDialog";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.resetAllMocks();
});
test("prepares a fresh reviewer chat with no creator transcript and default fix mode", async () => {
  const prepared = {
    session: { repositoryPath: "/repo", worktreePath: "/review", number: 19 },
    prompt: "PR evidence only",
  };
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "list_harnesses"
      ? [{ id: "claude-code", label: "Claude", available: true }]
      : command === "list_available_models"
        ? ["anthropic/claude"]
        : prepared,
  );
  const start = vi.fn();
  render(
    <PrReviewDialog
      request={{
        path: "/creator",
        repositoryPath: "/repo",
        account: "octocat",
      }}
      onStart={start}
      onClose={vi.fn()}
      onToast={vi.fn()}
    />,
  );
  const button = await screen.findByRole("button", {
    name: "Review with Claude",
  });
  fireEvent.click(button);
  await waitFor(() => expect(start).toHaveBeenCalled());
  expect(invoke).toHaveBeenCalledWith(
    "prepare_pr_review",
    expect.objectContaining({
      repositoryPath: "/creator",
      fix: true,
      postComment: false,
      account: "octocat",
      checks: expect.arrayContaining(["pnpm exec vitest run"]),
    }),
  );
  expect(start.mock.calls[0][0]).toEqual(prepared);
  expect(
    JSON.parse(localStorage.getItem("kern:pr-review-choice:/repo")!),
  ).toEqual({ harness: "claude-code", model: "" });
});
test("fork rejection stays visible without starting a chat", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_harnesses")
      return [{ id: "claude-code", label: "Claude", available: true }];
    if (command === "list_available_models") return [];
    throw new Error("Fork PR: review stopped");
  });
  const start = vi.fn();
  render(
    <PrReviewDialog
      request={{ path: "/repo", repositoryPath: "/repo", account: "octocat" }}
      onStart={start}
      onClose={vi.fn()}
      onToast={vi.fn()}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Review with Claude" }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain("Fork PR");
  expect(start).not.toHaveBeenCalled();
});

test("uses the real list_harnesses shape: label + available", async () => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "list_harnesses"
      ? [
          {
            id: "pi",
            label: "pi",
            protocol: "native",
            available: true,
            is_default: true,
          },
          {
            id: "claude-code",
            label: "Claude Code",
            protocol: "acp",
            available: false,
            is_default: false,
          },
        ]
      : [],
  );
  render(
    <PrReviewDialog
      request={{ path: "/repo", repositoryPath: "/repo", account: "octocat" }}
      onStart={vi.fn()}
      onClose={vi.fn()}
      onToast={vi.fn()}
    />,
  );
  expect(
    await screen.findByRole("option", { name: "Claude Code (not installed)" }),
  ).toBeTruthy();
  const button = screen.getByRole("button", {
    name: "Review with Claude Code",
  }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Reviewer agent"), {
    target: { value: "pi" },
  });
  expect(
    (
      screen.getByRole("button", {
        name: "Review with pi",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});
