import { describe, expect, it } from "vitest";
import { isPreviewableImage } from "./ProjectFilesSidebar";

describe("isPreviewableImage", () => {
  it("accepts supported image extensions case-insensitively", () => {
    expect(["shot.png", "photo.JPEG", "clip.gif", "image.webp", "scan.bmp", "icon.ico"].every(isPreviewableImage)).toBe(true);
    expect(isPreviewableImage("video.webm")).toBe(false);
  });
});
