import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useModalFocus } from "./useModalFocus";
import SkillReader, {
  type SkillDocument,
  type SkillSource,
} from "./SkillReader";

type Source = SkillSource;
type PiSkill = SkillDocument & {
  manual_only: boolean;
  license?: string | null;
  metadata?: string | null;
  frontmatter: string;
};
type Catalog = { skills: PiSkill[]; sources: Source[] };
type Preview = {
  repository: string;
  reference: string;
  skills: PiSkill[];
  error?: string | null;
};
type InstallRequest = {
  url: string;
  reference?: string | null;
  path?: string | null;
  selectedPaths: string[];
  replace: boolean;
  sourceType?: string;
};

function InstallSkill({
  onClose,
  onInstalled,
}: {
  onClose: () => void;
  onInstalled: () => void;
}) {
  const ref = useModalFocus<HTMLElement>(onClose);
  const [tab, setTab] = useState<"git" | "skills">("git");
  const [url, setUrl] = useState("");
  const [reference, setReference] = useState("");
  const [path, setPath] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [replace, setReplace] = useState(false);
  const [status, setStatus] = useState("");
  const request = (): InstallRequest => ({
    url,
    reference: reference || null,
    path: path || null,
    selectedPaths: selected,
    replace,
    sourceType: tab === "skills" ? "skills.sh" : "git",
  });
  async function inspect() {
    setStatus("Cloning a read-only preview…");
    setPreview(null);
    try {
      const next = await invoke<Preview>("preview_git_skills", request());
      setPreview(next);
      setSelected(
        next.skills.length === 1 && next.skills[0].valid
          ? [next.skills[0].name]
          : [],
      );
      setStatus(
        next.skills.length
          ? "Review the selected SKILL.md before installing."
          : "No skills found.",
      );
    } catch (error) {
      setStatus(String(error));
    }
  }
  async function install() {
    setStatus("Installing selected skills…");
    try {
      const result = await invoke<{
        installed: string[];
        target: string;
        log: string[];
      }>("install_git_skills", request());
      setStatus(`Installed ${result.installed.join(", ")} to ${result.target}`);
      onInstalled();
    } catch (error) {
      setStatus(String(error));
    }
  }
  const canInstall = Boolean(
    preview &&
      selected.length &&
      selected.every(
        (name) => preview.skills.find((skill) => skill.name === name)?.valid,
      ),
  );
  return (
    <div className="settings-backdrop" onClick={onClose}>
      <section
        ref={ref}
        className="rag-preview-panel skill-install"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-install-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <small>UNTRUSTED SKILL SOURCE</small>
            <strong id="skill-install-title">Install Skill</strong>
            <span>
              Skills can instruct AI to run commands or scripts. Review SKILL.md
              before use.
            </span>
          </div>
          <button onClick={onClose} aria-label="Close install skill">
            ✕
          </button>
        </header>
        <main>
          <div className="skill-tabs">
            <button
              className={tab === "git" ? "active" : ""}
              onClick={() => setTab("git")}
            >
              Git Repository
            </button>
            <button
              className={tab === "skills" ? "active" : ""}
              onClick={() => setTab("skills")}
            >
              skills.sh
            </button>
          </div>
          {tab === "skills" && (
            <p className="settings-notice">
              skills.sh resolution is not available in this build. Enter the Git
              repository URL or shorthand supplied by skills.sh; no HTML
              scraping is performed.{" "}
              <a href="https://skills.sh" target="_blank" rel="noreferrer">
                Open skills.sh
              </a>
            </p>
          )}
          <label>
            Repository URL or owner/repository
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="owner/repository or https://github.com/owner/repository.git"
            />
          </label>
          <label>
            Branch, tag, or commit (optional)
            <input
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
          </label>
          <label>
            Skill path inside repository (optional)
            <input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="skills/interface-review"
            />
          </label>
          <button
            className="save-settings"
            disabled={!url.trim()}
            onClick={() => void inspect()}
          >
            Preview & validate
          </button>
          {preview && (
            <section className="skill-preview">
              <strong>
                {preview.repository} @ {preview.reference}
              </strong>
              {preview.skills.map((skill) => (
                <label key={skill.location}>
                  <input
                    type="checkbox"
                    checked={selected.includes(skill.name)}
                    disabled={!skill.valid}
                    onChange={() =>
                      setSelected((items) =>
                        items.includes(skill.name)
                          ? items.filter((item) => item !== skill.name)
                          : [...items, skill.name],
                      )
                    }
                  />
                  <span>
                    <b>{skill.name}</b> ·{" "}
                    {skill.description || skill.invalid_reason}
                    <code>{skill.location}</code>
                  </span>
                </label>
              ))}
            </section>
          )}
          {preview && (
            <label className="skill-replace">
              <input
                type="checkbox"
                checked={replace}
                onChange={(event) => setReplace(event.target.checked)}
              />{" "}
              Replace an existing same-name skill (backs up and restores if
              install fails)
            </label>
          )}
          {status && (
            <p className="skill-install-status" role="status">
              {status}
            </p>
          )}
        </main>
        <footer>
          <span>
            Clone is shallow, hook-free, and never runs skill scripts.
          </span>
          <button
            className="save-settings"
            disabled={!canInstall}
            onClick={() => void install()}
          >
            Install selected
          </button>
        </footer>
      </section>
    </div>
  );
}

