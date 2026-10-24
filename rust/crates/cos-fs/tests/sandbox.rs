//! The security core (`test/sandbox.test.ts`, `test/wsl-sandbox-portable.test.ts`). If a test
//! here stops passing, the model can reach files the user never approved.

mod common;

use std::path::Path;

use common::{Scratch, dir_link, file_symlink, refused, roots};
use cos_fs::{Access, Roots, SandboxError, VirtualPath, resolve, resolve_from};

/// `approved/{file.txt, sub/nested.txt, sub/deep/leaf.txt}` and `outside/secret.txt`.
struct Tree {
    scratch: Scratch,
}

impl Tree {
    fn new() -> Self {
        let scratch = Scratch::new("sandbox");
        scratch.write("approved/file.txt", b"hello");
        scratch.write("approved/sub/nested.txt", b"nested");
        scratch.write("approved/sub/deep/leaf.txt", b"leaf");
        scratch.write("outside/secret.txt", b"TOP SECRET");
        Self { scratch }
    }

    fn approved(&self) -> std::path::PathBuf {
        self.scratch.join("approved")
    }

    fn outside(&self) -> std::path::PathBuf {
        self.scratch.join("outside")
    }

    fn roots(&self) -> Roots {
        roots(&[("project", &self.approved())])
    }

    fn native(&self, relative: &str) -> String {
        self.scratch.join(relative).to_string_lossy().into_owned()
    }
}

fn text(error: SandboxError) -> String {
    error.to_string()
}

#[test]
fn resolves_a_file_inside_an_approved_root() {
    let tree = Tree::new();
    let resolved = resolve(&tree.roots(), "/project/file.txt", Access::Read).unwrap();
    assert_eq!(resolved.real, tree.approved().join("file.txt"));
    assert_eq!(resolved.virtual_path.as_str(), "/project/file.txt");
    assert_eq!(resolved.root.as_str(), "project");
}

#[test]
fn resolves_the_root_itself() {
    let tree = Tree::new();
    let resolved = resolve(&tree.roots(), "/project", Access::Read).unwrap();
    assert_eq!(resolved.real, tree.approved());
    assert_eq!(resolved.virtual_path.as_str(), "/project");
}

#[cfg(windows)]
#[test]
fn accepts_backslashes_and_mixed_separators() {
    let tree = Tree::new();
    for input in ["\\project\\sub\\nested.txt", "/project\\sub/nested.txt"] {
        let resolved = resolve(&tree.roots(), input, Access::Read).unwrap();
        assert_eq!(
            resolved.real,
            tree.approved().join("sub").join("nested.txt")
        );
        assert_eq!(resolved.virtual_path.as_str(), "/project/sub/nested.txt");
    }
}

#[test]
fn accepts_redundant_separators() {
    let tree = Tree::new();
    let resolved = resolve(&tree.roots(), "//project///sub//nested.txt", Access::Read).unwrap();
    assert_eq!(resolved.virtual_path.as_str(), "/project/sub/nested.txt");
}

#[test]
fn matches_the_root_name_case_insensitively() {
    let tree = Tree::new();
    let resolved = resolve(&tree.roots(), "/PROJECT/file.txt", Access::Read).unwrap();
    assert_eq!(resolved.virtual_path.as_str(), "/project/file.txt");
}

#[cfg(windows)]
#[test]
fn reports_the_canonical_case_of_existing_parts_and_the_spelled_case_of_missing_ones() {
    let tree = Tree::new();
    let resolved = resolve(&tree.roots(), "/project/SUB/NESTED.TXT", Access::Read).unwrap();
    assert_eq!(resolved.virtual_path.as_str(), "/project/sub/nested.txt");
    let created = resolve(&tree.roots(), "/project/SUB/New.txt", Access::Create).unwrap();
    assert_eq!(created.virtual_path.as_str(), "/project/sub/New.txt");
    assert_eq!(
        text(refused(
            &tree.roots(),
            "/project/SUB/missing.txt",
            Access::Read
        )),
        "Not found: /project/SUB/missing.txt"
    );
}

#[test]
fn allows_a_missing_path_only_for_create() {
    let tree = Tree::new();
    for access in [
        Access::Read,
        Access::Write,
        Access::Delete,
        Access::WorkingFolder,
    ] {
        assert_eq!(
            text(refused(&tree.roots(), "/project/brand-new.txt", access)),
            "Not found: /project/brand-new.txt"
        );
    }
    let resolved = resolve(&tree.roots(), "/project/brand-new.txt", Access::Create).unwrap();
    assert_eq!(resolved.real, tree.approved().join("brand-new.txt"));
}

