// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => "PR status"),
}));
import { invoke } from "@tauri-apps/api/core";
import PullRequestControls from "./PullRequestControls";
test("renders structured CI and inserts evidence only on explicit request", async () => {
  const result = JSON.stringify({
    title: "Fix",
    url: "https://github.com/a/b/pull/1",
    state: "OPEN",
    statusCheckRollup: [{ name: "Tests", conclusion: "FAILURE" }],
  });
  vi.mocked(invoke).mockResolvedValueOnce(result);
  localStorage.setItem("kern:github-account:/repo", "rfkokt");
  const send = vi.fn();
  render(
    <PullRequestControls path="/repo" onToast={vi.fn()} onSendToAgent={send} />,
  );
  fireEvent.click(screen.getByText("Refresh PR / CI"));
  await screen.findByText("Tests: FAILURE");
  expect(send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Send CI status to agent draft"));
  expect(send).toHaveBeenCalledWith(expect.stringContaining(result));
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});
test("creates only on explicit click with selected account and edited fields", async () => {
  render(<PullRequestControls path="/repo" onToast={vi.fn()} />);
  fireEvent.change(screen.getByRole("textbox", { name: "GitHub account" }), {
    target: { value: "rfkokt" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "PR title" }), {
    target: { value: "My PR" },
  });
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Create PR"));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("scm_pull_request", {
      repositoryPath: "/repo",
      account: "rfkokt",
      title: "My PR",
      body: "",
    }),
  );
});
test("refreshes read-only status using saved account", async () => {
  localStorage.setItem("kern:github-account:/repo", "rfkokt");
  render(<PullRequestControls path="/repo" onToast={vi.fn()} />);
  fireEvent.click(screen.getByText("Refresh PR / CI"));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("scm_pull_request", {
      repositoryPath: "/repo",
      account: "rfkokt",
      title: null,
      body: null,
    }),
  );
});
