import { describe, expect, it } from "vitest";
import { planImageDelivery } from "./attachment-delivery";
import type { ComposerImage } from "./attachments";

const stored: ComposerImage = {
  type: "image",
  id: "a",
  name: "shot.png",
  path: "/store/a/shot.png",
  data: "AAAA",
  mimeType: "image/png",
};
const inline = { type: "image", data: "AAAA", mimeType: "image/png" };

describe("planImageDelivery", () => {
  it("leaves messages without images alone", () => {
    expect(planImageDelivery("hi", [], true)).toEqual({
      message: "hi",
      images: [],
    });
  });

  it.each([true, null] as const)(
    "sends inline plus path when support is %s",
    (support) => {
      const plan = planImageDelivery("look", [stored], support);
      expect(plan.images).toEqual([inline]);
      expect(plan.message).toContain(
        JSON.stringify({
          name: stored.name,
          path: stored.path,
          mime: stored.mimeType,
        }),
      );
    },
  );

  it("sends text-only models paths and an explicit limitation", () => {
    const plan = planImageDelivery("look", [stored], false);
    expect(plan.images).toEqual([]);
    expect(plan.message).toContain("/store/a/shot.png");
    expect(plan.message).toContain("cannot see images");
  });

  it.each([true, false, null] as const)(
    "rejects unsaved images rather than losing them (%s)",
    (support) => {
      expect(() =>
        planImageDelivery("look", [{ ...stored, path: undefined }], support),
      ).toThrow("not saved yet");
    },
  );

  it("escapes filenames and paths as JSON records", () => {
    const image = { ...stored, name: 'shot\n".png', path: '/store/a\n".png' };
    const plan = planImageDelivery("look", [image], false);
    const record = plan.message
      .split("\n")
      .find((line) => line.startsWith("{"));
    expect(JSON.parse(record!)).toEqual({
      name: image.name,
      path: image.path,
      mime: image.mimeType,
    });
  });
});
