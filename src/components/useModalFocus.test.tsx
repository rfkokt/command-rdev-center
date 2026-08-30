// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { useModalFocus } from "./useModalFocus";

function Modal({
  onClose,
  active = true,
  empty = false,
}: {
  onClose: () => void;
  active?: boolean;
  empty?: boolean;
}) {
  const ref = useModalFocus<HTMLDivElement>(onClose, active);
  return (
    <div ref={ref} tabIndex={-1}>
      {!empty && (
        <>
          <button>First</button>
          <button>Last</button>
        </>
      )}
    </div>
  );
}

test("traps focus, closes with Escape, and restores trigger focus", () => {
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  let closed = false;
  const view = render(
    <Modal
      onClose={() => {
        closed = true;
      }}
    />,
  );
  const [first, last] = Array.from(view.container.querySelectorAll("button"));

  expect(document.activeElement).toBe(first);
  last.focus();
  fireEvent.keyDown(document, { key: "Tab" });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(closed).toBe(true);

  view.unmount();
  expect(document.activeElement).toBe(trigger);
  trigger.remove();
});

test("wraps reverse focus from first to last", () => {
  const view = render(<Modal onClose={vi.fn()} />);
  const [first, last] = Array.from(view.container.querySelectorAll("button"));

  first.focus();
  fireEvent.keyDown(document, { key: "Tab", shiftKey: true });

  expect(document.activeElement).toBe(last);
  view.unmount();
});

test("contains focus when the modal has no focusable descendants", () => {
  const view = render(<Modal onClose={vi.fn()} empty />);
  const modal = view.container.firstElementChild;

  expect(document.activeElement).toBe(modal);
  const event = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
  document.dispatchEvent(event);

  expect(event.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(modal);
  view.unmount();
});

test("does nothing while inactive and activates after rerender", () => {
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  const onClose = vi.fn();
  const view = render(<Modal onClose={onClose} active={false} />);

  expect(document.activeElement).toBe(trigger);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();

  view.rerender(<Modal onClose={onClose} active />);
  expect(document.activeElement).toBe(view.getByText("First"));

  view.unmount();
  trigger.remove();
});

test("only the topmost modal handles Escape", () => {
  const closeOuter = vi.fn();
  const closeInner = vi.fn();
  const view = render(
    <>
      <Modal onClose={closeOuter} />
      <Modal onClose={closeInner} />
    </>,
  );

  fireEvent.keyDown(document, { key: "Escape" });

  expect(closeInner).toHaveBeenCalledOnce();
  expect(closeOuter).not.toHaveBeenCalled();
  view.unmount();
});
