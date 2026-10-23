// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve([])),
}));

import ProjectFilesSidebar from "./ProjectFilesSidebar";

afterEach(cleanup);

describe("ProjectFilesSidebar", () => {
  it("switches from the global chat to a project without a hooks error", () => {
    const { container, rerender } = render(
      <ProjectFilesSidebar projectPath="global" projectName="Global" />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(
      <ProjectFilesSidebar projectPath="/tmp/demo" projectName="demo" />,
    );
    expect(container).not.toBeEmptyDOMElement();
  });
});
