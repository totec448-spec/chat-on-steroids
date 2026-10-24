//! Marker-verified worker worktrees against real Git, case by case from
//! `test/worktrees-manager.test.ts`. Every repository is a scratch repository under the
//! checkout's own `.tmp/` folder.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use cos_agents::worktrees::{Lease, Workspace, Worktrees};
use cos_types::config::Root;
use cos_types::json::Extra;

const RUN_ID: &str = "11111111-1111-4111-8111-111111111111";
const OTHER_RUN_ID: &str = "22222222-2222-4222-8222-222222222222";

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout)
        .replace('\r', "")
        .trim()
        .to_owned()
}

struct Scratch {
    temp: PathBuf,
    approved: PathBuf,
    repo: PathBuf,
}

impl Scratch {
    fn new(label: &str) -> Self {
        let temp = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../.tmp/wt")
            // Short: Git on Windows refuses a worktree whose metadata path passes MAX_PATH.
            .join(format!(
                "{}{}",
                &label[..label.len().min(3)],
                std::process::id()
            ));
        let _ = fs::remove_dir_all(&temp);
        let approved = temp.join("approved");
        let repo = approved.join("repo");
        fs::create_dir_all(&repo).expect("repo folder");
        git(&repo, &["init", "-q"]);
        git(&repo, &["config", "user.name", "CoS Worktree Test"]);
        git(
            &repo,
            &["config", "user.email", "worktree-test@example.invalid"],
        );
        git(&repo, &["config", "core.autocrlf", "false"]);
        fs::write(repo.join("file.txt"), "base\n").expect("file");
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-q", "-m", "base"]);
        let approved = fs::canonicalize(&approved).expect("approved");
        let approved = PathBuf::from(approved.to_string_lossy().trim_start_matches(r"\\?\"));
        let repo = approved.join("repo");
        Self {
            temp,
            approved,
            repo,
        }
    }

    fn roots(&self) -> Vec<Root> {
        vec![root("approved", &self.approved)]
    }

    fn prime(&self) -> Workspace {
        Workspace {
            real: self.repo.to_string_lossy().into_owned(),
            virtual_path: "/approved/repo".to_owned(),
        }
    }

    fn allocate(
        &self,
        worktrees: &Worktrees,
        run_id: &str,
        agent: &str,
    ) -> cos_agents::worktrees::Allocated {
        worktrees
            .allocate(
                run_id,
                agent,
                &self.prime(),
                &self.roots(),
                1_767_225_600_000,
            )
            .expect("allocated")
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = Command::new("git")
            .args(["worktree", "prune"])
            .current_dir(&self.repo)
            .output();
        let _ = fs::remove_dir_all(&self.temp);
    }
}

fn root(name: &str, path: &Path) -> Root {
    Root {
        name: name.to_owned(),
        path: path.to_string_lossy().into_owned(),
        extra: Extra::default(),
    }
}

fn read(path: impl AsRef<Path>) -> String {
    fs::read_to_string(path).expect("readable")
}

fn marker_of(lease: &Lease) -> PathBuf {
    Path::new(&lease.worktree_path)
        .parent()
        .expect("owner")
        .join("owner.json")
}

#[test]
fn allocates_outside_the_source_repo_and_preserves_pre_existing_dirty_source_changes() {
    let scratch = Scratch::new("dirty");
    fs::write(scratch.repo.join("file.txt"), "source dirty\n").expect("edit");
    let worktrees = Worktrees::default();
    let allocated = scratch.allocate(&worktrees, RUN_ID, "worker-1");
    let lease = &allocated.lease;
    assert!(allocated.newly_created);
    assert!(lease.source_dirty);
    assert!(!Path::new(&lease.worktree_path).starts_with(&scratch.repo));
    assert!(
        lease
            .workspace
            .virtual_path
            .starts_with("/approved/.chat-on-steroids-worktrees/")
    );
    assert_eq!(
        read(Path::new(&lease.workspace.real).join("file.txt")),
        "base\n"
    );
    assert_eq!(read(scratch.repo.join("file.txt")), "source dirty\n");
    assert_eq!(
        lease.branch,
        "cos/worktrees/11111111111141118111111111111111/worker-1"
    );
    assert_eq!(
        git(Path::new(&lease.worktree_path), &["symbolic-ref", "HEAD"]),
        lease.branch_ref
    );
    assert_eq!(
        worktrees
            .lookup(RUN_ID, "worker-1")
            .map(|found| found.ownership_token),
        Some(lease.ownership_token.clone())
    );
    worktrees.remove(lease, true).expect("removed");
    assert!(!Path::new(&lease.worktree_path).exists());
    assert_eq!(read(scratch.repo.join("file.txt")), "source dirty\n");
    assert!(git(&scratch.repo, &["status", "--porcelain"]).contains("file.txt"));
    assert_eq!(
        git(&scratch.repo, &["branch", "--list", "cos/worktrees/*"]),
        lease.branch,
        "the branch and its commits are kept"
    );
}

#[test]
fn reports_fresh_allocation_provenance_and_never_claims_a_recovered_lease() {
    let scratch = Scratch::new("recover");
    let worktrees = Worktrees::default();
    let first = scratch.allocate(&worktrees, RUN_ID, "worker-1");
    let again = scratch.allocate(&Worktrees::default(), RUN_ID, "worker-1");
    assert!(first.newly_created);
    assert!(!again.newly_created);
    assert_eq!(again.lease.ownership_token, first.lease.ownership_token);
    assert!(Path::new(&first.lease.worktree_path).is_dir());
}

#[test]
fn refuses_storage_when_the_repository_itself_is_the_only_approved_root() {
    let scratch = Scratch::new("storage");
    let error = Worktrees::default()
        .allocate(
            RUN_ID,
            "worker-1",
            &Workspace {
                real: scratch.repo.to_string_lossy().into_owned(),
                virtual_path: "/repo".to_owned(),
            },
            &[root("repo", &scratch.repo)],
            1,
        )
        .expect_err("refused");
    assert_eq!(error.code, "WORKTREE_STORAGE_UNAVAILABLE");
    assert_eq!(
        git(&scratch.repo, &["branch", "--list", "cos/worktrees/*"]),
        ""
    );
}

#[test]
fn refuses_an_identity_the_broker_could_not_have_issued() {
    let scratch = Scratch::new("identity");
    let worktrees = Worktrees::default();
    let error = worktrees
        .allocate(
            "not-a-uuid",
            "worker-1",
            &scratch.prime(),
            &scratch.roots(),
            1,
        )
        .expect_err("refused");
    assert_eq!(error.code, "WORKTREE_IDENTITY_INVALID");
    let error = worktrees
        .allocate(RUN_ID, "prime", &scratch.prime(), &scratch.roots(), 1)
        .expect_err("refused");
    assert_eq!(error.code, "WORKTREE_IDENTITY_INVALID");
}

#[test]
fn validates_live_ownership_and_refuses_a_swapped_directory_without_touching_user_bytes() {
    let scratch = Scratch::new("swapped");
    let worktrees = Worktrees::default();
    let lease = scratch.allocate(&worktrees, RUN_ID, "worker-1").lease;
    let valid = worktrees.validate(&lease, &scratch.roots()).expect("valid");
    assert_eq!(valid.ownership_token, lease.ownership_token);
    let tree = PathBuf::from(&lease.worktree_path);
    let displaced = tree.with_file_name("displaced-original-tree");
    fs::rename(&tree, &displaced).expect("displaced");
    fs::create_dir(&tree).expect("replacement");
    fs::write(tree.join("personal.txt"), "PERSONAL USER DATA\n").expect("personal");
    assert!(worktrees.lookup(RUN_ID, "worker-1").is_some());
    let error = worktrees
        .validate(&lease, &scratch.roots())
        .expect_err("refused");
    assert_eq!(error.code, "WORKTREE_PATH_CHANGED");
    assert!(
        worktrees.lookup(RUN_ID, "worker-1").is_none(),
        "a failed proof drops the lease"
    );
    assert_eq!(read(tree.join("personal.txt")), "PERSONAL USER DATA\n");
    assert_eq!(read(displaced.join("file.txt")), "base\n");
    fs::remove_dir_all(&tree).expect("cleared");
    fs::rename(&displaced, &tree).expect("restored");
}

#[test]
fn rejects_a_substituted_genuine_git_tree_with_a_different_directory_identity() {
    let scratch = Scratch::new("substituted");
    let worktrees = Worktrees::default();
    let lease = scratch.allocate(&worktrees, RUN_ID, "worker-1").lease;
    let tree = PathBuf::from(&lease.worktree_path);
    let original = tree.with_file_name("original-git-tree");
    fs::rename(&tree, &original).expect("moved");
    copy_dir(&original, &tree);
    let error = worktrees
        .validate(&lease, &scratch.roots())
        .expect_err("refused");
    assert_eq!(error.code, "WORKTREE_PATH_CHANGED");
    assert_eq!(read(tree.join("file.txt")), "base\n");
    fs::remove_dir_all(&tree).expect("cleared");
    fs::rename(&original, &tree).expect("restored");
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).expect("dir");
    for entry in fs::read_dir(from).expect("listing") {
        let entry = entry.expect("entry");
        let target = to.join(entry.file_name());
        if entry.file_type().expect("type").is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).expect("copied");
        }
    }
}

