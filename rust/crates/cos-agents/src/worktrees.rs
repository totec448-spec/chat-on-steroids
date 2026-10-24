//! Marker-verified Git worktrees for isolated workers (`main/worktrees/index.ts`).
//!
//! One deterministic slot per proven broker identity:
//! `<approved parent>/.chat-on-steroids-worktrees/<repo key>/<run id>/<worker-N>/` holds `tree`
//! (the worktree on branch `cos/worktrees/<run>/<worker-N>`), `hooks` (an empty hooks folder
//! Git runs instead of the repository's own) and `owner.json` (the marker, written exclusively).
//! A marker is data until its slot, branch, repository and directory identities all prove the
//! same owner; it never grants authority on its own, so startup restore only adopts identities
//! the durable broker still holds. The source checkout is never reset, cleaned or changed.
//!
//! Every function here blocks on Git and the file system. Call them on the blocking pool.

use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use cos_types::config::Root;
use cos_types::json::Extra;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::broker::{is_allocation_uuid, random_uuid};

const MANAGED_FOLDER: &str = ".chat-on-steroids-worktrees";
const MAX_GIT_BYTES: usize = 4 * 1024 * 1024;
const MAX_STATUS: usize = 2_000;
const GIT_TIMEOUT: Duration = Duration::from_secs(20);

/// A worktree refusal. The code is the model-facing part; the message may name local paths
/// and belongs in the log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorktreeError {
    pub code: &'static str,
    pub message: String,
}

impl WorktreeError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for WorktreeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for WorktreeError {}

impl From<io::Error> for WorktreeError {
    fn from(error: io::Error) -> Self {
        Self::new("WORKTREE_IO", error.to_string())
    }
}

type Result<T> = std::result::Result<T, WorktreeError>;

/// A folder as the sandbox sees it: its native path and its virtual `/<root>/...` path.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Workspace {
    pub real: String,
    #[serde(rename = "virtual")]
    pub virtual_path: String,
}

/// `WorkerWorktreeLease`, and with `ownerDir`, `markerPath` and `hooksPath` the marker.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub version: u64,
    pub run_id: String,
    pub agent_id: String,
    pub ownership_token: String,
    pub source_repo_root: String,
    pub common_dir: String,
    pub worktree_path: String,
    pub workspace: Workspace,
    pub branch: String,
    pub branch_ref: String,
    pub base_oid: String,
    /// Stable file-system identity, so a reused path does not inherit a prior owner's lease.
    pub tree_identity: String,
    pub workspace_identity: String,
    pub approved_root: Root,
    pub source_dirty: bool,
    pub created_at: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Marker {
    #[serde(flatten)]
    lease: Lease,
    owner_dir: String,
    marker_path: String,
    hooks_path: String,
    #[serde(flatten)]
    extra: Extra,
}

/// What [`Worktrees::allocate`] found or made.
#[derive(Clone, Debug, PartialEq)]
pub struct Allocated {
    pub lease: Lease,
    /// Only the call that ran `git worktree add` may retire the checkout after a failed spawn.
    pub newly_created: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Restored {
    pub restored: Vec<Lease>,
    pub rejected: Vec<(String, String)>,
}

/// The live leases of this process, keyed by `<run id>:<worker-N>`.
#[derive(Default)]
pub struct Worktrees {
    live: Mutex<HashMap<String, Lease>>,
}

fn key_of(run_id: &str, agent_id: &str) -> String {
    format!("{}:{agent_id}", run_id.to_ascii_lowercase())
}

fn is_agent_id(value: &str) -> bool {
    value.strip_prefix("worker-").is_some_and(|n| {
        (1..=6).contains(&n.len()) && !n.starts_with('0') && n.bytes().all(|b| b.is_ascii_digit())
    })
}

fn checked_identity(run_id: &str, agent_id: &str) -> Result<(String, String)> {
    if !is_allocation_uuid(run_id) {
        return Err(WorktreeError::new(
            "WORKTREE_IDENTITY_INVALID",
            "runId must be the proven broker UUID",
        ));
    }
    if !is_agent_id(agent_id) {
        return Err(WorktreeError::new(
            "WORKTREE_IDENTITY_INVALID",
            "agentId must be a proven worker-N identity",
        ));
    }
    Ok((run_id.to_ascii_lowercase(), agent_id.to_owned()))
}

fn is_oid(value: &str) -> bool {
    (40..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

struct GitOutput {
    code: i32,
    stdout: Vec<u8>,
    stderr: String,
}

impl GitOutput {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).replace('\r', "")
    }
}

/// Runs Git with a clean environment, no prompt, a byte cap and a deadline.
fn git(cwd: &Path, args: &[&str]) -> Result<GitOutput> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (name, _) in std::env::vars_os() {
        if name
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("GIT_")
        {
            command.env_remove(name);
        }
    }
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_NO_REPLACE_OBJECTS", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: no console flashes for a background Git call.
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn()?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| WorktreeError::new("WORKTREE_GIT", "no stdout"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| WorktreeError::new("WORKTREE_GIT", "no stderr"))?;
    let out = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = (&mut stdout)
            .take(MAX_GIT_BYTES as u64 + 1)
            .read_to_end(&mut bytes);
        bytes
    });
    let err = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = (&mut stderr).take(64 * 1024).read_to_end(&mut bytes);
        bytes
    });
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() > GIT_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err(WorktreeError::new(
                "WORKTREE_GIT_TIMEOUT",
                "Git took too long to respond",
            ));
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let stdout = out.join().unwrap_or_default();
    if stdout.len() > MAX_GIT_BYTES {
        return Err(WorktreeError::new(
            "WORKTREE_GIT_OUTPUT",
            "Git returned too much data",
        ));
    }
    let stderr = String::from_utf8_lossy(&err.join().unwrap_or_default())
        .trim()
        .to_owned();
    Ok(GitOutput {
        code: status.code().unwrap_or(-1),
        stdout,
        stderr,
    })
}

