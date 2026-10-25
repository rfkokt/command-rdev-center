// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import ChatComposer, { type ChatComposerProps } from "./ChatComposer";
import type { ComposerImage } from "../lib/attachments";

afterEach(cleanup);

const image = (id: string, name: string): ComposerImage => ({
  type: "image",
  id,
  name,
  data: "AAAA",
  mimeType: "image/png",
  width: 1568,
  height: 1176,
});

function Harness(props: Partial<ChatComposerProps>) {
  const [input, setInput] = useState(props.input ?? "");
  const [images, setImages] = useState<ComposerImage[]>([
    image("a", "first.png"),
    image("b", "second.png"),
  ]);
  const base: ChatComposerProps = {
    globalChat: true,
    driveDetached: false,
    agentStatus: "idle",
    isNewSessionLoading: false,
    chatReady: true,
    isAborting: false,
    researchBusy: false,
    researchUsageError: false,
    projectPath: "/repo",
    input,
    images,
    files: [],
    currentThinking: "medium",
    slashCommands: [],
    commandIndex: 0,
    filePickerQuery: null,
    atHint: "",
    tablePreviews: [],
    inputRef: createRef(),
    filePickerRef: createRef(),
    setInput,
    setImages,
    setFiles: vi.fn(),
    setPreviewImage: vi.fn(),
    setFilePickerQuery: vi.fn(),
    setResearchUsageError: vi.fn(),
    setCommandIndex: vi.fn(),
    onPaste: vi.fn(),
    onAttachFiles: vi.fn(),
    onSubmit: vi.fn(async () => undefined),
    onChooseCommand: vi.fn(),
    onFilePick: vi.fn(),
    onRemoveTable: vi.fn(),
    onSetThinking: vi.fn(async () => undefined),
    planMode: false,
    onPlanModeChange: vi.fn(),
  };
  return <ChatComposer {...base} {...props} />;
}

test("recalls prompts newest-first and restores the draft", () => {
  render(<Harness promptHistory={["first prompt", "last prompt"]} />);
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "my draft" } });
  input.setSelectionRange(0, 0);
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(input.value).toBe("last prompt");
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(input.value).toBe("first prompt");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(input.value).toBe("last prompt");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(input.value).toBe("my draft");
});

test("editing recalled text starts a fresh draft and multiline cursor stays native", () => {
  render(<Harness promptHistory={["old"]} />);
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.keyDown(input, { key: "ArrowUp" });
  fireEvent.change(input, { target: { value: "edited\nsecond line" } });
  input.setSelectionRange(input.value.length, input.value.length);
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(input.value).toBe("edited\nsecond line");
  input.setSelectionRange(0, 0);
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(input.value).toBe("old");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(input.value).toBe("edited\nsecond line");
});

test("pickers and IME take priority over prompt history", () => {
  const setCommandIndex = vi.fn();
  const { rerender } = render(
    <Harness
      promptHistory={["old"]}
      slashCommands={[{ name: "help", description: "Help", source: "test" }]}
      setCommandIndex={setCommandIndex}
    />,
  );
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(setCommandIndex).toHaveBeenCalled();
  expect(input.value).toBe("");
  rerender(<Harness promptHistory={["old"]} filePickerQuery="a" />);
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(input.value).toBe("");
  rerender(<Harness promptHistory={["old"]} />);
  fireEvent.keyDown(input, { key: "ArrowUp", isComposing: true });
  expect(input.value).toBe("");
});

test("removes exactly the image whose chip was closed", () => {
  render(<Harness />);
  expect(screen.getByAltText("first.png")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Remove first.png" }));
  expect(screen.queryByAltText("first.png")).not.toBeInTheDocument();
  expect(screen.getByAltText("second.png")).toBeInTheDocument();
});

test("labels tokens as an estimate and hides it for path-only delivery", () => {
  const { rerender } = render(<Harness imageSupport={true} />);
  expect(screen.getAllByText("~2,459 tokens (Claude est.)")).toHaveLength(2);
  rerender(<Harness imageSupport={false} />);
  expect(
    screen.queryByText("~2,459 tokens (Claude est.)"),
  ).not.toBeInTheDocument();
  expect(screen.getAllByText("Path only")).toHaveLength(2);
});

test("shows a drop hint only while files are dragged over it", () => {
  const { rerender } = render(<Harness />);
  expect(screen.queryByText("Drop to attach")).not.toBeInTheDocument();
  rerender(<Harness dropActive />);
  expect(screen.getByText("Drop to attach")).toBeInTheDocument();
});