#[test]
fn allows_missing_intermediate_folders_for_create() {
    let tree = Tree::new();
    let resolved = resolve(&tree.roots(), "/project/a/b/c.txt", Access::Create).unwrap();
    assert_eq!(
        resolved.real,
        tree.approved().join("a").join("b").join("c.txt")
    );
    assert_eq!(resolved.virtual_path.as_str(), "/project/a/b/c.txt");
}

#[test]
fn refuses_every_traversal() {
    let tree = Tree::new();
    let mut inputs = vec![
        "/project/../outside/secret.txt",
        "/project/sub/deep/../../../outside/secret.txt",
        "/project/sub/../file.txt",
        "/..",
    ];
    if cfg!(windows) {
        inputs.push("\\project\\..\\outside\\secret.txt");
    }
    for input in inputs {
        for access in [Access::Read, Access::Create] {
            assert_eq!(
                text(refused(&tree.roots(), input, access)),
                "Path traversal (\"..\") is not allowed",
                "{input}"
            );
        }
    }
}

#[test]
fn refuses_a_dot_segment() {
    let tree = Tree::new();
    assert_eq!(
        text(refused(&tree.roots(), "/project/./file.txt", Access::Read)),
        "Path contains an empty segment"
    );
}

#[cfg(windows)]
#[test]
fn refuses_windows_path_tricks() {
    let tree = Tree::new();
    let roots = tree.roots();
    let cases: &[(&str, &str)] = &[
        (
            "/project/C:file.txt",
            "Path contains \":\", which is not allowed",
        ),
        (
            "/project/file.txt:hidden",
            "Path contains \":\", which is not allowed",
        ),
        (
            "/project/file.txt::$DATA",
            "Path contains \":\", which is not allowed",
        ),
        (
            "/project/sub:$I30:$INDEX_ALLOCATION",
            "Path contains \":\", which is not allowed",
        ),
        (
            "/project/file.txt.",
            "Path segment ends with a dot or space",
        ),
        (
            "/project/file.txt ",
            "Path segment ends with a dot or space",
        ),
        (
            " /project/file.txt",
            "Path segment ends with a dot or space",
        ),
        (
            "/project/*",
            "Path contains a character Windows does not allow",
        ),
        (
            "/project/?",
            "Path contains a character Windows does not allow",
        ),
        (
            "/project/<a>",
            "Path contains a character Windows does not allow",
        ),
        (
            "/project/a|b",
            "Path contains a character Windows does not allow",
        ),
        (
            "/project/a\"b",
            "Path contains a character Windows does not allow",
        ),
        // A forward-slash device spelling is not native; its `?` segment is refused.
        (
            "//?/C:/Windows/win.ini",
            "Path contains a character Windows does not allow",
        ),
        ("//./C:/Windows/win.ini", "Path contains an empty segment"),
    ];
    for (input, expected) in cases {
        assert_eq!(
            text(refused(&roots, input, Access::Read)),
            *expected,
            "{input}"
        );
    }
    for name in [
        "CON",
        "nul",
        "com1",
        "LPT9",
        "aux.txt",
        "CONIN$",
        "conout$.log",
        "COM0",
    ] {
        assert_eq!(
            text(refused(&roots, &format!("/project/{name}"), Access::Create)),
            format!("\"{name}\" is a reserved Windows device name")
        );
    }
}

#[cfg(windows)]
#[test]
fn refuses_native_paths_outside_and_device_or_unc_spellings_of_inside() {
    let tree = Tree::new();
    let roots = tree.roots();
    let inside = tree.native("approved/file.txt");
    let below_drive = &inside[3..];
    let cases = [
        "C:\\Windows\\System32\\drivers\\etc\\hosts".to_owned(),
        "\\\\server\\share\\secret.txt".to_owned(),
        format!("\\\\?\\{inside}"),
        format!("\\\\.\\{inside}"),
        format!("\\\\?\\UNC\\localhost\\C$\\{below_drive}"),
        format!("\\\\localhost\\C$\\{below_drive}"),
        format!("\\\\127.0.0.1\\c$\\{below_drive}"),
        "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\Windows\\win.ini".to_owned(),
        tree.native("outside/secret.txt"),
    ];
    for input in &cases {
        assert_eq!(
            text(refused(&roots, input, Access::Read)),
            format!(
                "Native path \"{input}\" is not inside an approved folder. Approved roots: /project"
            ),
            "{input}"
        );
    }
}