#[test]
fn restores_only_marker_proven_worktrees_the_broker_still_owns() {
    let scratch = Scratch::new("restore");
    let worktrees = Worktrees::default();
    let stale = scratch.allocate(&worktrees, RUN_ID, "worker-1").lease;
    let other_worker = scratch.allocate(&worktrees, RUN_ID, "worker-2").lease;
    let accepted = scratch.allocate(&worktrees, OTHER_RUN_ID, "worker-1").lease;
    fs::write(marker_of(&stale), "{stale-pruned-family").expect("damaged");
    fs::write(marker_of(&other_worker), "{unaccepted-worker").expect("damaged");
    let before = git(&scratch.repo, &["worktree", "list", "--porcelain"]);

    let restarted = Worktrees::default();
    let recovered = restarted
        .restore(
            &scratch.roots(),
            &[
                (OTHER_RUN_ID.to_owned(), "worker-1".to_owned()),
                (RUN_ID.to_owned(), "worker-3".to_owned()),
            ],
        )
        .expect("restore");
    assert_eq!(recovered.rejected, Vec::<(String, String)>::new());
    assert_eq!(recovered.restored.len(), 1);
    assert_eq!(
        recovered.restored[0].ownership_token,
        accepted.ownership_token
    );
    assert!(restarted.lookup(RUN_ID, "worker-1").is_none());
    assert!(restarted.lookup(RUN_ID, "worker-2").is_none());
    assert!(restarted.lookup(OTHER_RUN_ID, "worker-1").is_some());
    assert_eq!(read(marker_of(&stale)), "{stale-pruned-family");
    assert_eq!(read(marker_of(&other_worker)), "{unaccepted-worker");
    assert_eq!(
        git(&scratch.repo, &["worktree", "list", "--porcelain"]),
        before
    );
    restarted
        .validate(&recovered.restored[0], &scratch.roots())
        .expect("a restored lease is valid");
}

