use serde::Deserialize;
use std::path::{Component, Path};

#[derive(Debug, Deserialize, serde::Serialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Setup {
    #[serde(default)]
    copy: Vec<String>,
    #[serde(default)]
    commands: Vec<String>,
}
fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && Path::new(path)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}
fn config(root: &Path) -> Result<Setup, String> {
    let path = root.join("kern.yaml");
    if !path.exists() {
        return Ok(Setup::default());
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() > 65_536 {
        return Err("kern.yaml exceeds 64 KB".into());
    }
    let setup: Setup = serde_yaml::from_slice(&bytes).map_err(|e| format!("kern.yaml: {e}"))?;
    if setup.copy.len() > 100
        || setup.commands.len() > 20
        || setup.copy.iter().any(|path| !safe_relative(path))
        || setup
            .commands
            .iter()
            .any(|command| command.trim().is_empty() || command.len() > 8000)
    {
        return Err(
            "Invalid kern.yaml setup: relative file paths only, max 100 copies / 20 commands"
                .into(),
        );
    }
    Ok(setup)
}
fn roots(
    project: &str,
    worktree: &str,
) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let project = Path::new(project)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let worktree = Path::new(worktree)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    crate::projects::ensure_path_allowed(&project)?;
    crate::projects::ensure_path_allowed(&worktree)?;
    if project == worktree {
        return Err("Setup requires a separate worktree".into());
    }
    Ok((project, worktree))
}
#[tauri::command]
pub async fn inspect_worktree_setup(project: String, worktree: String) -> Result<Setup, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (root, _) = roots(&project, &worktree)?;
        config(&root)
    })
    .await
    .map_err(|e| e.to_string())?
}
/// What the frontend runs next: the copy log, and a script to execute in the
/// chat terminal (absent when kern.yaml lists no commands).
#[derive(Debug, serde::Serialize)]
pub struct PreparedSetup {
    copied: String,
    script: Option<String>,
}

fn git_common_dir(path: &Path) -> Result<std::path::PathBuf, String> {
    let result = std::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .output()
        .map_err(|e| e.to_string())?;
    if !result.status.success() {
        return Err("Setup requires related Git worktrees".into());
    }
    Path::new(String::from_utf8_lossy(&result.stdout).trim())
        .canonicalize()
        .map_err(|e| e.to_string())
}