#[cfg(windows)]
#[test]
fn refuses_streams_and_aliases_in_native_spellings() {
    let tree = Tree::new();
    let roots = tree.roots();
    let file = tree.native("approved/file.txt");
    for (input, expected) in [
        (
            format!("{file}::$DATA"),
            "Path contains \":\", which is not allowed",
        ),
        (
            format!("{file}:secret"),
            "Path contains \":\", which is not allowed",
        ),
        (format!("{file}."), "Path segment ends with a dot or space"),
        (
            tree.native("approved/sub/../file.txt"),
            "Path traversal (\"..\") is not allowed",
        ),
        (
            format!("{}\\sub\\..\\file.txt", tree.native("approved")),
            "Path traversal (\"..\") is not allowed",
        ),
        (
            tree.native("approved/CON"),
            "\"CON\" is a reserved Windows device name",
        ),
    ] {
        assert_eq!(
            text(refused(&roots, &input, Access::Read)),
            expected,
            "{input}"
        );
    }
}

#[test]
fn refuses_null_bytes_and_control_characters() {
    let tree = Tree::new();
    assert_eq!(
        text(refused(
            &tree.roots(),
            "/project/file.txt\0.png",
            Access::Read
        )),
        "Path contains a null byte"
    );
    assert_eq!(
        text(refused(
            &tree.roots(),
            "/project/fi\u{7}le.txt",
            Access::Read
        )),
        "Path contains a control character"
    );
}

#[test]
fn refuses_an_unknown_root_and_names_the_approved_ones() {
    let tree = Tree::new();
    assert_eq!(
        text(refused(&tree.roots(), "/nope/file.txt", Access::Read)),
        "Unknown root \"/nope\". Approved roots: /project"
    );
    assert_eq!(
        text(refused(&Roots::new([]), "/nope/file.txt", Access::Read)),
        "Unknown root \"/nope\". Approved roots: (none approved)"
    );
}

#[test]
fn refuses_empty_and_oversized_paths() {
    let tree = Tree::new();
    let roots = tree.roots();
    let empty = "Path is empty. Use an approved virtual root such as /<root>/file.txt.";
    assert_eq!(text(refused(&roots, "/", Access::Read)), empty);
    assert_eq!(text(refused(&roots, "", Access::Read)), empty);
    assert_eq!(
        text(refused(
            &roots,
            &format!("/project/{}", "a".repeat(5000)),
            Access::Read
        )),
        "Path is too long"
    );
    assert_eq!(
        text(refused(
            &roots,
            &format!("/project/{}.txt", "a".repeat(300)),
            Access::Create
        )),
        "Path segment is too long"
    );
    // JavaScript measures in UTF-16 units: 128 emoji are 256 units.
    assert_eq!(
        text(refused(
            &roots,
            &format!("/project/{}", "\u{1f600}".repeat(128)),
            Access::Create
        )),
        "Path segment is too long"
    );
}

#[test]
fn does_not_treat_a_root_name_as_a_prefix_of_another() {
    let tree = Tree::new();
    let two = roots(&[
        ("project", &tree.approved()),
        ("project-two", &tree.outside()),
    ]);
    let resolved = resolve(&two, "/project-two/secret.txt", Access::Read).unwrap();
    assert_eq!(resolved.real, tree.outside().join("secret.txt"));
}

#[test]
fn refuses_a_relative_path_without_a_base() {
    let tree = Tree::new();
    assert_eq!(
        text(refused(&tree.roots(), "src/greeting.txt", Access::Read)),
        "\"src/greeting.txt\" is relative and this chat has no active folder yet. Use a full path: /project"
    );
    let long = format!("{}/x", "d".repeat(200));
    assert_eq!(
        text(refused(&tree.roots(), &long, Access::Read)),
        format!(
            "\"{}\" is relative and this chat has no active folder yet. Use a full path: /project",
            "d".repeat(120)
        )
    );
}

