// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dropLandsOn,
  fileName,
  inlineImageMime,
  toChatImage,
  inlineImageSize,
  estimatedImageTokens,
  prepareComposerImage,
  MAX_INLINE_IMAGE_BASE64,
} from "./attachments";

afterEach(() => vi.restoreAllMocks());

describe("attachments", () => {
  it("caps dimensions without upscaling and estimates Claude area tokens", () => {
    expect(inlineImageSize(4000, 3000)).toEqual({ width: 1568, height: 1176 });
    expect(inlineImageSize(3000, 4000)).toEqual({ width: 1176, height: 1568 });
    expect(inlineImageSize(640, 480)).toEqual({ width: 640, height: 480 });
    expect(estimatedImageTokens(1568, 1176)).toBe(2459);
    expect(() => inlineImageSize(0, 300)).toThrow("Invalid image dimensions");
  });

  it("resizes only inline bytes, preserving original stored metadata", async () => {
    vi.spyOn(window, "Image").mockImplementation(function () {
      return {
        naturalWidth: 4000,
        naturalHeight: 3000,
        onload: null,
        set src(_value: string) {
          queueMicrotask(() => (this as any).onload());
        },
      } as any;
    });
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as any);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(
      (mime?: string) => `data:${mime};base64,RESIZED`,
    );
    const stored = Object.freeze({
      id: "a",
      name: "photo.jpg",
      path: "/store/photo.jpg",
      mime: "image/jpeg",
      size: 1000,
      data: "ORIGINAL",
    });
    const image = await prepareComposerImage(stored);
    expect(image).toMatchObject({
      data: "RESIZED",
      mimeType: "image/jpeg",
      path: stored.path,
      width: 1568,
      height: 1176,
    });
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1568, 1176);
    expect(stored.data).toBe("ORIGINAL");
    expect(stored.mime).toBe("image/jpeg");
  });
  it("keeps transparency for PNG and falls back to JPEG when PNG is too big", async () => {
    vi.spyOn(window, "Image").mockImplementation(function () {
      return {
        naturalWidth: 3000,
        naturalHeight: 2000,
        onload: null,
        set src(_value: string) {
          queueMicrotask(() => (this as any).onload());
        },
      } as any;
    });
    const context = {
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      globalCompositeOperation: "source-over",
      fillStyle: "",
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as any,
    );
    const encode = vi
      .spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockImplementation((mime?: string) =>
        mime === "image/png"
          ? `data:image/png;base64,${"P".repeat(MAX_INLINE_IMAGE_BASE64 + 1)}`
          : "data:image/jpeg;base64,SMALL",
      );
    const image = await prepareComposerImage({
      id: "a",
      name: "shot.png",
      path: "/store/shot.png",
      mime: "image/png",
      size: 1,
      data: "ORIGINAL",
    });
    expect(encode).toHaveBeenNthCalledWith(1, "image/png", undefined);
    expect(image).toMatchObject({ data: "SMALL", mimeType: "image/jpeg" });
    expect(context.fillRect).toHaveBeenCalled();
  });

  it("re-encodes small-dimension images whose bytes exceed the inline cap", async () => {
    vi.spyOn(window, "Image").mockImplementation(function () {
      return {
        naturalWidth: 800,
        naturalHeight: 600,
        onload: null,
        set src(_value: string) {
          queueMicrotask(() => (this as any).onload());
        },
      } as any;
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as any);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:image/jpeg;base64,SMALLER",
    );
    const image = await prepareComposerImage({
      id: "a",
      name: "big.jpg",
      path: "/store/big.jpg",
      mime: "image/jpeg",
      size: 1,
      data: "J".repeat(MAX_INLINE_IMAGE_BASE64 + 1),
    });
    expect(image).toMatchObject({ data: "SMALLER", width: 800, height: 600 });
  });

  it("rejects decode errors instead of sending unprocessed bytes", async () => {
    vi.spyOn(window, "Image").mockImplementation(function () {
      return {
        onerror: null,
        set src(_value: string) {
          queueMicrotask(() => (this as any).onerror());
        },
      } as any;
    });
    await expect(
      prepareComposerImage({
        id: "a",
        name: "bad.png",
        path: "/store/bad.png",
        mime: "image/png",
        size: 4,
        data: "BAD",
      }),
    ).rejects.toThrow("Couldn't decode attached image");
  });

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