/// Copy listed files from the project into the worktree. Never follows a
/// destination symlink, never overwrites, never leaves the worktree.
fn copy_files(root: &Path, target: &Path, files: &[String]) -> Result<String, String> {
    use std::io::Write;
    let mut output = String::new();
    for file in files {
        let source = match root.join(file).canonicalize() {
            Ok(source) => source,
            Err(_) => {
                output.push_str(&format!("Missing {file} in project, skipped\n"));
                continue;
            }
        };
        if !source.starts_with(root) || !source.is_file() {
            return Err(format!(
                "Setup copy source {file} must be a file inside the project"
            ));
        }
        let destination = target.join(file);
        if destination.symlink_metadata().is_ok() {
            output.push_str(&format!("Skipped existing {file}\n"));
            continue;
        }
        let parent = destination.parent().ok_or("Missing parent")?;
        let mut ancestor = parent;
        while !ancestor.exists() {
            ancestor = ancestor.parent().ok_or("Invalid setup destination")?;
        }
        if !ancestor
            .canonicalize()
            .map_err(|e| e.to_string())?
            .starts_with(target)
        {
            return Err("Setup destination escapes worktree".into());
        }
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        if !parent
            .canonicalize()
            .map_err(|e| e.to_string())?
            .starts_with(target)
        {
            return Err("Setup destination escapes worktree".into());
        }
        let bytes = std::fs::read(&source).map_err(|e| e.to_string())?;
        let mut saved = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
            .map_err(|e| e.to_string())?;
        saved.write_all(&bytes).map_err(|e| e.to_string())?;
        output.push_str(&format!("Copied {file}\n"));
    }
    Ok(output)
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// The setup script: stop at the first failing command, like Orca's setup
/// runner. It runs in the chat's interactive terminal, so output streams live
/// and the user can interrupt it; a failure never touches the agent.
fn setup_script(target: &Path, commands: &[String]) -> String {
    let mut script = String::from("#!/bin/sh\nset -e\n");
    script.push_str(&format!("cd {}\n", shell_quote(&target.to_string_lossy())));
    script.push_str("echo '[kern] worktree setup (kern.yaml)'\n");
    for command in commands {
        script.push_str(&format!("echo {}\n", shell_quote(&format!("$ {command}"))));
        script.push_str(command);
        script.push('\n');
    }
    script.push_str("echo '[kern] worktree setup finished'\n");
    script
}

fn write_script(script: &str) -> Result<std::path::PathBuf, String> {
    use std::io::Write;
    let dir = std::env::temp_dir().join("kern-worktree-setup");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!(
        "setup-{}-{}.sh",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o700);
    }
    let mut file = options.open(&path).map_err(|e| e.to_string())?;
    file.write_all(script.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(path)
}

/// Copy files now and hand back the command script for the chat terminal.
/// `approved_setup` must equal the config the user reviewed, so an edited
/// kern.yaml is never run on an old approval.
#[tauri::command]
pub async fn prepare_worktree_setup(
    project: String,
    worktree: String,
    approved_setup: String,
) -> Result<PreparedSetup, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (root, target) = roots(&project, &worktree)?;
        let setup = config(&root)?;
        if serde_json::to_string(&setup).map_err(|e| e.to_string())? != approved_setup {
            return Err("kern.yaml changed; review setup again".into());
        }
        if git_common_dir(&root)? != git_common_dir(&target)? {
            return Err("Worktree does not belong to this project".into());
        }
        let copied = copy_files(&root, &target, &setup.copy)?;
        let script = if setup.commands.is_empty() {
            None
        } else {
            Some(
                write_script(&setup_script(&target, &setup.commands))?
                    .to_string_lossy()
                    .into_owned(),
            )
        };
        Ok(PreparedSetup { copied, script })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temp(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kern-setup-test-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn copies_files_without_overwriting_or_escaping() {
        let root = temp("root");
        let target = temp("target");
        std::fs::write(root.join(".env"), "A=1").unwrap();
        std::fs::create_dir_all(root.join("config")).unwrap();
        std::fs::write(root.join("config/local.env"), "B=2").unwrap();
        std::fs::write(target.join("keep.txt"), "mine").unwrap();
        std::fs::write(root.join("keep.txt"), "theirs").unwrap();
        let log = copy_files(
            &root,
            &target,
            &[
                ".env".into(),
                "config/local.env".into(),
                "keep.txt".into(),
                "absent.env".into(),
            ],
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(target.join(".env")).unwrap(), "A=1");
        assert_eq!(
            std::fs::read_to_string(target.join("config/local.env")).unwrap(),
            "B=2"
        );
        assert_eq!(
            std::fs::read_to_string(target.join("keep.txt")).unwrap(),
            "mine"
        );
        assert!(log.contains("Skipped existing keep.txt"));
        assert!(log.contains("Missing absent.env"));
        #[cfg(unix)]
        {
            let outside = temp("outside");
            std::fs::write(outside.join("secret"), "x").unwrap();
            std::os::unix::fs::symlink(outside.join("secret"), root.join("link")).unwrap();
            assert!(copy_files(&root, &target, &["link".into()]).is_err());
            std::os::unix::fs::symlink(&outside, target.join("out")).unwrap();
            std::fs::write(root.join("x.env"), "y").unwrap();
            std::fs::create_dir_all(root.join("out")).unwrap();
            std::fs::write(root.join("out/x.env"), "y").unwrap();
            assert!(copy_files(&root, &target, &["out/x.env".into()]).is_err());
            assert!(!outside.join("x.env").exists());
            let _ = std::fs::remove_dir_all(outside);
        }
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(target);
    }

    #[test]
    fn script_stops_on_failure_and_quotes_the_worktree() {
        let script = setup_script(
            Path::new("/tmp/it's here"),
            &["pnpm install".into(), "false".into(), "echo never".into()],
        );
        assert!(script.contains("set -e"));
        assert!(script.contains("cd '/tmp/it'\\''s here'"));
        #[cfg(unix)]
        {
            let dir = temp("script");
            let script = setup_script(
                &dir,
                &[
                    "echo one > out.txt".into(),
                    "false".into(),
                    "echo two >> out.txt".into(),
                ],
            );
            let path = write_script(&script).unwrap();
            let status = std::process::Command::new("sh")
                .arg(&path)
                .status()
                .unwrap();
            assert!(!status.success());
            assert_eq!(
                std::fs::read_to_string(dir.join("out.txt")).unwrap(),
                "one\n"
            );
            let _ = std::fs::remove_file(path);
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn rejects_escaping_copy_paths() {
        assert!(safe_relative(".env"));
        assert!(safe_relative("config/local.env"));
        assert!(!safe_relative("../.env"));
        assert!(!safe_relative("/tmp/env"));
        assert!(!safe_relative(""));
    }
}
