//! Standing order 16: the app never sends synthetic input. GPUI's `Window::activate_window`
//! presses Alt with `SendInput` to win the foreground, and that key reaches whatever window is in
//! front, so the app shows its window through `platform::reveal` instead.

#[test]
fn no_source_file_sends_synthetic_input() {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let forbidden = [
        "activate_window(",
        "SendInput",
        "keybd_event",
        "mouse_event",
    ];
    let mut offenders = Vec::new();
    for entry in std::fs::read_dir(&src).expect("src is readable") {
        let path = entry.expect("an entry").path();
        let text = std::fs::read_to_string(&path).expect("a source file");
        for (number, line) in text.lines().enumerate() {
            let code = line.split("//").next().unwrap_or_default();
            if forbidden.iter().any(|call| code.contains(call)) {
                offenders.push(format!(
                    "{}:{}: {}",
                    path.display(),
                    number + 1,
                    line.trim()
                ));
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "use platform::reveal, which shows the window without synthetic input:\n{}",
        offenders.join("\n")
    );
}