#[test]
fn resolves_a_relative_path_from_a_base_without_climbing_out() {
    let tree = Tree::new();
    let roots = tree.roots();
    let base = resolve(&roots, "/project/sub", Access::Read)
        .unwrap()
        .virtual_path;
    let resolved = resolve_from(&roots, &base, "nested.txt", Access::Read).unwrap();
    assert_eq!(resolved.virtual_path.as_str(), "/project/sub/nested.txt");
    for input in ["../file.txt", "deep/../../file.txt"] {
        let error = resolve_from(&roots, &base, input, Access::Read).unwrap_err();
        assert_eq!(error, SandboxError::Traversal, "{input}");
    }
    let absolute = resolve_from(&roots, &base, "/project/file.txt", Access::Read).unwrap();
    assert_eq!(absolute.virtual_path.as_str(), "/project/file.txt");
}

#[test]
fn checks_a_working_folder_is_a_folder() {
    let tree = Tree::new();
    let roots = tree.roots();
    let folder = resolve(&roots, "/project/sub", Access::WorkingFolder).unwrap();
    assert_eq!(folder.real, tree.approved().join("sub"));
    assert_eq!(
        text(refused(&roots, "/project/file.txt", Access::WorkingFolder)),
        "workdir must be a folder"
    );
    assert_eq!(
        text(refused(&roots, "/project/none", Access::WorkingFolder)),
        "Not found: /project/none"
    );
}

#[test]
fn refuses_reading_or_creating_through_a_link_that_leaves_the_root() {
    let tree = Tree::new();
    let roots = tree.roots();
    let escape = tree.approved().join("escape");
    dir_link(&tree.outside(), &escape);
    assert_eq!(
        std::fs::read(escape.join("secret.txt")).unwrap(),
        b"TOP SECRET"
    );
    let via_link = "Path escapes its approved folder via a link";
    for (input, access) in [
        ("/project/escape/secret.txt", Access::Read),
        ("/project/escape", Access::Read),
        ("/project/escape/planted.txt", Access::Create),
        ("/project/escape/new/deeper.txt", Access::Create),
    ] {
        assert_eq!(text(refused(&roots, input, access)), via_link, "{input}");
    }
    let native = escape.join("secret.txt").to_string_lossy().into_owned();
    assert_eq!(text(refused(&roots, &native, Access::Read)), via_link);
}

#[test]
fn allows_a_link_that_stays_inside_the_root_and_reports_the_canonical_path() {
    let tree = Tree::new();
    let roots = tree.roots();
    let inner = tree.approved().join("inner");
    dir_link(&tree.approved().join("sub"), &inner);
    let resolved = resolve(&roots, "/project/inner/nested.txt", Access::Read).unwrap();
    assert_eq!(
        resolved.real,
        tree.approved().join("sub").join("nested.txt")
    );
    assert_eq!(resolved.virtual_path.as_str(), "/project/sub/nested.txt");
    let native = inner.join("nested.txt").to_string_lossy().into_owned();
    let resolved = resolve(&roots, &native, Access::Read).unwrap();
    assert_eq!(resolved.virtual_path.as_str(), "/project/sub/nested.txt");
}

#[test]
fn refuses_a_file_symlink_that_leaves_the_root() {
    let tree = Tree::new();
    let link = tree.approved().join("secret-link.txt");
    if !file_symlink(&tree.outside().join("secret.txt"), &link) {
        eprintln!("skipped: this account cannot create file symlinks");
        return;
    }
    assert_eq!(
        text(refused(
            &tree.roots(),
            "/project/secret-link.txt",
            Access::Read
        )),
        "Path escapes its approved folder via a link"
    );
}

/// TypeScript treats a link whose target is missing as a missing path, so a create through it
/// wrote wherever the link pointed. Reads still say "Not found", as TypeScript does.
#[test]
fn refuses_creating_through_a_dangling_link() {
    let tree = Tree::new();
    let roots = tree.roots();
    let planted = tree.outside().join("planted");
    dir_link(&planted, &tree.approved().join("dangling"));
    assert_eq!(
        text(refused(&roots, "/project/dangling/x.txt", Access::Create)),
        "Path contains a link that could not be resolved"
    );
    assert_eq!(
        text(refused(&roots, "/project/dangling", Access::Create)),
        "Path contains a link that could not be resolved"
    );
    assert_eq!(
        text(refused(&roots, "/project/dangling/x.txt", Access::Read)),
        "Not found: /project/dangling/x.txt"
    );
    let file_link = tree.approved().join("dangling.txt");
    if file_symlink(&tree.outside().join("planted.txt"), &file_link) {
        assert_eq!(
            text(refused(&roots, "/project/dangling.txt", Access::Create)),
            "Path contains a link that could not be resolved"
        );
    }
    assert!(!planted.exists());
}

