//! Argument validation against a tool's published JSON Schema, worded the way zod 4 words it.
//!
//! The TypeScript app validates with zod, and the MCP SDK joins zod's issues into the
//! `Input validation error: ...` text the model reads. This module walks the subset of JSON
//! Schema that zod emits for the declared tools and reproduces zod's issues: their messages,
//! their order (properties in declaration order, then unrecognized keys) and which issues stop
//! further checks (`invalid_type` and `invalid_value` abort; size and format checks continue).
//! It also returns the parsed value zod would have produced: unknown keys stripped, defaults
//! filled and integral numbers written as integers, which is what a tool's typed `Args` reads.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use regex::bytes::{Regex, RegexBuilder};
use serde_json::{Map, Number, Value};

/// One problem with a call's arguments: a dotted path (`plan.0.status`, empty for the
/// arguments object itself) and zod's message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArgIssue {
    pub path: String,
    pub message: String,
}

impl ArgIssue {
    pub fn new(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            message: message.into(),
        }
    }

    /// The SDK's `formatIssue`: the message alone at the root, else `path: message`.
    pub(crate) fn render(&self) -> String {
        if self.path.is_empty() {
            self.message.clone()
        } else {
            format!("{}: {}", self.path, self.message)
        }
    }
}

/// What zod knew about one string property that its published JSON Schema lost.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StringCheck {
    /// The property's dotted path, as its issues name it (`tabId`).
    pub path: &'static str,
    /// The flags of its `pattern` (`/.../i` is `"i"`), which JSON Schema cannot carry.
    pub flags: &'static str,
    /// The message its format or pattern check was declared with, in place of zod's default.
    pub message: Option<&'static str>,
}

struct Issue {
    path: Vec<String>,
    message: String,
    /// zod's `continue !== true`: later checks of the enclosing schema are skipped.
    aborts: bool,
}

/// The outcome of validating one arguments value.
pub(crate) struct Checked {
    /// What zod's parse would return. Present even when continuable issues were found.
    pub value: Value,
    pub issues: Vec<ArgIssue>,
    /// No issue stopped the walk, so zod would still run the schema's refinements.
    pub refinable: bool,
}

pub(crate) fn validate(schema: &Value, input: &Value, checks: &[StringCheck]) -> Checked {
    let mut walk = Walk {
        issues: Vec::new(),
        checks,
    };
    let mut path = Vec::new();
    let value = walk
        .check(schema, Some(input), &mut path)
        .unwrap_or(Value::Null);
    let refinable = !walk.issues.iter().any(|issue| issue.aborts);
    let issues = walk
        .issues
        .into_iter()
        .map(|issue| ArgIssue::new(issue.path.join("."), issue.message))
        .collect();
    Checked {
        value,
        issues,
        refinable,
    }
}

struct Walk<'a> {
    issues: Vec<Issue>,
    checks: &'a [StringCheck],
}

