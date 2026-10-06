import { useState } from "react";
import { createRoot } from "react-dom/client";
import BackgroundMotion from "../src/components/BackgroundMotion";
import "./office-preview.css";

function Preview() {
  const [dark, setDark] = useState(true);
  const [blur, setBlur] = useState(false);
  const [status, setStatus] = useState("Idle · the team is at the studio");
  const activity = (name: string, detail: Record<string, unknown>) => {
    window.dispatchEvent(
      new CustomEvent(name, { detail: { tabId: "preview", ...detail } }),
    );
  };
  const tool = (name: string, args = {}) => {
    activity("crc-agent-activity", { type: "tool", toolName: name, args });
    setStatus(`Agent activity · ${name}`);
  };
  return (
    <>
      <BackgroundMotion activeTabId="preview" isBlurred={blur} />
      <header>
        <div>
          <strong>Kern Studio</strong>
          <span>Live office preview</span>
        </div>
        <div className="appearance">
          <a href="/dev/character.html">Character preview</a>
          <button
            onClick={() => {
              setDark(!dark);
              document.documentElement.dataset.theme = dark ? "light" : "dark";
            }}
          >
            {dark ? "Daylight" : "Evening"}
          </button>
          <button aria-pressed={blur} onClick={() => setBlur(!blur)}>
            Focus blur
          </button>
        </div>
      </header>
      <footer>
        <p>{status}</p>
        <nav aria-label="Simulate agent activity">
          <button
            onClick={() => {
              activity("crc-agent-prompt", { text: "Build the interface" });
              setStatus("Kern · planning the request");
            }}
          >
            Prompt
          </button>
          <button onClick={() => tool("read_file")}>Read</button>
          <button onClick={() => tool("search_graph")}>Search</button>
          <button onClick={() => tool("apply_patch")}>Edit</button>
          <button onClick={() => tool("bash", { command: "pnpm test" })}>
            Test
          </button>
          <button onClick={() => tool("bash", { command: "pnpm build" })}>
            Build
          </button>
          <button
            onClick={() => {
              activity("crc-agent-activity", {
                type: "agent_settled",
                isError: true,
              });
              setStatus("Finished with a notice");
            }}
          >
            Notice
          </button>
          <button
            onClick={() => {
              activity("crc-agent-activity", { type: "agent_settled" });
              setStatus("Idle · the team is at the studio");
            }}
          >
            Done
          </button>
        </nav>
      </footer>
    </>
  );
}
const root = createRoot(document.getElementById("root")!);
root.render(<Preview />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