#[test]
fn does_not_let_replacing_the_root_with_a_link_retarget_its_permission() {
    let tree = Tree::new();
    let original = tree.scratch.dir("approved-swap");
    tree.scratch.write("approved-swap/allowed.txt", b"allowed");
    tree.scratch
        .write("unapproved-swap-target/secret.txt", b"SECRET");
    let canonical = cos_fs::validate_new_root(&original, &Roots::new([])).unwrap();
    let swap = roots(&[("swap", &canonical)]);
    std::fs::rename(&original, tree.scratch.join("approved-swap-moved")).unwrap();
    dir_link(&tree.scratch.join("unapproved-swap-target"), &original);
    assert_eq!(
        std::fs::read(original.join("secret.txt")).unwrap(),
        b"SECRET"
    );
    let expected = "Root \"/swap\" is not available or changed on disk. Remove it and approve the folder again.";
    assert_eq!(
        text(refused(&swap, "/swap/secret.txt", Access::Read)),
        expected
    );
    assert_eq!(text(refused(&swap, "/swap", Access::Read)), expected);
}

/// NTFS keeps `kit` and `\u{212a}it` (KELVIN SIGN) as two folders, but JavaScript lowercases
/// both to `kit`, so TypeScript took a junction to the sibling as inside the root.
#[cfg(windows)]
#[test]
fn refuses_a_link_to_a_sibling_whose_name_differs_only_by_case_folding() {
    let tree = Tree::new();
    let root = tree.scratch.dir("case/kit");
    let sibling = tree.scratch.join("case/\u{212a}it");
    if std::fs::create_dir(&sibling).is_err() {
        eprintln!("skipped: this volume folds KELVIN SIGN into k");
        return;
    }
    std::fs::write(sibling.join("secret.txt"), b"SECRET").unwrap();
    dir_link(&sibling, &root.join("link"));
    let kit = roots(&[("kit", &root)]);
    assert_eq!(
        text(refused(&kit, "/kit/link/secret.txt", Access::Read)),
        "Path escapes its approved folder via a link"
    );
}

#[test]
fn refuses_a_root_that_is_gone() {
    let tree = Tree::new();
    let gone = roots(&[("gone", &tree.scratch.join("missing-root"))]);
    assert_eq!(
        text(refused(&gone, "/gone/x.txt", Access::Create)),
        "Root \"/gone\" is not available or changed on disk. Remove it and approve the folder again."
    );
}

#[test]
fn maps_real_paths_back_to_virtual_paths() {
    let tree = Tree::new();
    let roots = tree.roots();
    let to_virtual = |path: &Path| cos_fs::to_virtual(&roots, path).map(|v| v.as_str().to_owned());
    assert_eq!(to_virtual(&tree.approved()).as_deref(), Some("/project"));
    assert_eq!(
        to_virtual(&tree.approved().join("sub").join("nested.txt")).as_deref(),
        Some("/project/sub/nested.txt")
    );
    assert_eq!(to_virtual(&tree.outside().join("secret.txt")), None);
    let child = VirtualPath::clone(
        &resolve(&roots, "/project/sub", Access::Read)
            .unwrap()
            .virtual_path,
    );
    assert_eq!(
        child.child("nested.txt").as_str(),
        "/project/sub/nested.txt"
    );
}

#[test]
fn resolves_native_spellings_inside_the_root() {
    let tree = Tree::new();
    let roots = tree.roots();
    let nested = tree.native("approved/sub/nested.txt");
    let resolved = resolve(&roots, &nested, Access::Read).unwrap();
    assert_eq!(
        resolved.real,
        tree.approved().join("sub").join("nested.txt")
    );
    assert_eq!(resolved.virtual_path.as_str(), "/project/sub/nested.txt");
    let resolved = resolve(&roots, &tree.native("approved"), Access::Read).unwrap();
    assert_eq!(resolved.virtual_path.as_str(), "/project");
    let padded = format!("  {nested}\u{feff}");
    assert_eq!(
        resolve(&roots, &padded, Access::Read)
            .unwrap()
            .virtual_path
            .as_str(),
        "/project/sub/nested.txt"
    );
    let missing = tree.native("approved/sub/none.txt");
    assert_eq!(
        text(refused(&roots, &missing, Access::Read)),
        "Not found: /project/sub/none.txt"
    );
    let created = resolve(&roots, &missing, Access::Create).unwrap();
    assert_eq!(created.virtual_path.as_str(), "/project/sub/none.txt");
}