fn safe_git_args<'a>(hooks: &'a str, args: &[&'a str]) -> Vec<String> {
    let mut all = vec![
        "-c".to_owned(),
        format!("core.hooksPath={hooks}"),
        "-c".to_owned(),
        "commit.gpgSign=false".to_owned(),
        "-c".to_owned(),
        "merge.gpgSign=false".to_owned(),
        "-c".to_owned(),
        "core.pager=cat".to_owned(),
        "-c".to_owned(),
        "color.ui=false".to_owned(),
        "-c".to_owned(),
        "diff.external=".to_owned(),
    ];
    all.extend(args.iter().map(|arg| (*arg).to_owned()));
    all
}

fn git_safe(cwd: &Path, hooks: &str, args: &[&str]) -> Result<GitOutput> {
    let all = safe_git_args(hooks, args);
    let refs: Vec<&str> = all.iter().map(String::as_str).collect();
    git(cwd, &refs)
}

/// `fs.realpath`, without Windows' verbatim prefix so paths stay comparable with TypeScript's.
fn real(path: &Path) -> io::Result<PathBuf> {
    let resolved = fs::canonicalize(path)?;
    let text = resolved.to_string_lossy();
    Ok(if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{unc}"))
    } else if let Some(local) = text.strip_prefix(r"\\?\") {
        PathBuf::from(local)
    } else {
        resolved
    })
}

fn real_directory(path: &Path) -> Result<PathBuf> {
    let resolved = real(path)?;
    if !fs::metadata(&resolved)?.is_dir() {
        return Err(WorktreeError::new(
            "WORKTREE_PATH_INVALID",
            format!("{} is not a directory", path.display()),
        ));
    }
    Ok(resolved)
}

/// Lexical `path.resolve` for comparison: one separator style, no trailing separator, and on
/// Windows no case.
fn normal(path: &str) -> String {
    let mut text = if cfg!(windows) {
        path.replace('/', "\\").to_lowercase()
    } else {
        path.to_owned()
    };
    while text.len() > 1 && (text.ends_with('\\') || text.ends_with('/')) && !text.ends_with(":\\")
    {
        text.pop();
    }
    text
}

fn same(a: &str, b: &str) -> bool {
    normal(a) == normal(b)
}

/// `isContained(root, path)`: the path is the root or below it.
fn contained(root: &Path, path: &Path) -> bool {
    let (root, path) = (
        normal(&root.to_string_lossy()),
        normal(&path.to_string_lossy()),
    );
    let separator = if cfg!(windows) { '\\' } else { '/' };
    path == root
        || path
            .strip_prefix(&root)
            .is_some_and(|rest| rest.starts_with(separator) || root.ends_with(separator))
}

fn text_of(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// `dev:ino` of a real directory, the same numbers Node's `lstat` reports.
fn directory_identity(path: &Path) -> Result<String> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(WorktreeError::new(
            "WORKTREE_PATH_CHANGED",
            "managed directory has no reliable ownership identity",
        ));
    }
    let (dev, ino) = file_identity(path)?;
    if ino == 0 {
        return Err(WorktreeError::new(
            "WORKTREE_PATH_CHANGED",
            "managed directory has no reliable ownership identity",
        ));
    }
    Ok(format!("{dev}:{ino}"))
}

#[cfg(unix)]
fn file_identity(path: &Path) -> io::Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::symlink_metadata(path)?;
    Ok((metadata.dev(), metadata.ino()))
}

#[cfg(windows)]
fn file_identity(path: &Path) -> io::Result<(u64, u64)> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        GetFileInformationByHandle,
    };
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: the handle is open for the duration of the call and `info` is a valid,
    // writable BY_HANDLE_FILE_INFORMATION the call fills.
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let ino = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
    Ok((u64::from(info.dwVolumeSerialNumber), ino))
}

struct Resolved {
    root: Root,
    real: PathBuf,
}

fn roots_of(approved: &[Root]) -> Result<Vec<Resolved>> {
    let mut result = Vec::new();
    for root in approved {
        if root.name.is_empty() || root.name.contains(['/', '\\']) {
            return Err(WorktreeError::new(
                "WORKTREE_ROOT_INVALID",
                "approved root has an invalid virtual name",
            ));
        }
        // An unrelated approved folder may be offline; only existing roots can own a lease.
        if let Ok(real) = real_directory(Path::new(&root.path)) {
            result.push(Resolved {
                root: root.clone(),
                real,
            });
        }
    }
    if result.is_empty() {
        return Err(WorktreeError::new(
            "WORKTREE_ROOT_REQUIRED",
            "no approved root can own a worker worktree",
        ));
    }
    Ok(result)
}

