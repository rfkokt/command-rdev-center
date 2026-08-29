use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScmFile { pub path: String, pub index_status: String, pub worktree_status: String }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScmStatus { pub branch: String, pub upstream: Option<String>, pub ahead: u32, pub behind: u32, pub files: Vec<ScmFile> }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphCommit { pub hash: String, pub short_hash: String, pub parents: Vec<String>, pub lane: usize, pub subject: String, pub author: String, pub relative_time: String, pub refs: Vec<String> }

fn repository(path: &str) -> Result<PathBuf, String> {
    let requested = Path::new(path).canonicalize().map_err(|e| e.to_string())?;
    crate::projects::ensure_path_allowed(&requested)?;
    let root = crate::projects::verified_repository_root(&requested)?;
    if root != requested || !root.join(".git").is_file() { return Err("SCM path must be a registered chat worktree root".into()); }
    Ok(root)
}

fn run(path: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git").arg("-C").arg(path).args(args).output().map_err(|e| e.to_string())?;
    if output.status.success() { Ok(String::from_utf8_lossy(&output.stdout).into_owned()) }
    else { Err(String::from_utf8_lossy(&output.stderr).trim().to_string()) }
}

fn status(path: &Path) -> Result<ScmStatus, String> {
    let raw = run(path, &["status", "--porcelain=v1", "--branch", "--untracked-files=all"])?;
    let mut lines = raw.lines();
    let header = lines.next().unwrap_or("## HEAD").trim_start_matches("## ");
    let (tracking, counts) = header.split_once(" [").map(|(a,b)| (a, b.trim_end_matches(']'))).unwrap_or((header, ""));
    let (branch, upstream) = tracking.split_once("...").map(|(a,b)| (a.to_string(), Some(b.to_string()))).unwrap_or((tracking.to_string(), None));
    let mut ahead = 0; let mut behind = 0;
    for count in counts.split(", ") { if let Some(n)=count.strip_prefix("ahead ") { ahead=n.parse().unwrap_or(0); } if let Some(n)=count.strip_prefix("behind ") { behind=n.parse().unwrap_or(0); } }
    let files = lines.filter_map(|line| {
        let bytes=line.as_bytes(); if bytes.len()<4 { return None; }
        let path=line[3..].split(" -> ").last()?.to_string();
        Some(ScmFile { path, index_status: (bytes[0] as char).to_string(), worktree_status: (bytes[1] as char).to_string() })
    }).collect();
    Ok(ScmStatus { branch, upstream, ahead, behind, files })
}

fn mutate_paths(path: &Path, action: &str, paths: &[String]) -> Result<(), String> {
    if paths.iter().any(|p| p.is_empty() || Path::new(p).is_absolute() || p.split('/').any(|part| part == "..")) { return Err("invalid repository-relative path".into()); }
    match action {
        "stage" => { let mut c=Command::new("git"); c.arg("-C").arg(path).args(["add", "--"]); c.args(paths); command(c)?; }
        "unstage" => { let mut c=Command::new("git"); c.arg("-C").arg(path).args(["restore", "--staged", "--"]); c.args(paths); command(c)?; }
        "discard" => {
            let current=status(path)?;
            let tracked=paths.iter().filter(|p| current.files.iter().any(|f| &f.path==*p && f.worktree_status != "?" )).collect::<Vec<_>>();
            if !tracked.is_empty() { let mut c=Command::new("git"); c.arg("-C").arg(path).args(["restore", "--worktree", "--"]); c.args(tracked); command(c)?; }
            for p in paths.iter().filter(|p| current.files.iter().any(|f| &f.path==*p && f.worktree_status == "?")) { let target=path.join(p); if target.is_dir(){std::fs::remove_dir_all(target).map_err(|e|e.to_string())?}else if target.exists(){std::fs::remove_file(target).map_err(|e|e.to_string())?} }
        }
        _ => return Err("unsupported SCM path action".into())
    }
    Ok(())
}
fn command(mut command: Command) -> Result<(), String> { let out=command.output().map_err(|e|e.to_string())?; if out.status.success(){Ok(())}else{Err(String::from_utf8_lossy(&out.stderr).trim().to_string())} }