#[cfg(windows)]
#[test]
fn resolves_native_windows_spellings_that_differ_only_in_case_separators_or_short_names() {
    let tree = Tree::new();
    let roots = tree.roots();
    let nested = tree.native("approved/sub/nested.txt");
    for input in [
        nested.to_uppercase(),
        nested.replace('\\', "/"),
        nested.to_lowercase(),
    ] {
        let resolved = resolve(&roots, &input, Access::Read).unwrap();
        assert_eq!(
            resolved.virtual_path.as_str(),
            "/project/sub/nested.txt",
            "{input}"
        );
        assert_eq!(
            resolved.real,
            tree.approved().join("sub").join("nested.txt")
        );
    }
    let long_name = tree.scratch.write("approved/a long file name.txt", b"x");
    let output = std::process::Command::new("cmd")
        .args(["/d", "/c"])
        .arg(format!(
            "for %I in (\"{}\") do @echo %~sI",
            long_name.display()
        ))
        .output()
        .unwrap();
    let short = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if !short.contains('~') {
        eprintln!("skipped: this volume has no 8.3 names");
        return;
    }
    let resolved = resolve(&roots, &short, Access::Read).unwrap();
    assert_eq!(
        resolved.virtual_path.as_str(),
        "/project/a long file name.txt"
    );
    let virtual_short = format!(
        "/project/{}",
        Path::new(&short).file_name().unwrap().to_string_lossy()
    );
    let resolved = resolve(&roots, &virtual_short, Access::Read).unwrap();
    assert_eq!(
        resolved.virtual_path.as_str(),
        "/project/a long file name.txt"
    );
}

#[test]
fn says_a_native_path_is_outside_and_suggests_the_approved_spelling() {
    let tree = Tree::new();
    let roots = tree.roots();
    let outside = tree.native("outside/secret.txt");
    assert_eq!(
        text(refused(&roots, &outside, Access::Read)),
        format!(
            "Native path \"{outside}\" is not inside an approved folder. Approved roots: /project"
        )
    );
    let guessed = if cfg!(windows) {
        "Q:\\project\\sub\\nested.txt"
    } else {
        "/elsewhere/project/sub/nested.txt"
    };
    assert_eq!(
        text(refused(&roots, guessed, Access::Read)),
        format!(
            "Native path \"{guessed}\" is not inside an approved folder. Approved roots: /project If you meant the approved folder, its path is /project/sub/nested.txt."
        )
    );
    let nested = text(refused(
        &roots,
        "/home/me/Project/sub/nested.txt",
        Access::Read,
    ));
    assert!(
        nested.ends_with(" If you meant the approved folder, its path is /project/sub/nested.txt."),
        "{nested}"
    );
    let root = text(refused(&roots, "/home/me/project", Access::Read));
    assert!(root.ends_with("its path is /project."), "{root}");
}

#[cfg(windows)]
#[test]
fn names_an_unknown_virtual_root_with_its_suggestion_on_windows() {
    let tree = Tree::new();
    assert_eq!(
        text(refused(
            &tree.roots(),
            "/home/me/Project/sub/nested.txt",
            Access::Read
        )),
        "Unknown root \"/home\". Approved roots: /project If you meant the approved folder, its path is /project/sub/nested.txt."
    );
}

#[cfg(windows)]
#[test]
fn keeps_wsl_linux_case_and_refuses_other_hosts_before_any_lookup() {
    let folder = "\\\\wsl.localhost\\Ubuntu\\home\\you\\Project";
    let work = roots(&[("work", Path::new(folder))]);
    for input in [
        "\\\\server\\share\\file.txt".to_owned(),
        folder.replace("Project", "project"),
    ] {
        assert_eq!(
            text(refused(&work, &input, Access::Create)),
            format!(
                "Native path \"{input}\" is not inside an approved folder. Approved roots: /work"
            )
        );
    }
    let alias = folder.replace("wsl.localhost", "wsl$");
    assert_eq!(
        refused(&work, &format!("{alias}\\..\\secret.txt"), Access::Read),
        SandboxError::Traversal
    );
    assert_eq!(
        cos_fs::validate_new_root(Path::new("\\\\server\\share\\folder"), &Roots::new([]))
            .unwrap_err(),
        SandboxError::NetworkPath
    );
}