export default function SkillsView() {
  const [catalog, setCatalog] = useState<Catalog>({ skills: [], sources: [] });
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [validity, setValidity] = useState("all");
  const [sourceId, setSourceId] = useState("all");
  const [visibility, setVisibility] = useState("all");
  const [selected, setSelected] = useState<PiSkill | null>(null);
  const [installing, setInstalling] = useState(false);
  const reload = useCallback(() => {
    setLoaded(false);
    invoke<Catalog>("list_pi_skills")
      .then((next) => {
        setCatalog(next);
        setError("");
      })
      .catch((reason) => setError(String(reason)))
      .finally(() => setLoaded(true));
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  const visible = useMemo(
    () =>
      catalog.skills.filter(
        (skill) =>
          (validity === "all" ||
            validity === (skill.valid ? "valid" : "invalid")) &&
          (sourceId === "all" || sourceId === skill.source_id) &&
          (visibility === "all" ||
            visibility === (skill.manual_only ? "manual" : "visible")) &&
          `${skill.name} ${skill.description}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
      ),
    [catalog.skills, query, sourceId, validity, visibility],
  );
  const validCount = catalog.skills.filter((skill) => skill.valid).length;
  const invalidCount = catalog.skills.length - validCount;
  const useSkill = (name: string) => {
    window.dispatchEvent(new CustomEvent("crc-use-skill", { detail: name }));
    setSelected(null);
  };
  return (
    <section
      className="pipeline-view skills-view"
      aria-label="Global Pi skills"
    >
      <header className="pipeline-header">
        <div>
          <small>LOCAL PI AGENT</small>
          <h1>Global Skills</h1>
          <p>
            {validCount} valid · {invalidCount} invalid · Local skill
            instructions discovered from Pi global directories and configured
            sources.
          </p>
        </div>
        <div className="skills-header-actions">
          <button
            className="save-settings"
            onClick={() => setSelected(null)}
            hidden
          >
            Close
          </button>
          <button className="save-settings" onClick={() => setInstalling(true)}>
            Install Skill
          </button>
          <button className="save-settings" onClick={reload} disabled={!loaded}>
            {loaded ? "Refresh" : "Scanning…"}
          </button>
        </div>
      </header>
      <section
        className="skills-sources"
        aria-label="Scanned skill directories"
      >
        {catalog.sources.map((source) => (
          <div key={source.id} className={source.readable ? "ok" : "error"}>
            <strong>{source.label}</strong>
            <code>{source.path}</code>
            <span>
              {source.readable ? "scanned" : source.error || "not readable"}
            </span>
          </div>
        ))}
      </section>
      {!loaded ? (
        <div className="pipeline-project-empty" role="status">
          <strong>Scanning global skills</strong>
          <span>Reading local Pi directories…</span>
        </div>
      ) : error ? (
        <div className="settings-error" role="alert">
          Could not scan skills: {error}
        </div>
      ) : (
        <>
          <div className="skills-filters">
            <label>
              Search
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Name or description"
              />
            </label>
            <label>
              Status
              <select
                value={validity}
                onChange={(event) => setValidity(event.target.value)}
              >
                <option value="all">All</option>
                <option value="valid">Valid</option>
                <option value="invalid">Invalid</option>
              </select>
            </label>
            <label>
              Source
              <select
                value={sourceId}
                onChange={(event) => setSourceId(event.target.value)}
              >
                <option value="all">All sources</option>
                {catalog.sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Invocation
              <select
                value={visibility}
                onChange={(event) => setVisibility(event.target.value)}
              >
                <option value="all">All</option>
                <option value="visible">Visible</option>
                <option value="manual">Manual only</option>
              </select>
            </label>
          </div>
          {catalog.skills.length === 0 ? (
            <div className="pipeline-project-empty">
              <strong>No global skills installed</strong>
              <span>
                No SKILL.md files were found in the scanned directories.
              </span>
            </div>
          ) : visible.length === 0 ? (
            <div className="pipeline-project-empty">
              <strong>No matching skills</strong>
              <span>Try changing the search or filters.</span>
            </div>
          ) : (
            <div className="pipeline-table-wrap">
              <table className="pipeline-table skills-table">
                <thead>
                  <tr>
                    <th>Skill</th>
                    <th>Description</th>
                    <th>Source</th>
                    <th>Command</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((skill) => {
                    const source = catalog.sources.find(
                      (item) => item.id === skill.source_id,
                    );
                    return (
                      <tr
                        key={skill.location}
                        className={skill.valid ? "" : "skill-invalid"}
                      >
                        <td>
                          <strong>{skill.name}</strong>
                          <div className="skill-badges">
                            {!skill.valid && <span>invalid</span>}
                            {skill.manual_only && <span>manual only</span>}
                            {skill.allowed_tools && <span>allowed tools</span>}
                            {skill.license && <span>{skill.license}</span>}
                          </div>
                        </td>
                        <td>
                          {skill.description ||
                            skill.invalid_reason ||
                            "No description"}
                        </td>
                        <td>
                          <span>{source?.label ?? skill.source_id}</span>
                          <code
                            className="skill-location"
                            title={skill.location}
                          >
                            {skill.location}
                          </code>
                        </td>
                        <td>
                          <code>/skill:{skill.name}</code>
                        </td>
                        <td>
                          <button onClick={() => setSelected(skill)}>
                            View
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {selected && (
        <SkillReader
          skill={selected}
          source={catalog.sources.find(
            (source) => source.id === selected.source_id,
          )}
          onClose={() => setSelected(null)}
          onUse={useSkill}
        />
      )}
      {installing && (
        <InstallSkill
          onClose={() => setInstalling(false)}
          onInstalled={() => {
            setInstalling(false);
            reload();
          }}
        />
      )}
    </section>
  );
}