impl Walk<'_> {
    fn push(&mut self, path: &[String], message: String, aborts: bool) {
        self.issues.push(Issue {
            path: path.to_vec(),
            message,
            aborts,
        });
    }

    fn aborted_since(&self, start: usize) -> bool {
        self.issues[start..].iter().any(|issue| issue.aborts)
    }

    /// Checks `input` (`None` is JavaScript `undefined`) and returns the parsed value.
    fn check(
        &mut self,
        schema: &Value,
        input: Option<&Value>,
        path: &mut Vec<String>,
    ) -> Option<Value> {
        if let Some(options) = schema.get("enum").and_then(Value::as_array) {
            return self.check_enum(options, input, path);
        }
        match schema.get("type").and_then(Value::as_str) {
            Some("object") => self.check_object(schema, input, path),
            Some("array") => self.check_array(schema, input, path),
            Some("string") => self.check_string(schema, input, path),
            Some(kind @ ("number" | "integer")) => {
                self.check_number(schema, input, path, kind == "integer")
            }
            Some("boolean") => match input {
                Some(Value::Bool(flag)) => Some(Value::Bool(*flag)),
                other => self.invalid_type("boolean", other, path),
            },
            _ => input.cloned(),
        }
    }

    fn invalid_type(
        &mut self,
        expected: &str,
        input: Option<&Value>,
        path: &[String],
    ) -> Option<Value> {
        let message = format!(
            "Invalid input: expected {expected}, received {}",
            received(input)
        );
        self.push(path, message, true);
        None
    }

    fn check_enum(
        &mut self,
        options: &[Value],
        input: Option<&Value>,
        path: &[String],
    ) -> Option<Value> {
        if let Some(value) = input
            && options.contains(value)
        {
            return Some(value.clone());
        }
        let message = match options {
            [only] => format!("Invalid input: expected {}", primitive(only)),
            _ => {
                let joined: Vec<String> = options.iter().map(primitive).collect();
                format!("Invalid option: expected one of {}", joined.join("|"))
            }
        };
        self.push(path, message, true);
        None
    }

    fn check_object(
        &mut self,
        schema: &Value,
        input: Option<&Value>,
        path: &mut Vec<String>,
    ) -> Option<Value> {
        let Some(Value::Object(fields)) = input else {
            return self.invalid_type("object", input, path);
        };
        let empty = Map::new();
        let properties = schema
            .get("properties")
            .and_then(Value::as_object)
            .unwrap_or(&empty);
        let required: Vec<&str> = schema
            .get("required")
            .and_then(Value::as_array)
            .map(|names| names.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let mut parsed = Map::new();
        for (key, property) in properties {
            let present = fields.get(key);
            if present.is_none() {
                if let Some(default) = property.get("default") {
                    parsed.insert(key.clone(), default.clone());
                    continue;
                }
                if !required.contains(&key.as_str()) {
                    continue;
                }
            }
            path.push(key.clone());
            if let Some(value) = self.check(property, present, path) {
                parsed.insert(key.clone(), value);
            }
            path.pop();
        }
        if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
            let unknown: Vec<String> = fields
                .keys()
                .filter(|key| !properties.contains_key(*key))
                .map(|key| format!("\"{key}\""))
                .collect();
            if !unknown.is_empty() {
                let plural = if unknown.len() > 1 { "s" } else { "" };
                let message = format!("Unrecognized key{plural}: {}", unknown.join(", "));
                self.push(path, message, false);
            }
        }
        Some(Value::Object(parsed))
    }

    fn check_array(
        &mut self,
        schema: &Value,
        input: Option<&Value>,
        path: &mut Vec<String>,
    ) -> Option<Value> {
        let Some(Value::Array(items)) = input else {
            return self.invalid_type("array", input, path);
        };
        let start = self.issues.len();
        let mut parsed = Vec::with_capacity(items.len());
        match schema.get("items") {
            Some(item_schema) => {
                for (index, item) in items.iter().enumerate() {
                    path.push(index.to_string());
                    parsed.push(
                        self.check(item_schema, Some(item), path)
                            .unwrap_or(Value::Null),
                    );
                    path.pop();
                }
            }
            None => parsed.clone_from(items),
        }
        if !self.aborted_since(start) {
            self.check_size(schema, items.len(), "array", "items", path);
        }
        Some(Value::Array(parsed))
    }

    fn check_string(
        &mut self,
        schema: &Value,
        input: Option<&Value>,
        path: &[String],
    ) -> Option<Value> {
        let Some(Value::String(text)) = input else {
            return self.invalid_type("string", input, path);
        };
        // zod measures `String.length`, which counts UTF-16 code units.
        let length = text.encode_utf16().count();
        self.check_size(schema, length, "string", "characters", path);
        let dotted = path.join(".");
        let check = self.checks.iter().find(|check| check.path == dotted);
        let custom = check.and_then(|check| check.message);
        // zod publishes a format's own regex as `pattern`; the issue is the format's.
        match schema.get("format").and_then(Value::as_str) {
            Some("uuid") if !is_zod_uuid(text) => {
                let message = custom.unwrap_or("Invalid UUID");
                self.push(path, message.to_owned(), false);
            }
            Some(_) => {}
            None => {
                if let Some(pattern) = schema.get("pattern").and_then(Value::as_str) {
                    let flags = check.map_or("", |check| check.flags);
                    if !matches(pattern, flags, text) {
                        let message = custom.map_or_else(
                            || format!("Invalid string: must match pattern /{pattern}/{flags}"),
                            str::to_owned,
                        );
                        self.push(path, message, false);
                    }
                }
            }
        }
        Some(Value::String(text.clone()))
    }

    fn check_size(
        &mut self,
        schema: &Value,
        size: usize,
        origin: &str,
        unit: &str,
        path: &[String],
    ) {
        let bound = |key: &str| schema.get(key).and_then(Value::as_u64);
        let size = size as u64;
        let (min_key, max_key) = match origin {
            "array" => ("minItems", "maxItems"),
            _ => ("minLength", "maxLength"),
        };
        if let Some(min) = bound(min_key)
            && size < min
        {
            let message = format!("Too small: expected {origin} to have >={min} {unit}");
            self.push(path, message, false);
        }
        if let Some(max) = bound(max_key)
            && size > max
        {
            let message = format!("Too big: expected {origin} to have <={max} {unit}");
            self.push(path, message, false);
        }
    }

    fn check_number(
        &mut self,
        schema: &Value,
        input: Option<&Value>,
        path: &[String],
        integer: bool,
    ) -> Option<Value> {
        let Some(Value::Number(number)) = input else {
            return self.invalid_type("number", input, path);
        };
        let value = number.as_f64().unwrap_or(f64::NAN);
        if integer && value.fract() != 0.0 {
            self.push(
                path,
                "Invalid input: expected int, received number".to_owned(),
                true,
            );
            return None;
        }
        let bound = |key: &str| schema.get(key).and_then(Value::as_f64);
        if let Some(min) = bound("minimum")
            && value < min
        {
            self.push(
                path,
                format!("Too small: expected number to be >={}", js_number(min)),
                false,
            );
        }
        if let Some(min) = bound("exclusiveMinimum")
            && value <= min
        {
            self.push(
                path,
                format!("Too small: expected number to be >{}", js_number(min)),
                false,
            );
        }
        if let Some(max) = bound("maximum")
            && value > max
        {
            self.push(
                path,
                format!("Too big: expected number to be <={}", js_number(max)),
                false,
            );
        }
        if let Some(max) = bound("exclusiveMaximum")
            && value >= max
        {
            self.push(
                path,
                format!("Too big: expected number to be <{}", js_number(max)),
                false,
            );
        }
        Some(Value::Number(integral(number)))
    }
}

