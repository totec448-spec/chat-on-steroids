//! JSON building blocks that keep a Rust round trip identical to what `JSON.stringify` wrote.

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Fields a persisted object carried that this build does not know.
///
/// Every on-disk record flattens one of these last, so a file written by a newer or older
/// TypeScript build keeps its unknown keys through a Rust read and write.
pub type Extra = serde_json::Map<String, serde_json::Value>;

/// An ordered `Record<string, T>`; JavaScript objects keep insertion order and so does this.
pub type Record<T> = indexmap::IndexMap<String, T>;

/// A TypeScript `number` whose producer does not guarantee an integer.
///
/// Serializes the way `JSON.stringify` does for the values the app writes: an integral value
/// within the safe-integer range has no fraction (`12`, not `12.0`), anything else goes through
/// the shortest round-trip float form, and a non-finite value becomes `null`.
#[derive(Clone, Copy, Debug, Default, PartialEq, PartialOrd)]
pub struct JsNumber(pub f64);

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

impl Serialize for JsNumber {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let value = self.0;
        if value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER {
            // Exact: the guard above keeps the value inside i64 with no fraction.
            serializer.serialize_i64(value as i64)
        } else if value.is_finite() {
            serializer.serialize_f64(value)
        } else {
            serializer.serialize_unit()
        }
    }
}

impl<'de> Deserialize<'de> for JsNumber {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        f64::deserialize(deserializer).map(Self)
    }
}

impl From<f64> for JsNumber {
    fn from(value: f64) -> Self {
        Self(value)
    }
}

/// Deserializes a field that TypeScript types as `T | null` and also marks optional (`?`).
///
/// Absent stays `None` through `#[serde(default)]`; a present `null` becomes `Some(None)`;
/// a value becomes `Some(Some(value))`. Pair with
/// `skip_serializing_if = "Option::is_none"` so the three states write back unchanged.
pub fn nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// A TypeScript literal `true` field (`flag?: true`), present only when set.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct True;

impl Serialize for True {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(true)
    }
}

impl<'de> Deserialize<'de> for True {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if bool::deserialize(deserializer)? {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom("expected the literal true"))
        }
    }
}

/// A TypeScript literal `false` field, which tells one variant of a reply from another.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct False;

impl Serialize for False {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(false)
    }
}

impl<'de> Deserialize<'de> for False {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if bool::deserialize(deserializer)? {
            Err(serde::de::Error::custom("expected the literal false"))
        } else {
            Ok(Self)
        }
    }
}

/// A TypeScript literal `[]`: a list a reply always sends empty.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EmptyList;

impl Serialize for EmptyList {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        <[(); 0]>::serialize(&[], serializer)
    }
}

impl<'de> Deserialize<'de> for EmptyList {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let items = Vec::<serde::de::IgnoredAny>::deserialize(deserializer)?;
        if items.is_empty() {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom("expected an empty list"))
        }
    }
}

/// Declares a string enum whose JSON spellings are given verbatim, as TypeScript unions are.
macro_rules! string_enum {
    ($(#[$meta:meta])* $vis:vis enum $name:ident { $($(#[$vmeta:meta])* $variant:ident = $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
        $vis enum $name {
            $($(#[$vmeta])* #[serde(rename = $text)] $variant),+
        }

        impl $name {
            /// Every value, in the order the TypeScript source lists them.
            pub const ALL: &'static [$name] = &[$($name::$variant),+];

            /// The exact JSON spelling.
            pub const fn as_str(self) -> &'static str {
                match self { $($name::$variant => $text),+ }
            }
        }
    };
}
pub(crate) use string_enum;

/// Declares a TypeScript numeric literal (`version: 1`) that must match exactly on read.
macro_rules! literal_version {
    ($(#[$meta:meta])* $vis:vis struct $name:ident = $value:literal) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
        $vis struct $name;

        impl $name {
            /// The only value TypeScript writes.
            pub const VALUE: u64 = $value;
        }

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_u64($value)
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let found = u64::deserialize(deserializer)?;
                if found == $value {
                    Ok(Self)
                } else {
                    Err(serde::de::Error::custom(format_args!(
                        "unsupported {} version {found}, expected {}",
                        stringify!($name),
                        $value
                    )))
                }
            }
        }
    };
}
pub(crate) use literal_version;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_numbers_print_like_json_stringify() {
        let printed = |value: f64| serde_json::to_string(&JsNumber(value)).unwrap_or_default();
        assert_eq!(printed(12.0), "12");
        assert_eq!(printed(-3.0), "-3");
        assert_eq!(printed(1_730_000_000_123.456), "1730000000123.456");
        assert_eq!(printed(0.1), "0.1");
        assert_eq!(printed(f64::NAN), "null");
    }

    #[test]
    fn a_literal_version_refuses_any_other_number() {
        literal_version!(struct Two = 2);
        assert!(serde_json::from_str::<Two>("2").is_ok());
        assert!(serde_json::from_str::<Two>("3").is_err());
        assert_eq!(
            serde_json::to_string(&Two).unwrap_or_default(),
            Two::VALUE.to_string()
        );
    }
}
