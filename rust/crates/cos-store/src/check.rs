//! Field checks with zod's semantics, for parsing untrusted JSON into typed settings.
//!
//! A missing key is "undefined"; `null` is a value and fails every check that does not name it.
//! Objects drop keys they do not list, as `z.object` does. Lengths count UTF-16 units.

use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::js;

/// The first field that failed, as a dotted path. Diagnostics only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Invalid(pub String);

impl std::fmt::Display for Invalid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "invalid value at {}", self.0)
    }
}

impl std::error::Error for Invalid {}

pub(crate) type Check<T> = Result<T, Invalid>;

/// One JSON object being read, with the path used in errors.
pub(crate) struct Obj<'a> {
    map: &'a Map<String, Value>,
    path: String,
}

impl<'a> Obj<'a> {
    pub(crate) fn new(value: &'a Value, path: &str) -> Check<Self> {
        match value {
            Value::Object(map) => Ok(Self {
                map,
                path: path.to_owned(),
            }),
            _ => Err(Invalid(path.to_owned())),
        }
    }

    pub(crate) fn path(&self, key: &str) -> String {
        if self.path.is_empty() {
            key.to_owned()
        } else {
            format!("{}.{key}", self.path)
        }
    }

    /// `.strict()`: no key outside `known`.
    pub(crate) fn strict(&self, known: &[&str]) -> Check<()> {
        match self.map.keys().find(|key| !known.contains(&key.as_str())) {
            Some(key) => Err(Invalid(self.path(key))),
            None => Ok(()),
        }
    }

    /// A required field.
    pub(crate) fn req<T>(
        &self,
        key: &str,
        check: impl FnOnce(&'a Value, &str) -> Check<T>,
    ) -> Check<T> {
        let path = self.path(key);
        match self.map.get(key) {
            Some(value) => check(value, &path),
            None => Err(Invalid(path)),
        }
    }

    /// `.optional()`.
    pub(crate) fn opt<T>(
        &self,
        key: &str,
        check: impl FnOnce(&'a Value, &str) -> Check<T>,
    ) -> Check<Option<T>> {
        let path = self.path(key);
        self.map
            .get(key)
            .map(|value| check(value, &path))
            .transpose()
    }
}

/// `.optional().default(d).catch(c)`.
pub(crate) fn default_catch<T>(checked: Check<Option<T>>, default: T, caught: T) -> T {
    match checked {
        Ok(Some(value)) => value,
        Ok(None) => default,
        Err(_) => caught,
    }
}

pub(crate) fn boolean(value: &Value, path: &str) -> Check<bool> {
    value.as_bool().ok_or_else(|| Invalid(path.to_owned()))
}

/// `z.number().int().min(min).max(max)`.
pub(crate) fn int(value: &Value, path: &str, min: i64, max: i64) -> Check<i64> {
    js::safe_integer(value)
        .filter(|int| (min..=max).contains(int))
        .ok_or_else(|| Invalid(path.to_owned()))
}

pub(crate) fn string<'a>(value: &'a Value, path: &str) -> Check<&'a str> {
    value.as_str().ok_or_else(|| Invalid(path.to_owned()))
}

/// `z.string().min(min).max(max)`.
pub(crate) fn text(value: &Value, path: &str, min: usize, max: usize) -> Check<String> {
    let text = string(value, path)?;
    let units = js::len(text);
    if (min..=max).contains(&units) {
        Ok(text.to_owned())
    } else {
        Err(Invalid(path.to_owned()))
    }
}

/// `z.string().trim().min(min).max(max)`.
pub(crate) fn trimmed(value: &Value, path: &str, min: usize, max: usize) -> Check<String> {
    let text = js::trim(string(value, path)?);
    let units = js::len(text);
    if (min..=max).contains(&units) {
        Ok(text.to_owned())
    } else {
        Err(Invalid(path.to_owned()))
    }
}

/// `z.enum([...])`, through the enum's own serde spelling.
pub(crate) fn word<T: DeserializeOwned>(value: &Value, path: &str) -> Check<T> {
    match value {
        Value::String(_) => T::deserialize(value).map_err(|_| Invalid(path.to_owned())),
        _ => Err(Invalid(path.to_owned())),
    }
}

/// `z.array(item).max(max)`.
pub(crate) fn array<'a, T>(
    value: &'a Value,
    path: &str,
    max: usize,
    mut item: impl FnMut(&'a Value, &str) -> Check<T>,
) -> Check<Vec<T>> {
    let items = value
        .as_array()
        .filter(|items| items.len() <= max)
        .ok_or_else(|| Invalid(path.to_owned()))?;
    items
        .iter()
        .enumerate()
        .map(|(index, value)| item(value, &format!("{path}.{index}")))
        .collect()
}