fn contained_by_any(roots: &[Resolved], path: &Path) -> bool {
    roots.iter().any(|root| contained(&root.real, path))
}

fn same_approved_root(approved: &Resolved, original: &Root) -> bool {
    approved.root.name == original.name && same(&approved.root.path, &original.path)
}

struct Repository {
    cwd: PathBuf,
    root: PathBuf,
    common_dir: PathBuf,
}

fn repository(cwd: &Path, roots: &[Resolved]) -> Result<Repository> {
    let cwd = real_directory(cwd)?;
    if !contained_by_any(roots, &cwd) {
        return Err(WorktreeError::new(
            "WORKTREE_OUTSIDE_ROOT",
            "workspace is outside the approved roots",
        ));
    }
    let found = git(
        &cwd,
        &[
            "rev-parse",
            "--show-toplevel",
            "--absolute-git-dir",
            "--git-common-dir",
        ],
    )?;
    if found.code != 0 {
        return Err(WorktreeError::new(
            "WORKTREE_NOT_REPOSITORY",
            if found.stderr.is_empty() {
                "workspace is not a Git repository".to_owned()
            } else {
                found.stderr
            },
        ));
    }
    let text = found.text();
    let lines: Vec<&str> = text.trim_end().split('\n').collect();
    let [root, git_dir, common, ..] = lines.as_slice() else {
        return Err(WorktreeError::new(
            "WORKTREE_REPOSITORY_INVALID",
            "Git returned an incomplete repository identity",
        ));
    };
    let root = real(&cwd.join(root))?;
    let git_dir = real(&cwd.join(git_dir))?;
    let common_dir = real(&cwd.join(common))?;
    if ![&root, &git_dir, &common_dir]
        .iter()
        .all(|path| contained_by_any(roots, path))
    {
        return Err(WorktreeError::new(
            "WORKTREE_METADATA_OUTSIDE_ROOT",
            "Git repository metadata is outside the approved roots",
        ));
    }
    if !contained(&root, &cwd) {
        return Err(WorktreeError::new(
            "WORKTREE_OUTSIDE_REPOSITORY",
            "workspace is outside its Git worktree",
        ));
    }
    Ok(Repository {
        cwd,
        root,
        common_dir,
    })
}

/// `git status --porcelain=v1 -z`: HEAD and whether anything is changed.
pub fn status(cwd: &Path) -> Result<(String, Vec<String>)> {
    let head = git(cwd, &["rev-parse", "--verify", "HEAD^{commit}"])?;
    let oid = head.text().trim().to_owned();
    if head.code != 0 || !is_oid(&oid) {
        return Err(WorktreeError::new(
            "WORKTREE_HEAD_INVALID",
            "Git HEAD is unavailable",
        ));
    }
    let listed = git(
        cwd,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    if listed.code != 0 {
        return Err(WorktreeError::new("WORKTREE_STATUS_FAILED", listed.stderr));
    }
    let text = listed.text();
    let parts: Vec<&str> = text.split('\0').filter(|part| !part.is_empty()).collect();
    let mut changes = Vec::new();
    let mut index = 0;
    while index < parts.len() && changes.len() < MAX_STATUS {
        let record = parts[index];
        if record.len() >= 4 {
            changes.push(record[3..].to_owned());
            let bytes = record.as_bytes();
            if matches!(bytes[0], b'R' | b'C') || matches!(bytes[1], b'R' | b'C') {
                index += 1;
            }
        }
        index += 1;
    }
    Ok((oid, changes))
}

fn ensure_tree(root: &Path, segments: &[&str]) -> Result<PathBuf> {
    let mut current = root.to_owned();
    for segment in segments {
        current = current.join(segment);
        match fs::create_dir(&current) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        let found = fs::symlink_metadata(&current)?;
        if found.file_type().is_symlink() || !found.is_dir() {
            return Err(WorktreeError::new(
                "WORKTREE_STORAGE_UNSAFE",
                format!("{} is not an owned directory", current.display()),
            ));
        }
        let resolved = real(&current)?;
        if !contained(root, &resolved) {
            return Err(WorktreeError::new(
                "WORKTREE_STORAGE_ESCAPE",
                "managed worktree storage escaped its approved root",
            ));
        }
        current = resolved;
    }
    Ok(current)
}

fn repo_key(common_dir: &str) -> String {
    let digest = Sha256::digest(common_dir.as_bytes());
    digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn managed_root_for<'a>(repo: &Repository, roots: &'a [Resolved]) -> Result<&'a Resolved> {
    let mut candidates: Vec<&Resolved> = roots
        .iter()
        .filter(|entry| {
            contained(&entry.real, &repo.root)
                && contained(&entry.real, &repo.common_dir)
                && !contained(&repo.root, &entry.real.join(MANAGED_FOLDER))
        })
        .collect();
    candidates.sort_by_key(|entry| std::cmp::Reverse(entry.real.as_os_str().len()));
    candidates.first().copied().ok_or_else(|| {
        WorktreeError::new(
            "WORKTREE_STORAGE_UNAVAILABLE",
            "automatic worktrees need an approved parent of the repository so managed worktrees do not dirty the source repository",
        )
    })
}

