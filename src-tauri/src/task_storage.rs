use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

fn resolve_task_dir(
    override_path: Option<OsString>,
    project_root: &Path,
) -> Result<PathBuf, String> {
    if let Some(path) = override_path {
        return Ok(PathBuf::from(path));
    }
    Ok(project_root
        .parent()
        .ok_or("project root has no parent")?
        .join("Task All Project"))
}

pub fn task_dir() -> Result<PathBuf, String> {
    resolve_task_dir(
        std::env::var_os("CRC_TASK_DIR"),
        &super::projects::project_root()?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn override_is_authoritative() {
        assert_eq!(
            resolve_task_dir(Some("/tmp/tasks".into()), Path::new("/projects")),
            Ok(PathBuf::from("/tmp/tasks"))
        );
    }

    #[test]
    fn defaults_next_to_project_root() {
        assert_eq!(
            resolve_task_dir(None, Path::new("/Volumes/Project")),
            Ok(PathBuf::from("/Volumes/Task All Project"))
        );
    }
}
