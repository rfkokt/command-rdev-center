import { describe, expect, it } from "vitest";
import {
  dropLandsOn,
  fileName,
  inlineImageMime,
  toChatImage,
} from "./attachments";

describe("attachments", () => {
  it("recognises inline image formats by extension", () => {
    expect(inlineImageMime("/a/b/Shot.PNG")).toBe("image/png");
    expect(inlineImageMime("photo.jpeg")).toBe("image/jpeg");
    expect(inlineImageMime("photo.heic")).toBeNull();
    expect(inlineImageMime("notes.txt")).toBeNull();
    expect(inlineImageMime("Makefile")).toBeNull();
  });

  it("keeps only the protocol fields when sending", () => {
    expect(
      toChatImage({
        type: "image",
        data: "AAA",
        mimeType: "image/png",
        id: "x",
        name: "a.png",
        path: "/store/a.png",
      } as Parameters<typeof toChatImage>[0]),
    ).toEqual({ type: "image", data: "AAA", mimeType: "image/png" });
  });

  it("takes the last path segment as the name", () => {
    expect(fileName("/Users/me/Desktop/a b.png")).toBe("a b.png");
    expect(fileName("C:\\x\\y.pdf")).toBe("y.pdf");
  });

  it("maps physical drop positions onto an element", () => {
    const element = {
      getBoundingClientRect: () => ({
        left: 100,
        right: 300,
        top: 400,
        bottom: 500,
      }),
    } as Element;
    // Retina: physical pixels are twice the CSS pixels.
    expect(dropLandsOn(element, { x: 400, y: 900 }, 2)).toBe(true);
    expect(dropLandsOn(element, { x: 100, y: 900 }, 2)).toBe(false);
    expect(dropLandsOn(null, { x: 0, y: 0 }, 1)).toBe(false);
  });
});