#[tauri::command] pub async fn scm_status(repository_path:String)->Result<ScmStatus,String>{tauri::async_runtime::spawn_blocking(move||status(&repository(&repository_path)?)).await.map_err(|e|e.to_string())?}
#[tauri::command] pub async fn scm_paths(repository_path:String,action:String,paths:Vec<String>)->Result<ScmStatus,String>{tauri::async_runtime::spawn_blocking(move||{let p=repository(&repository_path)?;mutate_paths(&p,&action,&paths)?;status(&p)}).await.map_err(|e|e.to_string())?}
#[tauri::command] pub async fn scm_all(repository_path:String,action:String)->Result<ScmStatus,String>{tauri::async_runtime::spawn_blocking(move||{let p=repository(&repository_path)?;match action.as_str(){"stage"=>{run(&p,&["add","--all"])?;},"unstage"=>{run(&p,&["restore","--staged","."])?;},_=>return Err("unsupported SCM all action".into())};status(&p)}).await.map_err(|e|e.to_string())?}
#[tauri::command] pub async fn scm_commit(repository_path:String,message:String)->Result<ScmStatus,String>{tauri::async_runtime::spawn_blocking(move||{if message.trim().is_empty(){return Err("commit message is required".into())}let p=repository(&repository_path)?;run(&p,&["commit","-m",message.trim()])?;status(&p)}).await.map_err(|e|e.to_string())?}
#[tauri::command] pub async fn scm_remote(repository_path:String,action:String)->Result<ScmStatus,String>{tauri::async_runtime::spawn_blocking(move||{let p=repository(&repository_path)?;match action.as_str(){"fetch"=>run(&p,&["fetch","--prune"]),"pull"=>run(&p,&["pull","--ff-only"]),"push"=>run(&p,&["push"]),"sync"=>{run(&p,&["pull","--ff-only"])?;run(&p,&["push"])} ,_=>Err("unsupported remote action".into())}?;status(&p)}).await.map_err(|e|e.to_string())?}
#[tauri::command] pub async fn scm_branches(repository_path:String)->Result<Vec<String>,String>{tauri::async_runtime::spawn_blocking(move||{let p=repository(&repository_path)?;Ok(run(&p,&["for-each-ref","--format=%(refname:short)","refs/heads"] )?.lines().map(str::to_string).collect())}).await.map_err(|e|e.to_string())?}
#[tauri::command] pub async fn scm_checkout(repository_path:String,branch:String,create:bool)->Result<ScmStatus,String>{tauri::async_runtime::spawn_blocking(move||{if branch.trim().is_empty()||branch.starts_with('-'){return Err("invalid branch name".into())}let p=repository(&repository_path)?;if create{run(&p,&["check-ref-format","--branch",&branch])?;run(&p,&["switch","-c",&branch])?;}else{run(&p,&["switch",&branch])?;}status(&p)}).await.map_err(|e|e.to_string())?}
#[tauri::command] pub async fn scm_graph(repository_path:String,limit:Option<usize>)->Result<Vec<GraphCommit>,String>{tauri::async_runtime::spawn_blocking(move||{let p=repository(&repository_path)?;let n=limit.unwrap_or(80).clamp(1,200).to_string();let raw=run(&p,&["log","--all","--date-order","--format=%H%x1f%h%x1f%P%x1f%s%x1f%an%x1f%ar%x1f%D","-n",&n])?;let mut lanes:Vec<String>=Vec::new();Ok(raw.lines().filter_map(|line|{let f=line.split('\x1f').collect::<Vec<_>>();if f.len()!=7{return None}let hash=f[0].to_string();let lane=lanes.iter().position(|h|h==&hash).unwrap_or_else(||{lanes.push(hash.clone());lanes.len()-1});let parents=f[2].split_whitespace().map(str::to_string).collect::<Vec<_>>();lanes.remove(lane);for parent in parents.iter().rev(){if !lanes.contains(parent){lanes.insert(lane,parent.clone())}}Some(GraphCommit{hash,short_hash:f[1].into(),parents,lane,subject:f[3].into(),author:f[4].into(),relative_time:f[5].into(),refs:f[6].split(',').map(str::trim).filter(|s|!s.is_empty()).map(str::to_string).collect()})}).collect())}).await.map_err(|e|e.to_string())?}
#[tauri::command] pub async fn scm_commit_details(repository_path:String,hash:String)->Result<String,String>{tauri::async_runtime::spawn_blocking(move||{if hash.len()!=40||!hash.bytes().all(|b|b.is_ascii_hexdigit()){return Err("invalid commit hash".into())}let p=repository(&repository_path)?;run(&p,&["show","--stat","--format=fuller","--no-renames","--no-color",&hash])}).await.map_err(|e|e.to_string())?}
#[tauri::command] pub async fn scm_commit_files(repository_path:String,hash:String)->Result<Vec<crate::diff::DiffFile>,String>{tauri::async_runtime::spawn_blocking(move||{if hash.len()!=40||!hash.bytes().all(|b|b.is_ascii_hexdigit()){return Err("invalid commit hash".into())}let p=repository(&repository_path)?;let names=run(&p,&["diff-tree","--root","--no-commit-id","--name-status","-r","--no-renames",&hash])?;names.lines().filter_map(|line|{let (status,path)=line.split_once('\t')?;Some((status.to_string(),path.to_string()))}).map(|(status,file)|{let patch=run(&p,&["show","--format=","--no-ext-diff","--no-renames",&hash,"--",&file])?;let added=patch.lines().filter(|line|line.starts_with('+')&&!line.starts_with("+++")).count() as u32;let removed=patch.lines().filter(|line|line.starts_with('-')&&!line.starts_with("---")).count() as u32;Ok(crate::diff::DiffFile{repository:String::new(),path:file,status,added,removed,patch})}).collect()}).await.map_err(|e|e.to_string())?}

#[cfg(test)] mod tests { use super::*; #[test] fn parses_status_groups(){let dir=std::env::temp_dir().join(format!("crc-scm-{}",std::process::id()));let _=std::fs::remove_dir_all(&dir);std::fs::create_dir_all(&dir).unwrap();run(&dir,&["init","-q"]).unwrap();run(&dir,&["config","user.email","x@y.z"]).unwrap();run(&dir,&["config","user.name","X"]).unwrap();std::fs::write(dir.join("a"),"a").unwrap();run(&dir,&["add","a"]).unwrap();run(&dir,&["commit","-qm","init"]).unwrap();std::fs::write(dir.join("a"),"b").unwrap();std::fs::write(dir.join("b"),"b").unwrap();let s=status(&dir).unwrap();assert!(s.files.iter().any(|f|f.path=="a"&&f.worktree_status=="M"));assert!(s.files.iter().any(|f|f.path=="b"&&f.worktree_status=="?"));let _=std::fs::remove_dir_all(dir);} }