/// Compiled patterns by source and case-insensitivity; `None` for one that does not compile.
type Compiled = HashMap<(String, bool), Option<Regex>>;

/// Whether `text` matches the JavaScript regex `/pattern/flags`. Without the `u` flag a
/// JavaScript digit or word class is ASCII only, so the pattern is matched with Unicode off. A
/// pattern this engine cannot compile is not enforced. Compiled patterns are kept: they come
/// from the recorded declarations, a fixed set.
fn matches(pattern: &str, flags: &str, text: &str) -> bool {
    // `Regex` clones share one compiled program.
    static COMPILED: OnceLock<Mutex<Compiled>> = OnceLock::new();
    let ignore_case = flags.contains('i');
    let regex = {
        let mut compiled = COMPILED
            .get_or_init(Mutex::default)
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        compiled
            .entry((pattern.to_owned(), ignore_case))
            .or_insert_with(|| {
                RegexBuilder::new(pattern)
                    .unicode(false)
                    .case_insensitive(ignore_case)
                    .build()
                    .ok()
            })
            .clone()
    };
    regex.is_none_or(|regex| regex.is_match(text.as_bytes()))
}

/// `util.parsedType`, the word after `received`.
fn received(input: Option<&Value>) -> &'static str {
    match input {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

/// `util.stringifyPrimitive`: strings in double quotes, everything else as JavaScript prints it.
fn primitive(value: &Value) -> String {
    match value {
        Value::String(text) => format!("\"{text}\""),
        Value::Number(number) => js_number(number.as_f64().unwrap_or(f64::NAN)),
        other => other.to_string(),
    }
}

/// A number as JavaScript's `toString` prints the bounds that appear in schemas.
fn js_number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e21 {
        format!("{value:.0}")
    } else {
        value.to_string()
    }
}

