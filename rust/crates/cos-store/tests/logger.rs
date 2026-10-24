//! app.log against logger.ts at the same fixed clock.

mod common;

use std::fs;

use common::{Scratch, oracle};
use cos_store::Logger;
use cos_store::logger::{LogLevel, redact};
use serde_json::Value;

fn level(word: &str) -> LogLevel {
    match word {
        "warn" => LogLevel::Warn,
        "error" => LogLevel::Error,
        _ => LogLevel::Info,
    }
}

fn replay(logger: &Logger, lines: &[Value]) {
    for line in lines {
        logger.log(
            level(line["level"].as_str().expect("level")),
            line["message"].as_str().expect("message"),
            line["agent"].as_str(),
        );
    }
}

#[test]
fn writes_the_same_log_as_typescript() {
    let doc = oracle("logger");
    let now = doc["now"].as_u64().expect("now");

    for case in doc["redactions"].as_array().expect("redactions") {
        assert_eq!(
            redact(case["input"].as_str().expect("input")),
            case["output"].as_str().expect("output")
        );
    }

    let scratch = Scratch::new("log");
    let file = scratch.path().join("app.log");
    let logger = Logger::with_clock(move || now, false);
    logger.mirror_to(&file);
    replay(&logger, doc["lines"].as_array().expect("lines"));
    logger.flush().expect("flushes");
    assert_eq!(
        fs::read_to_string(&file).expect("log"),
        doc["file"].as_str().expect("file")
    );
    assert_eq!(
        serde_json::to_value(logger.entries()).expect("entries"),
        doc["entries"]
    );

    let ring = Logger::with_clock(move || now, false);
    for n in 0..doc["ring"]["written"].as_u64().expect("written") {
        ring.info(&format!("line {n}"));
    }
    let entries = ring.entries();
    assert_eq!(
        entries.len() as u64,
        doc["ring"]["kept"].as_u64().expect("kept")
    );
    assert_eq!(
        entries.first().map(|e| e.message.as_str()),
        doc["ring"]["first"].as_str()
    );
    assert_eq!(
        entries.last().map(|e| e.message.as_str()),
        doc["ring"]["last"].as_str()
    );
}

#[test]
fn rotates_once_when_the_file_would_pass_its_limit() {
    let doc = oracle("logger");
    let now = doc["now"].as_u64().expect("now");
    let rotation = &doc["rotation"];
    let scratch = Scratch::new("rotate");
    let file = scratch.path().join("rotate.log");
    fs::write(
        &file,
        "r".repeat(rotation["before"].as_u64().expect("before") as usize),
    )
    .expect("full log");
    let logger = Logger::with_clock(move || now, false);
    logger.mirror_to(&file);
    logger.info("this line no longer fits");
    logger.flush().expect("flushes");
    assert_eq!(
        fs::read_to_string(&file).expect("current"),
        rotation["current"].as_str().expect("current")
    );
    let previous = fs::metadata(scratch.path().join("rotate.log.1"))
        .expect("rotated")
        .len();
    assert_eq!(
        previous,
        rotation["previousLength"].as_u64().expect("length")
    );
}

#[test]
fn exports_the_same_clipboard_and_json_text() {
    let doc = oracle("logger");
    let exports = oracle("logger-exports");
    let now = doc["now"].as_u64().expect("now");
    let logger = Logger::with_clock(move || now, false);
    replay(&logger, &doc["lines"].as_array().expect("lines")[..4]);
    assert_eq!(
        logger.clipboard_text(),
        exports["clipboard"].as_str().expect("clipboard")
    );
    assert_eq!(logger.json_text(), exports["json"].as_str().expect("json"));
}

#[test]
fn a_full_backlog_drops_lines_and_says_how_many() {
    let scratch = Scratch::new("backlog");
    let file = scratch.path().join("app.log");
    let logger = Logger::with_clock(|| 0, false);
    logger.mirror_to(&file);
    let line = "x ".repeat(8 * 1024);
    for _ in 0..200 {
        logger.info(&line);
    }
    logger.flush().expect("flushes");
    let text = fs::read_to_string(&file).expect("log");
    let written = text
        .lines()
        .filter(|l| l.ends_with("x ") || l.ends_with('x'))
        .count();
    let omitted: usize = text
        .lines()
        .filter_map(|l| {
            l.split("warn   ")
                .nth(1)?
                .strip_suffix(" log line(s) omitted: file writer backlog exceeded its byte limit.")
        })
        .map(|n| n.parse::<usize>().expect("count"))
        .sum();
    assert_eq!(
        written + omitted,
        200,
        "every line is either written or counted"
    );
}

#[test]
fn a_listener_that_panics_does_not_break_logging() {
    let logger = Logger::with_clock(|| 0, false);
    logger.on_log(|_| panic!("the window is gone"));
    logger.warn("still logged");
    assert_eq!(logger.entries().len(), 1);
}