fn virtual_path(root: &Root, root_real: &Path, real: &Path) -> Result<String> {
    let relative = real
        .strip_prefix(root_real)
        .ok()
        .filter(|relative| !relative.as_os_str().is_empty())
        .ok_or_else(|| {
            WorktreeError::new(
                "WORKTREE_VIRTUAL_PATH_INVALID",
                "managed workspace is not below its approved virtual root",
            )
        })?;
    let parts: Vec<String> = relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect();
    Ok(format!("/{}/{}", root.name, parts.join("/")))
}

fn expected_branch(run_id: &str, agent_id: &str) -> (String, String) {
    let branch = format!("cos/worktrees/{}/{agent_id}", run_id.replace('-', ""));
    let reference = format!("refs/heads/{branch}");
    (branch, reference)
}

fn read_marker(path: &Path) -> Result<Option<Marker>> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let marker: Marker = serde_json::from_str(&text).map_err(|_| {
        WorktreeError::new(
            "WORKTREE_OWNER_INVALID",
            "managed worktree ownership marker is invalid",
        )
    })?;
    let lease = &marker.lease;
    let valid = lease.version == 1
        && is_allocation_uuid(&lease.run_id)
        && is_agent_id(&lease.agent_id)
        && lease.ownership_token.len() == 36
        && is_oid(&lease.base_oid)
        && [&lease.tree_identity, &lease.workspace_identity]
            .iter()
            .all(|identity| {
                identity.split_once(':').is_some_and(|(dev, ino)| {
                    [dev, ino]
                        .iter()
                        .all(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
                })
            });
    if !valid {
        return Err(WorktreeError::new(
            "WORKTREE_OWNER_INVALID",
            "managed worktree ownership marker is invalid",
        ));
    }
    Ok(Some(marker))
}

fn marker_matches(marker: &Marker, lease: &Lease) -> bool {
    let theirs = &marker.lease;
    theirs.run_id == lease.run_id
        && theirs.agent_id == lease.agent_id
        && theirs.ownership_token == lease.ownership_token
        && same(&theirs.source_repo_root, &lease.source_repo_root)
        && same(&theirs.common_dir, &lease.common_dir)
        && same(&theirs.worktree_path, &lease.worktree_path)
        && same(&theirs.workspace.real, &lease.workspace.real)
        && theirs.workspace.virtual_path == lease.workspace.virtual_path
        && theirs.branch == lease.branch
        && theirs.branch_ref == lease.branch_ref
        && theirs.base_oid == lease.base_oid
        && theirs.tree_identity == lease.tree_identity
        && theirs.workspace_identity == lease.workspace_identity
        && theirs.created_at == lease.created_at
        && theirs.approved_root.name == lease.approved_root.name
        && same(&theirs.approved_root.path, &lease.approved_root.path)
}

