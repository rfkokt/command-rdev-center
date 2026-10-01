import { describe, expect, test } from "vitest";
import {
  canForkNode,
  entryPreview,
  flattenEntries,
  flattenTree,
} from "./SessionTreePanel";

describe("flat session entries", () => {
  test("preserves branches, orphan roots, and labels", () => {
    const nodes = flattenEntries([
      {
        type: "message",
        id: "root",
        parentId: null,
        message: { role: "user", content: "root" },
      },
      {
        type: "message",
        id: "left",
        parentId: "root",
        message: { role: "assistant", content: "left" },
      },
      {
        type: "message",
        id: "right",
        parentId: "root",
        message: { role: "user", content: "right" },
      },
      {
        type: "label",
        id: "label",
        parentId: "right",
        targetId: "left",
        label: "checkpoint",
      },
      {
        type: "message",
        id: "orphan",
        parentId: "missing",
        message: { role: "user", content: "orphan" },
      },
    ]);
    expect(nodes.map((node) => node.id)).toEqual([
      "root",
      "left",
      "right",
      "label",
      "orphan",
    ]);
    expect(nodes.map((node) => node.depth)).toEqual([0, 1, 1, 2, 0]);
    expect(nodes[1].label).toBe("checkpoint");
    expect(canForkNode(nodes[0])).toBe(true);
    expect(canForkNode(nodes[1])).toBe(false);
    expect(canForkNode(nodes[3])).toBe(false);
  });

  test("handles a long session without recursive traversal", () => {
    const entries = Array.from({ length: 3000 }, (_, index) => ({
      type: "message",
      id: String(index),
      parentId: index ? String(index - 1) : null,
      message: { role: "user", content: `message ${index}` },
    }));
    const nodes = flattenEntries(entries);
    expect(nodes).toHaveLength(3000);
    expect(nodes[nodes.length - 1]?.depth).toBe(2999);
    expect(nodes[nodes.length - 1]?.preview).toBe("message 2999");
    expect(canForkNode({ ...nodes[0], id: "" })).toBe(false);
  });
});

describe("entryPreview", () => {
  test("extracts string content", () => {
    expect(
      entryPreview({
        type: "message",
        id: "a",
        message: { role: "user", content: "hello world" },
      }),
    ).toBe("hello world");
  });

  test("joins text parts of array content and collapses whitespace", () => {
    expect(
      entryPreview({
        type: "message",
        id: "b",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "line one" },
            { type: "image", url: "x" },
            { type: "text", text: "line\ntwo" },
          ],
        },
      }),
    ).toBe("line one line two");
  });

  test("falls back to entry.text", () => {
    expect(entryPreview({ type: "note", text: "a note" })).toBe("a note");
  });

  test("truncates long previews", () => {
    const out = entryPreview({
      message: { role: "user", content: "x".repeat(200) },
    });
    expect(out.length).toBe(121);
    expect(out.endsWith("…")).toBe(true);
  });

  test("handles missing entry", () => {
    expect(entryPreview(undefined)).toBe("");
    expect(entryPreview({})).toBe("");
  });
});

describe("flattenTree", () => {
  test("flattens nested nodes depth-first with depth and leaf flags", () => {
    const tree = [
      {
        entry: {
          type: "message",
          id: "1",
          message: { role: "user", content: "root" },
        },
        children: [
          {
            entry: {
              type: "message",
              id: "2",
              message: { role: "assistant", content: "child" },
            },
            label: "checkpoint",
            children: [
              {
                entry: {
                  type: "message",
                  id: "3",
                  message: { role: "user", content: "grandchild" },
                },
              },
            ],
          },
          {
            entry: {
              type: "message",
              id: "4",
              message: { role: "assistant", content: "sibling" },
            },
          },
        ],
      },
    ];
    const flat = flattenTree(tree);
    expect(flat.map((n) => n.id)).toEqual(["1", "2", "3", "4"]);
    expect(flat.map((n) => n.depth)).toEqual([0, 1, 2, 1]);
    expect(flat.map((n) => n.isLeaf)).toEqual([false, false, true, true]);
    expect(flat[1].label).toBe("checkpoint");
    expect(flat[2].role).toBe("user");
    expect(flat[2].preview).toBe("grandchild");
  });

  test("returns empty for empty tree", () => {
    expect(flattenTree([])).toEqual([]);
  });
});