/// JavaScript has one number type, so `1.0` is the integer 1. Writes it as an integer so a
/// tool's integer field deserializes it.
fn integral(number: &Number) -> Number {
    match number.as_f64() {
        Some(value)
            if number.is_f64() && value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 =>
        {
            // In range: the cast is exact.
            Number::from(value as i64)
        }
        _ => number.clone(),
    }
}

/// zod 4's `uuid` format: RFC 9562 versions 1 to 8 and variant 10xx, or the nil and max UUIDs.
fn is_zod_uuid(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    let lower = text.to_ascii_lowercase();
    if lower == "00000000-0000-0000-0000-000000000000"
        || lower == "ffffffff-ffff-ffff-ffff-ffffffffffff"
    {
        return true;
    }
    let shape = bytes.iter().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => *byte == b'-',
        _ => byte.is_ascii_hexdigit(),
    });
    shape
        && (b'1'..=b'8').contains(&bytes[14])
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn messages(schema: &Value, input: Value) -> Vec<String> {
        validate(schema, &input, &[])
            .issues
            .iter()
            .map(ArgIssue::render)
            .collect()
    }

    #[test]
    fn reports_properties_in_declaration_order_then_unknown_keys() {
        let schema = json!({
            "type": "object",
            "properties": {
                "window": {"type": "object", "properties": {}},
                "text": {"type": "string"}
            },
            "required": ["window", "text"],
            "additionalProperties": false
        });
        assert_eq!(
            messages(&schema, json!({"text": 5, "nope": 1, "also": 2})),
            [
                "window: Invalid input: expected object, received undefined",
                "text: Invalid input: expected string, received number",
                "Unrecognized keys: \"nope\", \"also\"",
            ]
        );
    }

    #[test]
    fn an_element_type_error_skips_the_array_size_check() {
        let schema = json!({"type": "array", "minItems": 3, "items": {"type": "string"}});
        assert_eq!(
            messages(&schema, json!([1])),
            ["0: Invalid input: expected string, received number"]
        );
        assert_eq!(
            messages(&schema, json!(["a"])),
            ["Too small: expected array to have >=3 items"]
        );
    }

    #[test]
    fn integers_and_bounds_use_zod_wording() {
        let schema = json!({"type": "integer", "minimum": 1, "maximum": 524288});
        assert_eq!(
            messages(&schema, json!(1.5)),
            ["Invalid input: expected int, received number"]
        );
        assert_eq!(
            messages(&schema, json!(0)),
            ["Too small: expected number to be >=1"]
        );
        assert_eq!(
            messages(&schema, json!(600000)),
            ["Too big: expected number to be <=524288"]
        );
        assert_eq!(validate(&schema, &json!(2.0), &[]).value, json!(2));
        let positive = json!({"type": "integer", "exclusiveMinimum": 0});
        assert_eq!(
            messages(&positive, json!(0)),
            ["Too small: expected number to be >0"]
        );
    }

    #[test]
    fn strings_count_utf16_units_and_check_uuids() {
        let schema = json!({"type": "string", "maxLength": 2});
        assert!(
            messages(&schema, json!("😀")).is_empty(),
            "one emoji is two UTF-16 units"
        );
        assert_eq!(
            messages(&schema, json!("😀a")),
            ["Too big: expected string to have <=2 characters"]
        );
        let uuid = json!({"type": "string", "format": "uuid"});
        assert_eq!(messages(&uuid, json!("nope")), ["Invalid UUID"]);
        assert!(messages(&uuid, json!("123e4567-e89b-42d3-a456-426614174000")).is_empty());
        assert!(messages(&uuid, json!("00000000-0000-0000-0000-000000000000")).is_empty());
    }

    const TAB: &str = r"^[a-f\d-]{36}:\d+$";

    fn issues(schema: &Value, input: Value, checks: &[StringCheck]) -> Vec<String> {
        validate(schema, &input, checks)
            .issues
            .iter()
            .map(ArgIssue::render)
            .collect()
    }

    #[test]
    fn a_pattern_is_checked_in_its_property_place_with_the_flags_zod_had() {
        let schema = json!({
            "type": "object",
            "properties": {
                "tabId": {"type": "string", "pattern": TAB},
                "maxNodes": {"type": "integer"}
            },
            "required": ["tabId"]
        });
        let tab = [StringCheck {
            path: "tabId",
            flags: "i",
            message: None,
        }];
        assert_eq!(
            issues(&schema, json!({"tabId": "x", "maxNodes": "a"}), &tab),
            [
                r"tabId: Invalid string: must match pattern /^[a-f\d-]{36}:\d+$/i",
                "maxNodes: Invalid input: expected number, received string",
            ]
        );
        let upper = json!({"tabId": "ABCDEF11-1111-4111-8111-111111111111:0"});
        assert!(
            issues(&schema, upper.clone(), &tab).is_empty(),
            "the i flag holds"
        );
        assert_eq!(
            issues(&schema, upper, &[]),
            [r"tabId: Invalid string: must match pattern /^[a-f\d-]{36}:\d+$/"],
            "without the tool's flags the published pattern is case sensitive"
        );
        let arabic_digit = json!({"tabId": "11111111-1111-4111-8111-111111111111:\u{0661}"});
        assert_eq!(
            issues(&schema, arabic_digit, &tab).len(),
            1,
            "a JavaScript digit class is ASCII only"
        );
    }

    #[test]
    fn every_recorded_pattern_compiles_so_none_goes_unenforced() {
        fn patterns<'a>(value: &'a Value, found: &mut Vec<&'a str>) {
            match value {
                Value::Object(fields) => {
                    if let Some(Value::String(pattern)) = fields.get("pattern") {
                        found.push(pattern);
                    }
                    fields.values().for_each(|field| patterns(field, found));
                }
                Value::Array(items) => items.iter().for_each(|item| patterns(item, found)),
                _ => {}
            }
        }
        let declarations: Value =
            serde_json::from_str(include_str!("../declarations.json")).expect("declarations");
        let mut found = Vec::new();
        patterns(&declarations, &mut found);
        assert!(!found.is_empty());
        for pattern in found {
            assert!(
                RegexBuilder::new(pattern).unicode(false).build().is_ok(),
                "{pattern}"
            );
        }
    }

    #[test]
    fn a_format_owns_its_published_pattern_and_may_carry_its_own_message() {
        let schema = json!({"type": "string", "format": "uuid", "pattern": "^never$"});
        assert!(messages(&schema, json!("123e4567-e89b-42d3-a456-426614174000")).is_empty());
        let page = [StringCheck {
            path: "",
            flags: "",
            message: Some("Copy the top-level pageId"),
        }];
        assert_eq!(
            issues(&schema, json!("nope"), &page),
            ["Copy the top-level pageId"]
        );
    }

    #[test]
    fn parsing_strips_unknown_keys_and_fills_defaults() {
        let schema = json!({
            "type": "object",
            "properties": {"mode": {"type": "string", "default": "auto"}, "n": {"type": "number"}}
        });
        let checked = validate(&schema, &json!({"n": 1, "extra": true}), &[]);
        assert!(checked.issues.is_empty());
        assert_eq!(checked.value, json!({"mode": "auto", "n": 1}));
    }

    #[test]
    fn only_continuable_issues_leave_refinements_running() {
        let schema = json!({"type": "object", "properties": {}, "additionalProperties": false});
        assert!(validate(&schema, &json!({"x": 1}), &[]).refinable);
        let typed =
            json!({"type": "object", "properties": {"a": {"type": "string"}}, "required": ["a"]});
        assert!(!validate(&typed, &json!({}), &[]).refinable);
    }
}
