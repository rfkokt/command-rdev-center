// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
import UsageSettings from "./UsageSettings";

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

const local = {
  id: "r1",
  name: "Local",
  url: "http://localhost:20128",
  password_set: true,
};
const vps = {
  id: "r2",
  name: "VPS",
  url: "https://9router.example.com",
  password_set: true,
};

test("adds a second 9router with its own password", async () => {
  invoke.mockImplementation((command: string) =>
    Promise.resolve(
      command === "save_router"
        ? { claude: true, routers: [local, vps] }
        : { claude: true, routers: [local] },
    ),
  );
  const toast = vi.fn();
  render(<UsageSettings onToast={toast} />);
  expect(await screen.findByText("Local")).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText(/^Name/), {
    target: { value: "VPS" },
  });
  fireEvent.change(screen.getByLabelText(/^URL/), {
    target: { value: "https://9router.example.com" },
  });
  fireEvent.change(screen.getByLabelText(/^Dashboard password/), {
    target: { value: "s3cret" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add 9router" }));

  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("save_router", {
      id: null,
      name: "VPS",
      url: "https://9router.example.com",
      password: "s3cret",
    }),
  );
  expect(await screen.findByText("VPS")).toBeInTheDocument();
  expect(toast).toHaveBeenCalledWith("VPS connected");
});

test("editing keeps the stored password when left empty", async () => {
  invoke.mockResolvedValue({ claude: true, routers: [local] });
  render(<UsageSettings onToast={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.click(screen.getByRole("button", { name: "Save 9router" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("save_router", {
      id: "r1",
      name: "Local",
      url: "http://localhost:20128",
      password: null,
    }),
  );
});