/// A marker is data until its whole deterministic slot is proven.
fn assert_slot(marker: &Marker, marker_path: &Path) -> Result<()> {
    let owner = marker_path.parent().unwrap_or(marker_path);
    let lease = &marker.lease;
    let (branch, branch_ref) = expected_branch(&lease.run_id, &lease.agent_id);
    let name = |path: Option<&Path>| {
        path.and_then(Path::file_name)
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    let run_dir = owner.parent();
    let repo_dir = run_dir.and_then(Path::parent);
    let managed = repo_dir.and_then(Path::parent);
    let ok = same(&marker.owner_dir, &text_of(owner))
        && same(&marker.marker_path, &text_of(marker_path))
        && same(&marker.hooks_path, &text_of(&owner.join("hooks")))
        && same(&lease.worktree_path, &text_of(&owner.join("tree")))
        && lease.branch == branch
        && lease.branch_ref == branch_ref
        && name(Some(owner)) == lease.agent_id
        && name(run_dir) == lease.run_id
        && name(repo_dir) == repo_key(&lease.common_dir)
        && name(managed) == MANAGED_FOLDER
        && contained(
            Path::new(&lease.worktree_path),
            Path::new(&lease.workspace.real),
        );
    if ok {
        Ok(())
    } else {
        Err(WorktreeError::new(
            "WORKTREE_OWNER_INVALID",
            "ownership marker does not match its deterministic managed slot",
        ))
    }
}

fn marker_for(lease: &Lease) -> Result<Marker> {
    let owner = Path::new(&lease.worktree_path).parent().ok_or_else(|| {
        WorktreeError::new(
            "WORKTREE_NOT_OWNED",
            "worktree ownership could not be proven",
        )
    })?;
    let path = owner.join("owner.json");
    let marker = read_marker(&path)?.ok_or_else(|| {
        WorktreeError::new(
            "WORKTREE_NOT_OWNED",
            "worktree ownership could not be proven",
        )
    })?;
    assert_slot(&marker, &path)?;
    if !marker_matches(&marker, lease) {
        return Err(WorktreeError::new(
            "WORKTREE_NOT_OWNED",
            "worktree ownership could not be proven",
        ));
    }
    Ok(marker)
}

fn identities_hold(marker: &Marker, lease: &Lease, during: bool) -> Result<()> {
    if directory_identity(Path::new(&marker.lease.worktree_path))? != lease.tree_identity
        || directory_identity(Path::new(&marker.lease.workspace.real))? != lease.workspace_identity
    {
        return Err(WorktreeError::new(
            "WORKTREE_PATH_CHANGED",
            if during {
                "owned Git worktree or project folder changed during validation"
            } else {
                "owned Git worktree or project folder was replaced"
            },
        ));
    }
    Ok(())
}

/// The marker, both directory identities, the branch and the repository all name this lease.
fn assert_owned(lease: &Lease) -> Result<Marker> {
    let marker = marker_for(lease)?;
    identities_hold(&marker, lease, false)?;
    let tree = real_directory(Path::new(&marker.lease.worktree_path))?;
    if !same(&text_of(&tree), &marker.lease.worktree_path) {
        return Err(WorktreeError::new(
            "WORKTREE_PATH_CHANGED",
            "owned worktree path changed",
        ));
    }
    let workspace = real_directory(Path::new(&marker.lease.workspace.real))?;
    if !same(&text_of(&workspace), &marker.lease.workspace.real) || !contained(&tree, &workspace) {
        return Err(WorktreeError::new(
            "WORKTREE_PATH_CHANGED",
            "owned worker project path moved outside its allocated directory",
        ));
    }
    let branch = git(&tree, &["symbolic-ref", "--quiet", "HEAD"])?;
    if branch.code != 0 || branch.text().trim() != marker.lease.branch_ref {
        return Err(WorktreeError::new(
            "WORKTREE_BRANCH_CHANGED",
            "owned worktree no longer has its allocated branch",
        ));
    }
    let common = git(&tree, &["rev-parse", "--git-common-dir"])?;
    if common.code != 0 {
        return Err(WorktreeError::new(
            "WORKTREE_REPOSITORY_CHANGED",
            "owned worktree repository identity is unavailable",
        ));
    }
    let common = real(&tree.join(common.text().trim()))?;
    if !same(&text_of(&common), &marker.lease.common_dir) {
        return Err(WorktreeError::new(
            "WORKTREE_REPOSITORY_CHANGED",
            "owned worktree repository identity changed",
        ));
    }
    identities_hold(&marker, lease, true)?;
    Ok(marker)
}

fn branch_exists(cwd: &Path, branch_ref: &str) -> Result<bool> {
    let found = git(cwd, &["show-ref", "--verify", "--quiet", branch_ref])?;
    match found.code {
        0 => Ok(true),
        1 => Ok(false),
        _ => Err(WorktreeError::new(
            "WORKTREE_BRANCH_CHECK_FAILED",
            found.stderr,
        )),
    }
}

fn not_found(error: &WorktreeError) -> bool {
    error.code == "WORKTREE_IO"
}

impl Worktrees {
    /// One deterministic, isolated worktree for a proven broker identity, made or recovered.
    pub fn allocate(
        &self,
        run_id: &str,
        agent_id: &str,
        prime: &Workspace,
        approved: &[Root],
        now: u64,
    ) -> Result<Allocated> {
        let (run_id, agent_id) = checked_identity(run_id, agent_id)?;
        let roots = roots_of(approved)?;
        let source = repository(Path::new(&prime.real), &roots)?;
        let (_, source_changes) = status(&source.cwd)?;
        let source_dirty = !source_changes.is_empty();
        let owner_root = managed_root_for(&source, &roots)?;
        let base = git(&source.cwd, &["rev-parse", "--verify", "HEAD^{commit}"])?;
        let base_oid = base.text().trim().to_owned();
        if base.code != 0 || !is_oid(&base_oid) {
            return Err(WorktreeError::new(
                "WORKTREE_BASE_UNAVAILABLE",
                "base revision is unavailable",
            ));
        }
        let project = source
            .cwd
            .strip_prefix(&source.root)
            .map_err(|_| {
                WorktreeError::new(
                    "WORKTREE_PROJECT_ESCAPE",
                    "prime workspace is outside the repository root",
                )
            })?
            .to_owned();
        let (branch, branch_ref) = expected_branch(&run_id, &agent_id);
        let common = text_of(&source.common_dir);
        let key = repo_key(&common);
        let owner = ensure_tree(
            &owner_root.real,
            &[MANAGED_FOLDER, &key, &run_id, &agent_id],
        )?;
        let hooks = ensure_tree(&owner, &["hooks"])?;
        let tree = owner.join("tree");
        let marker_path = owner.join("owner.json");
        let workspace_real = if project.as_os_str().is_empty() {
            tree.clone()
        } else {
            tree.join(&project)
        };
        let workspace_virtual = virtual_path(&owner_root.root, &owner_root.real, &workspace_real)?;
        let recover = |marker: Marker| -> Result<Allocated> {
            assert_slot(&marker, &marker_path)?;
            let theirs = &marker.lease;
            if theirs.run_id != run_id
                || theirs.agent_id != agent_id
                || !same(&theirs.source_repo_root, &text_of(&source.root))
                || !same(&theirs.common_dir, &common)
                || theirs.branch_ref != branch_ref
                || !same(&theirs.workspace.real, &text_of(&workspace_real))
                || theirs.workspace.virtual_path != workspace_virtual
                || theirs.approved_root.name != owner_root.root.name
                || !same(&theirs.approved_root.path, &owner_root.root.path)
            {
                return Err(WorktreeError::new(
                    "WORKTREE_OWNER_CONFLICT",
                    "managed worktree marker does not match the broker allocation",
                ));
            }
            let mut lease = marker.lease.clone();
            lease.source_dirty = source_dirty;
            assert_owned(&lease)?;
            self.register(lease.clone());
            Ok(Allocated {
                lease,
                newly_created: false,
            })
        };
        if let Some(existing) = read_marker(&marker_path)? {
            return recover(existing);
        }
        if fs::symlink_metadata(&tree).is_ok() {
            return Err(WorktreeError::new(
                "WORKTREE_PATH_OCCUPIED",
                "managed worktree destination already exists without an ownership marker",
            ));
        }
        if branch_exists(&source.cwd, &branch_ref)? {
            return Err(WorktreeError::new(
                "WORKTREE_BRANCH_OCCUPIED",
                "managed worker branch already exists without an ownership marker",
            ));
        }
        if !project.as_os_str().is_empty() {
            let tree_path: Vec<String> = project
                .components()
                .map(|part| part.as_os_str().to_string_lossy().into_owned())
                .collect();
            let entry = git(
                &source.cwd,
                &[
                    "cat-file",
                    "-t",
                    &format!("{base_oid}:{}", tree_path.join("/")),
                ],
            )?;
            if entry.code != 0 || entry.text().trim() != "tree" {
                return Err(WorktreeError::new(
                    "WORKTREE_PROJECT_NOT_IN_BASE",
                    "the selected nested workspace must be a tracked directory in the chosen base revision",
                ));
            }
        }
        let hooks_text = text_of(&hooks);
        let tree_text = text_of(&tree);
        let add = git_safe(
            &source.cwd,
            &hooks_text,
            &[
                "worktree",
                "add",
                "--no-track",
                "-b",
                &branch,
                &tree_text,
                &base_oid,
            ],
        )?;
        if add.code != 0 {
            if let Some(raced) = read_marker(&marker_path)? {
                return recover(raced);
            }
            return Err(WorktreeError::new("WORKTREE_ADD_FAILED", add.stderr));
        }
        let lease = Lease {
            version: 1,
            run_id: run_id.clone(),
            agent_id: agent_id.clone(),
            ownership_token: random_uuid(),
            source_repo_root: text_of(&source.root),
            common_dir: common.clone(),
            worktree_path: tree_text.clone(),
            workspace: Workspace {
                real: text_of(&workspace_real),
                virtual_path: workspace_virtual.clone(),
            },
            branch: branch.clone(),
            branch_ref: branch_ref.clone(),
            base_oid: base_oid.clone(),
            tree_identity: directory_identity(&tree)?,
            workspace_identity: directory_identity(&workspace_real)?,
            approved_root: owner_root.root.clone(),
            source_dirty,
            created_at: now,
        };
        let marker = Marker {
            lease: lease.clone(),
            owner_dir: text_of(&owner),
            marker_path: text_of(&marker_path),
            hooks_path: hooks_text.clone(),
            extra: Extra::default(),
        };
        let written = serde_json::to_string_pretty(&marker)
            .map_err(|error| WorktreeError::new("WORKTREE_MARKER", error.to_string()))
            .and_then(|json| {
                use std::io::Write;
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&marker_path)?;
                file.write_all(format!("{json}\n").as_bytes())?;
                file.sync_all()?;
                Ok(())
            })
            .and_then(|()| assert_owned(&lease).map(|_| ()));
        if let Err(error) = written {
            // Never force-remove a slot that another owner's marker now claims.
            let current = read_marker(&marker_path).ok();
            let ours = matches!(&current, Some(None))
                || matches!(&current, Some(Some(marker)) if marker_matches(marker, &lease));
            if ours {
                let removed = git_safe(
                    &source.cwd,
                    &hooks_text,
                    &["worktree", "remove", "--force", &tree_text],
                );
                if removed.is_ok_and(|removed| removed.code == 0) {
                    let _ = git(&source.cwd, &["update-ref", "-d", &branch_ref, &base_oid]);
                    if matches!(current, Some(Some(_))) {
                        let _ = fs::remove_file(&marker_path);
                    }
                }
            }
            return Err(error);
        }
        self.register(lease.clone());
        Ok(Allocated {
            lease,
            newly_created: true,
        })
    }

    fn register(&self, lease: Lease) {
        if let Ok(mut live) = self.live.lock() {
            live.insert(key_of(&lease.run_id, &lease.agent_id), lease);
        }
    }

    /// The process-local index. Not evidence that the checkout still exists; see [`Self::validate`].
    pub fn lookup(&self, run_id: &str, agent_id: &str) -> Option<Lease> {
        let (run_id, agent_id) = checked_identity(run_id, agent_id).ok()?;
        self.live
            .lock()
            .ok()?
            .get(&key_of(&run_id, &agent_id))
            .cloned()
    }

    /// Re-proves a lease at a privileged boundary. A failure also drops it from the index.
    pub fn validate(&self, lease: &Lease, approved: &[Root]) -> Result<Lease> {
        let (run_id, agent_id) = checked_identity(&lease.run_id, &lease.agent_id)?;
        let key = key_of(&run_id, &agent_id);
        let registered = self
            .live
            .lock()
            .ok()
            .and_then(|live| live.get(&key).cloned());
        let Some(registered) = registered.filter(|registered| registered == lease) else {
            return Err(WorktreeError::new(
                "WORKTREE_NOT_OWNED",
                "worker has no matching live broker allocation",
            ));
        };
        let checked = (|| {
            let roots = roots_of(approved)?;
            let owning = roots
                .iter()
                .find(|root| same_approved_root(root, &lease.approved_root))
                .filter(|root| contained(&root.real, Path::new(&lease.worktree_path)))
                .ok_or_else(|| {
                    WorktreeError::new(
                        "WORKTREE_ROOT_CHANGED",
                        "worker worktree no longer belongs to a current approved root",
                    )
                })?;
            let source = repository(Path::new(&lease.source_repo_root), &roots)?;
            if !same(&text_of(&source.root), &lease.source_repo_root)
                || !same(&text_of(&source.common_dir), &lease.common_dir)
            {
                return Err(WorktreeError::new(
                    "WORKTREE_REPOSITORY_CHANGED",
                    "source repository identity changed",
                ));
            }
            let marker = assert_owned(lease)?;
            if marker.lease.workspace.virtual_path
                != virtual_path(&owning.root, &owning.real, Path::new(&lease.workspace.real))?
            {
                return Err(WorktreeError::new(
                    "WORKTREE_OWNER_INVALID",
                    "worker workspace marker does not match its approved location",
                ));
            }
            Ok(registered.clone())
        })();
        if checked.is_err()
            && let Ok(mut live) = self.live.lock()
            && live
                .get(&key)
                .is_some_and(|current| current.ownership_token == registered.ownership_token)
        {
            live.remove(&key);
        }
        checked
    }

    /// Startup recovery: only identities the restored broker still owns may be discovered, at
    /// fixed depth under each approved root. Duplicate claims restore none.
    pub fn restore(&self, approved: &[Root], accepted: &[(String, String)]) -> Result<Restored> {
        let mut result = Restored::default();
        let mut wanted: HashMap<String, Vec<String>> = HashMap::new();
        for (run_id, agent_id) in accepted {
            if is_allocation_uuid(run_id) && is_agent_id(agent_id) {
                wanted
                    .entry(run_id.to_ascii_lowercase())
                    .or_default()
                    .push(agent_id.clone());
            }
        }
        if wanted.is_empty() {
            return Ok(result);
        }
        let roots = roots_of(approved)?;
        let mut candidates: HashMap<String, Vec<(Lease, String)>> = HashMap::new();
        for owning in &roots {
            for marker_path in candidate_markers(&owning.real, &wanted, &mut result.rejected) {
                match restore_one(owning, &roots, &marker_path) {
                    Ok(Some(lease)) => candidates
                        .entry(key_of(&lease.run_id, &lease.agent_id))
                        .or_default()
                        .push((lease, text_of(&marker_path))),
                    Ok(None) => {}
                    Err(error) => result
                        .rejected
                        .push((text_of(&marker_path), error.to_string())),
                }
            }
        }
        let mut live = self.live.lock().map_err(|_| {
            WorktreeError::new("WORKTREE_REGISTRY", "the lease registry is poisoned")
        })?;
        for (key, rows) in candidates {
            if rows.len() != 1 {
                live.remove(&key);
                for (_, path) in rows {
                    result.rejected.push((path, "WORKTREE_OWNER_AMBIGUOUS: more than one managed worktree claims this worker identity".to_owned()));
                }
                continue;
            }
            let Some((lease, path)) = rows.into_iter().next() else {
                continue;
            };
            if live
                .get(&key)
                .is_some_and(|existing| existing.ownership_token != lease.ownership_token)
            {
                result.rejected.push((path, "WORKTREE_OWNER_CONFLICT: live registry already contains another lease for this worker identity".to_owned()));
                continue;
            }
            live.insert(key, lease.clone());
            result.restored.push(lease);
        }
        Ok(result)
    }

    /// Removes an owned checkout and its marker, keeping the branch and its commits.
    /// `discard_changes` forces removal of a checkout with local changes.
    pub fn remove(&self, lease: &Lease, discard_changes: bool) -> Result<Vec<String>> {
        let marker = marker_for(lease)?;
        let tree = Path::new(&marker.lease.worktree_path);
        let changes = match status(tree) {
            Ok((_, changes)) => Some(changes),
            Err(error) if not_found(&error) || error.code == "WORKTREE_HEAD_INVALID" => None,
            Err(error) => return Err(error),
        };
        if let Some(changes) = &changes {
            if !discard_changes && !changes.is_empty() {
                return Err(WorktreeError::new(
                    "WORKTREE_DIRTY",
                    "the worker checkout has local changes; nothing was removed",
                ));
            }
            assert_owned(lease)?;
            let tree_text = text_of(tree);
            let mut args = vec!["worktree", "remove"];
            if discard_changes {
                args.push("--force");
            }
            args.push(&tree_text);
            let removed = git_safe(
                Path::new(&marker.lease.source_repo_root),
                &marker.hooks_path,
                &args,
            )?;
            if removed.code != 0 {
                return Err(WorktreeError::new("WORKTREE_REMOVE_FAILED", removed.stderr));
            }
        }
        match fs::remove_file(&marker.marker_path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let owner = Path::new(&marker.owner_dir);
        let _ = fs::remove_dir(owner.join("hooks"));
        let mut current = Some(owner);
        for _ in 0..3 {
            let Some(dir) = current else { break };
            if fs::remove_dir(dir).is_err() {
                break;
            }
            current = dir.parent();
        }
        if let Ok(mut live) = self.live.lock() {
            live.remove(&key_of(&lease.run_id, &lease.agent_id));
        }
        Ok(changes.unwrap_or_default())
    }
}

fn candidate_markers(
    root_real: &Path,
    wanted: &HashMap<String, Vec<String>>,
    rejected: &mut Vec<(String, String)>,
) -> Vec<PathBuf> {
    let managed = root_real.join(MANAGED_FOLDER);
    let Ok(found) = fs::symlink_metadata(&managed) else {
        return Vec::new();
    };
    if found.file_type().is_symlink() || !found.is_dir() {
        rejected.push((
            text_of(&managed),
            "WORKTREE_STORAGE_UNSAFE: managed worktree root is not a real directory".to_owned(),
        ));
        return Vec::new();
    }
    let dirs = |path: &Path| -> Vec<(String, PathBuf)> {
        fs::read_dir(path)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| {
                entry
                    .file_type()
                    .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink())
            })
            .map(|entry| {
                (
                    entry.file_name().to_string_lossy().into_owned(),
                    entry.path(),
                )
            })
            .collect()
    };
    let mut markers = Vec::new();
    for (repo, repo_dir) in dirs(&managed) {
        if repo.len() != 16 || !repo.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            continue;
        }
        for (run, run_dir) in dirs(&repo_dir) {
            let Some(workers) = wanted
                .get(&run.to_ascii_lowercase())
                .filter(|_| is_allocation_uuid(&run))
            else {
                continue;
            };
            for (agent, agent_dir) in dirs(&run_dir) {
                if workers.contains(&agent) {
                    markers.push(agent_dir.join("owner.json"));
                }
            }
        }
    }
    markers
}