#[test]
fn refuses_a_tampered_restart_marker_instead_of_following_its_path() {
    let scratch = Scratch::new("tampered");
    let lease = scratch
        .allocate(&Worktrees::default(), RUN_ID, "worker-1")
        .lease;
    let path = marker_of(&lease);
    let mut marker: serde_json::Value = serde_json::from_str(&read(&path)).expect("marker");
    marker["worktreePath"] = scratch
        .temp
        .join("outside-approved-root")
        .to_string_lossy()
        .into_owned()
        .into();
    fs::write(&path, serde_json::to_string_pretty(&marker).expect("json")).expect("tampered");
    let restarted = Worktrees::default();
    let result = restarted
        .restore(
            &scratch.roots(),
            &[(RUN_ID.to_owned(), "worker-1".to_owned())],
        )
        .expect("restore");
    assert!(result.restored.is_empty());
    assert_eq!(result.rejected.len(), 1);
    assert!(
        result.rejected[0].1.contains("WORKTREE_OWNER_INVALID"),
        "{:?}",
        result.rejected
    );
    assert!(restarted.lookup(RUN_ID, "worker-1").is_none());
}

#[test]
fn does_not_claim_restored_ownership_through_a_renamed_approved_root() {
    let scratch = Scratch::new("renamed");
    let worktrees = Worktrees::default();
    let lease = scratch.allocate(&worktrees, RUN_ID, "worker-1").lease;
    let restarted = Worktrees::default();
    let result = restarted
        .restore(
            &[root("renamed", &scratch.approved)],
            &[(RUN_ID.to_owned(), "worker-1".to_owned())],
        )
        .expect("restore");
    assert!(result.restored.is_empty());
    assert!(
        result.rejected[0].1.contains("WORKTREE_ROOT_CHANGED"),
        "{:?}",
        result.rejected
    );
    worktrees
        .validate(&lease, &scratch.roots())
        .expect("still valid under its own root");
}

#[test]
fn keeps_a_dirty_checkout_unless_discarding_is_explicit() {
    let scratch = Scratch::new("finalize");
    let worktrees = Worktrees::default();
    let lease = scratch.allocate(&worktrees, RUN_ID, "worker-1").lease;
    fs::write(
        Path::new(&lease.workspace.real).join("file.txt"),
        "worker edit\n",
    )
    .expect("edit");
    let error = worktrees.remove(&lease, false).expect_err("kept");
    assert_eq!(error.code, "WORKTREE_DIRTY");
    assert_eq!(
        read(Path::new(&lease.workspace.real).join("file.txt")),
        "worker edit\n"
    );
    let changes = worktrees.remove(&lease, true).expect("discarded");
    assert_eq!(changes, ["file.txt"]);
    assert!(!marker_of(&lease).exists());
    assert!(worktrees.lookup(RUN_ID, "worker-1").is_none());
}
