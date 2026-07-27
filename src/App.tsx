import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type Config = {
  pi_path: string;
  project_root: string;
  default_provider: string;
  default_model: string;
  default_thinking: string;
};

function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<Config>("get_config").then(setConfig).catch((e) => setError(String(e)));
  }, []);

  return (
    <main className="container">
      <h1>Command rdev Center</h1>
      {error && <p style={{ color: "tomato" }}>Config error: {error}</p>}
      {!config && !error && <p>Loading config…</p>}
      {config && (
        <div className="row" style={{ flexDirection: "column", alignItems: "flex-start" }}>
          <p>pi: <code>{config.pi_path}</code></p>
          <p>root: <code>{config.project_root}</code></p>
          <p>model: <code>{config.default_model}</code> · thinking: <code>{config.default_thinking}</code></p>
        </div>
      )}
    </main>
  );
}

export default App;