fn restore_one(owning: &Resolved, roots: &[Resolved], marker_path: &Path) -> Result<Option<Lease>> {
    let Some(marker) = read_marker(marker_path)? else {
        return Ok(None);
    };
    checked_identity(&marker.lease.run_id, &marker.lease.agent_id)?;
    assert_slot(&marker, marker_path)?;
    let theirs = &marker.lease;
    if !same_approved_root(owning, &theirs.approved_root) {
        return Err(WorktreeError::new(
            "WORKTREE_ROOT_CHANGED",
            "the owning approved root has changed since allocation",
        ));
    }
    if ![
        &theirs.source_repo_root,
        &theirs.common_dir,
        &theirs.worktree_path,
        &theirs.workspace.real,
    ]
    .iter()
    .all(|path| contained(&owning.real, Path::new(path)))
    {
        return Err(WorktreeError::new(
            "WORKTREE_OUTSIDE_ROOT",
            "restored worktree or repository metadata is outside current approved roots",
        ));
    }
    let source = repository(Path::new(&theirs.source_repo_root), roots)?;
    if !same(&text_of(&source.root), &theirs.source_repo_root)
        || !same(&text_of(&source.common_dir), &theirs.common_dir)
    {
        return Err(WorktreeError::new(
            "WORKTREE_REPOSITORY_CHANGED",
            "restored worker marker names the wrong source repository",
        ));
    }
    let workspace = real_directory(Path::new(&theirs.workspace.real))?;
    let tree = real_directory(Path::new(&theirs.worktree_path))?;
    if !contained(&tree, &workspace) {
        return Err(WorktreeError::new(
            "WORKTREE_PROJECT_ESCAPE",
            "restored worker workspace escaped its owned worktree",
        ));
    }
    let virtual_now = virtual_path(&owning.root, &owning.real, &workspace)?;
    if theirs.workspace.virtual_path != virtual_now {
        return Err(WorktreeError::new(
            "WORKTREE_OWNER_INVALID",
            "restored worker virtual workspace does not match its approved root",
        ));
    }
    let mut lease = theirs.clone();
    lease.source_dirty =
        status(Path::new(&theirs.source_repo_root)).is_ok_and(|(_, changes)| !changes.is_empty());
    lease.approved_root = owning.root.clone();
    lease.workspace = Workspace {
        real: text_of(&workspace),
        virtual_path: virtual_now,
    };
    assert_owned(&lease)?;
    Ok(Some(lease))
}