#[cfg(unix)]
#[test]
fn allows_posix_names_that_windows_reserves_and_backslashes_as_name_characters() {
    let tree = Tree::new();
    let roots = tree.roots();
    for name in ["CON", "name:with-colon", "trailing.", "back\\slash.txt"] {
        tree.scratch
            .write(&format!("approved/{name}"), name.as_bytes());
        let resolved = resolve(&roots, &format!("/project/{name}"), Access::Read).unwrap();
        assert_eq!(resolved.real, tree.approved().join(name));
    }
    let base = resolve(&roots, "/project", Access::Read)
        .unwrap()
        .virtual_path;
    let relative = resolve_from(&roots, &base, "back\\slash.txt", Access::Read).unwrap();
    assert_eq!(relative.virtual_path.as_str(), "/project/back\\slash.txt");
}

#[test]
fn approves_new_roots_and_refuses_drives_files_and_overlaps() {
    let tree = Tree::new();
    let approved = tree.approved();
    let existing = roots(&[("project", &approved)]);
    assert_eq!(
        cos_fs::validate_new_root(&approved, &Roots::new([])).unwrap(),
        approved
    );
    assert_eq!(
        cos_fs::validate_new_root(Path::new("relative/path"), &Roots::new([])).unwrap_err(),
        SandboxError::NotAbsolute
    );
    let drive = approved.ancestors().last().unwrap();
    let whole = cos_fs::validate_new_root(drive, &Roots::new([])).unwrap_err();
    assert_eq!(
        whole.to_string(),
        if cfg!(windows) {
            "Approving an entire drive is not allowed. Pick a folder inside it."
        } else {
            "Approving the entire filesystem root is not allowed. Pick a folder inside it."
        }
    );
    assert_eq!(
        cos_fs::validate_new_root(&approved.join("file.txt"), &Roots::new([])).unwrap_err(),
        SandboxError::NotADirectory
    );
    let overlaps = "That folder overlaps the existing root \"/project\"";
    assert_eq!(
        cos_fs::validate_new_root(&approved.join("sub"), &existing)
            .unwrap_err()
            .to_string(),
        overlaps
    );
    assert_eq!(
        cos_fs::validate_new_root(tree.scratch.path(), &existing)
            .unwrap_err()
            .to_string(),
        overlaps
    );
    assert_eq!(
        cos_fs::validate_new_root(&tree.outside(), &existing).unwrap(),
        tree.outside()
    );
}

#[test]
fn normalises_root_names_and_avoids_collisions() {
    assert_eq!(cos_fs::normalise_root_name("My Documents"), "my-documents");
    assert_eq!(cos_fs::normalise_root_name("C++ Projects!"), "c-projects");
    assert_eq!(cos_fs::normalise_root_name("..."), "folder");
    assert_eq!(cos_fs::normalise_root_name(""), "folder");
    assert_eq!(cos_fs::normalise_root_name(&"a".repeat(80)).len(), 32);
    let existing = roots(&[("src", Path::new("/a")), ("src-2", Path::new("/b"))]);
    assert_eq!(
        cos_fs::unique_root_name(Path::new("/x/src"), &existing).unwrap(),
        "src-3"
    );
    assert_eq!(
        cos_fs::unique_root_name(Path::new("/x/other"), &existing).unwrap(),
        "other"
    );
    assert_eq!(
        cos_fs::unique_root_name(Path::new("/x/skills"), &existing).unwrap(),
        "skills-2"
    );
}

#[test]
fn the_managed_skills_root_replaces_a_user_root_of_that_name() {
    let user = |name: &str, path: &str| cos_types::config::Root {
        name: name.to_owned(),
        path: path.to_owned(),
        extra: Default::default(),
    };
    let config = [user("project", "/p"), user("Skills", "/mine")];
    let roots = Roots::from_config(&config, Path::new("/profile/skills"));
    let names: Vec<String> = roots.iter().map(|root| root.name.to_string()).collect();
    assert_eq!(names, ["/project", "/skills"]);
    assert_eq!(
        roots.get("skills").unwrap().folder,
        Path::new("/profile/skills")
    );
}
