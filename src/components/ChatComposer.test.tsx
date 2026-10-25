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
});

function Harness(props: Partial<ChatComposerProps>) {
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
    input: "",
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
    setInput: vi.fn(),
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

test("removes exactly the image whose chip was closed", () => {
  render(<Harness />);
  expect(screen.getByAltText("first.png")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Remove first.png" }));
  expect(screen.queryByAltText("first.png")).not.toBeInTheDocument();
  expect(screen.getByAltText("second.png")).toBeInTheDocument();
});

test("shows a drop hint only while files are dragged over it", () => {
  const { rerender } = render(<Harness />);
  expect(screen.queryByText("Drop to attach")).not.toBeInTheDocument();
  rerender(<Harness dropActive />);
  expect(screen.getByText("Drop to attach")).toBeInTheDocument();
});
