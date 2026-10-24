//! Apache-2.0 section 4(d): the vendored Codex code's NOTICE ships with the binaries. The
//! notices file is generated from `rust/about.hbs`, which carries the text, so a NOTICE that
//! changes with a new vendored commit fails here until the template does too.

use std::path::Path;

#[test]
fn the_shipped_notices_carry_the_codex_notice_verbatim() {
    let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let notice = std::fs::read_to_string(crate_dir.join("codex/NOTICE")).expect("codex/NOTICE");
    let shipped = std::fs::read_to_string(crate_dir.join("../../THIRD-PARTY-NOTICES.txt"))
        .expect("THIRD-PARTY-NOTICES.txt");
    let normalize = |text: &str| text.replace("\r\n", "\n");
    assert!(!notice.trim().is_empty());
    assert!(
        normalize(&shipped).contains(&normalize(&notice)),
        "rust/about.hbs must reproduce codex/NOTICE; regenerate with `node rust/scripts/check-notices.mjs --write`"
    );
}
