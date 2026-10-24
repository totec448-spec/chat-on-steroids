//! The Host and Origin guards, decided the way the MCP SDK's `localhostHostValidation` and
//! `localhostOriginValidation` decide them: take the hostname WHATWG `new URL()` gives, ignore
//! the port, and allow only `localhost`, `127.0.0.1` and `[::1]`.
//!
//! The hostname parser covers what those guards depend on: schemes, credentials, ports,
//! percent-decoding, IPv4 in every WHATWG spelling (`127.1`, `2130706433`, `0x7f.0.0.1`) and
//! IPv6. It refuses non-ASCII domains instead of mapping them through IDNA, which is stricter
//! than Node: no such host can name loopback here.

use std::net::Ipv6Addr;

const ALLOWED: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];

/// A guard refusal: the `message` of the SDK's 403 JSON-RPC error.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Refused(pub(crate) String);

/// What the Host guard learned from an allowed `Host` header.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct AllowedHost {
    /// The header carried credentials (`user@localhost`). The SDK's Node adapter cannot build a
    /// request URL from it and answers 500.
    pub(crate) credentials: bool,
}

pub(crate) fn check_host(host: Option<&str>) -> Result<AllowedHost, Refused> {
    let host = match host {
        Some(host) if !host.is_empty() => host,
        _ => return Err(Refused("Missing Host header".to_owned())),
    };
    let Some(parsed) = parse(&format!("http://{host}")) else {
        return Err(Refused(format!("Invalid Host header: {host}")));
    };
    if ALLOWED.contains(&parsed.hostname.as_str()) {
        Ok(AllowedHost {
            credentials: parsed.credentials,
        })
    } else {
        Err(Refused(format!("Invalid Host: {}", parsed.hostname)))
    }
}

/// A missing or empty `Origin` passes: only browsers send one.
pub(crate) fn check_origin(origin: Option<&str>) -> Result<(), Refused> {
    let Some(origin) = origin.filter(|origin| !origin.is_empty()) else {
        return Ok(());
    };
    match parse(origin) {
        Some(parsed) if parsed.hostname.is_empty() => {
            Err(Refused(format!("Invalid Origin header: {origin}")))
        }
        Some(parsed) if ALLOWED.contains(&parsed.hostname.as_str()) => Ok(()),
        Some(parsed) => Err(Refused(format!("Invalid Origin: {}", parsed.hostname))),
        None => Err(Refused(format!("Invalid Origin header: {origin}"))),
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Parsed {
    hostname: String,
    credentials: bool,
}

/// `new URL(input)` reduced to `hostname`, or `None` where it throws.
fn parse(input: &str) -> Option<Parsed> {
    let input: String = input
        .trim_matches(|c: char| c <= ' ')
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    let (scheme, rest) = split_scheme(&input)?;
    match scheme.as_str() {
        "file" => file_host(rest),
        "http" | "https" | "ws" | "wss" | "ftp" => {
            let rest = rest.trim_start_matches(['/', '\\']);
            authority(until(rest, &['/', '\\', '?', '#']), true)
        }
        _ => match rest.strip_prefix("//") {
            Some(rest) => authority(until(rest, &['/', '?', '#']), false),
            None => Some(Parsed {
                hostname: String::new(),
                credentials: false,
            }),
        },
    }
}

fn split_scheme(input: &str) -> Option<(String, &str)> {
    let colon = input.find(':')?;
    let scheme = &input[..colon];
    let mut chars = scheme.chars();
    if !chars.next()?.is_ascii_alphabetic()
        || !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    {
        return None;
    }
    Some((scheme.to_ascii_lowercase(), &input[colon + 1..]))
}

fn until<'a>(text: &'a str, stops: &[char]) -> &'a str {
    text.find(stops).map_or(text, |end| &text[..end])
}

/// A `file:` URL has a host only after two slashes, and `localhost` there is the empty host.
fn file_host(rest: &str) -> Option<Parsed> {
    let mut chars = rest.chars();
    let slashes =
        matches!(chars.next(), Some('/' | '\\')) && matches!(chars.next(), Some('/' | '\\'));
    let host = if slashes {
        until(&rest[2..], &['/', '\\', '?', '#'])
    } else {
        ""
    };
    let hostname = match host {
        "" => String::new(),
        host => match special_host(host)? {
            localhost if localhost == "localhost" => String::new(),
            other => other,
        },
    };
    Some(Parsed {
        hostname,
        credentials: false,
    })
}

fn authority(authority: &str, special: bool) -> Option<Parsed> {
    let (credentials, host_port) = match authority.rfind('@') {
        Some(at) => (true, &authority[at + 1..]),
        None => (false, authority),
    };
    let (host, port) = split_port(host_port)?;
    if let Some(port) = port {
        valid_port(port)?;
    }
    let hostname = match (host.is_empty(), special) {
        (true, true) => return None,
        (true, false) => String::new(),
        (false, true) => special_host(host)?,
        (false, false) => opaque_host(host)?,
    };
    Some(Parsed {
        hostname,
        credentials,
    })
}

fn split_port(host_port: &str) -> Option<(&str, Option<&str>)> {
    if host_port.starts_with('[') {
        let end = host_port.find(']')?;
        let after = &host_port[end + 1..];
        if after.is_empty() {
            return Some((host_port, None));
        }
        return Some((&host_port[..=end], Some(after.strip_prefix(':')?)));
    }
    Some(match host_port.split_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (host_port, None),
    })
}

fn valid_port(port: &str) -> Option<()> {
    if port.is_empty() {
        return Some(());
    }
    if !port.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let value = port
        .trim_start_matches('0')
        .parse::<u32>()
        .ok()
        .or_else(|| port.bytes().all(|b| b == b'0').then_some(0))?;
    (value <= 65_535).then_some(())
}

/// The host of a special URL: IPv6, IPv4 or an ASCII domain.
fn special_host(host: &str) -> Option<String> {
    if let Some(inner) = host.strip_prefix('[') {
        return ipv6(inner.strip_suffix(']')?);
    }
    let decoded = percent_decode(host);
    let text = std::str::from_utf8(&decoded).ok()?;
    if text.is_empty() || !text.is_ascii() {
        return None;
    }
    let domain = text.to_ascii_lowercase();
    if domain.chars().any(forbidden_in_domain) {
        return None;
    }
    if ends_in_number(&domain) {
        return ipv4(&domain);
    }
    Some(domain)
}

/// The host of a non-special URL (`foo://LOCALHOST`): kept as written, case included.
fn opaque_host(host: &str) -> Option<String> {
    if let Some(inner) = host.strip_prefix('[') {
        return ipv6(inner.strip_suffix(']')?);
    }
    if host.chars().any(|c| c != '%' && forbidden_in_host(c)) {
        return None;
    }
    Some(host.to_owned())
}

fn forbidden_in_host(c: char) -> bool {
    matches!(
        c,
        '\0' | '\t'
            | '\n'
            | '\r'
            | ' '
            | '#'
            | '/'
            | ':'
            | '<'
            | '>'
            | '?'
            | '@'
            | '['
            | '\\'
            | ']'
            | '^'
            | '|'
    )
}

fn forbidden_in_domain(c: char) -> bool {
    forbidden_in_host(c) || c.is_ascii_control() || c == '%'
}

fn percent_decode(text: &str) -> Vec<u8> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |at: usize| bytes.get(at).and_then(|b| (*b as char).to_digit(16));
        match (bytes[i], hex(i + 1), hex(i + 2)) {
            (b'%', Some(high), Some(low)) => {
                out.push((high * 16 + low) as u8);
                i += 3;
            }
            (byte, _, _) => {
                out.push(byte);
                i += 1;
            }
        }
    }
    out
}

fn ends_in_number(domain: &str) -> bool {
    let mut parts: Vec<&str> = domain.split('.').collect();
    if parts.last() == Some(&"") {
        if parts.len() == 1 {
            return false;
        }
        parts.pop();
    }
    let last = parts.last().copied().unwrap_or_default();
    (!last.is_empty() && last.bytes().all(|b| b.is_ascii_digit())) || ipv4_number(last).is_some()
}

/// The WHATWG IPv4 parser: one to four parts, each decimal, octal (`0` prefix) or hex (`0x`).
fn ipv4(domain: &str) -> Option<String> {
    let mut parts: Vec<&str> = domain.split('.').collect();
    if parts.len() > 1 && parts.last() == Some(&"") {
        parts.pop();
    }
    if parts.len() > 4 {
        return None;
    }
    let numbers = parts
        .iter()
        .map(|part| ipv4_number(part))
        .collect::<Option<Vec<u64>>>()?;
    let (last, leading) = numbers.split_last()?;
    if leading.iter().any(|&number| number > 255) {
        return None;
    }
    if *last >= 256u64.pow(5 - numbers.len() as u32) {
        return None;
    }
    let mut address = *last;
    for (index, &number) in leading.iter().enumerate() {
        address += number << (8 * (3 - index));
    }
    let [a, b, c, d] = u32::try_from(address).ok()?.to_be_bytes();
    Some(format!("{a}.{b}.{c}.{d}"))
}

fn ipv4_number(part: &str) -> Option<u64> {
    if part.is_empty() {
        return None;
    }
    let (digits, radix) =
        if let Some(hex) = part.strip_prefix("0x").or_else(|| part.strip_prefix("0X")) {
            (hex, 16)
        } else if part.len() > 1 && part.starts_with('0') {
            (&part[1..], 8)
        } else {
            (part, 10)
        };
    if digits.is_empty() {
        return Some(0);
    }
    digits.chars().try_fold(0u64, |value, c| {
        let digit = u64::from(c.to_digit(radix)?);
        Some(value.saturating_mul(u64::from(radix)).saturating_add(digit))
    })
}

/// IPv6 serialized as WHATWG does: lowercase hex, the first longest run of two or more zero
/// pieces compressed, never a dotted IPv4 tail.
fn ipv6(inner: &str) -> Option<String> {
    let pieces = inner.parse::<Ipv6Addr>().ok()?.segments();
    let mut compress: Option<(usize, usize)> = None;
    let mut index = 0;
    while index < 8 {
        let run = pieces[index..]
            .iter()
            .take_while(|&&piece| piece == 0)
            .count();
        if run > 1 && compress.is_none_or(|(_, longest)| run > longest) {
            compress = Some((index, run));
        }
        index += run.max(1);
    }
    let mut out = String::from("[");
    let mut index = 0;
    while index < 8 {
        if let Some((start, run)) = compress.filter(|&(start, _)| start == index) {
            out.push_str(if start == 0 { "::" } else { ":" });
            index += run;
            continue;
        }
        out.push_str(&format!("{:x}", pieces[index]));
        if index != 7 {
            out.push(':');
        }
        index += 1;
    }
    out.push(']');
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(value: &str) -> Result<(), String> {
        check_host(Some(value))
            .map(|_| ())
            .map_err(|Refused(message)| message)
    }

    fn origin(value: &str) -> Result<(), String> {
        check_origin(Some(value)).map_err(|Refused(message)| message)
    }

    #[test]
    fn loopback_hosts_pass_in_every_spelling_the_sdk_accepts() {
        for value in [
            "127.0.0.1:5000",
            "localhost",
            "LOCALHOST:1",
            "localhost:",
            "127.1",
            "2130706433",
            "0x7f.0.0.1",
            "[::1]:5",
            "[0:0:0:0:0:0:0:1]",
            "%6cocalhost",
            "localhost/x",
        ] {
            assert_eq!(host(value), Ok(()), "{value}");
        }
    }

    #[test]
    fn foreign_and_malformed_hosts_are_refused_with_the_sdk_wording() {
        let cases = [
            ("evil.example", "Invalid Host: evil.example"),
            ("Evil.Example:80", "Invalid Host: evil.example"),
            ("10.0.0.1", "Invalid Host: 10.0.0.1"),
            ("localhost.", "Invalid Host: localhost."),
            ("[::2]", "Invalid Host: [::2]"),
            ("localhost:abc", "Invalid Host header: localhost:abc"),
            ("localhost:70000", "Invalid Host header: localhost:70000"),
            ("1.2.3.4.5", "Invalid Host header: 1.2.3.4.5"),
            ("1.2.3.256", "Invalid Host header: 1.2.3.256"),
            ("[::1", "Invalid Host header: [::1"),
            ("a b", "Invalid Host header: a b"),
            ("foo.123", "Invalid Host header: foo.123"),
        ];
        for (value, message) in cases {
            assert_eq!(host(value), Err(message.to_owned()), "{value}");
        }
        assert_eq!(
            check_host(None),
            Err(Refused("Missing Host header".to_owned()))
        );
        assert_eq!(
            check_host(Some("")),
            Err(Refused("Missing Host header".to_owned()))
        );
    }

    #[test]
    fn credentials_in_the_host_are_reported() {
        assert_eq!(
            check_host(Some("evil@localhost")),
            Ok(AllowedHost { credentials: true })
        );
    }

    #[test]
    fn origins_follow_the_sdk_including_null_and_opaque_schemes() {
        for value in [
            "http://localhost",
            "HTTP://LOCALHOST:9",
            "http:localhost",
            "http://[::1]:3",
            "http://u:p@localhost",
            "foo://localhost",
        ] {
            assert_eq!(origin(value), Ok(()), "{value}");
        }
        assert_eq!(check_origin(None), Ok(()));
        assert_eq!(origin(""), Ok(()));
        let cases = [
            ("null", "Invalid Origin header: null"),
            ("not a url", "Invalid Origin header: not a url"),
            ("file:///x", "Invalid Origin header: file:///x"),
            (
                "file://localhost/x",
                "Invalid Origin header: file://localhost/x",
            ),
            ("foo:localhost", "Invalid Origin header: foo:localhost"),
            ("https://evil.example", "Invalid Origin: evil.example"),
            ("https://evil.example:8443", "Invalid Origin: evil.example"),
            (
                "http://evil.example/path?q#f",
                "Invalid Origin: evil.example",
            ),
            ("chrome-extension://abcdef", "Invalid Origin: abcdef"),
            ("foo://LOCALHOST", "Invalid Origin: LOCALHOST"),
        ];
        for (value, message) in cases {
            assert_eq!(origin(value), Err(message.to_owned()), "{value}");
        }
    }

    #[test]
    fn ipv6_is_serialized_as_whatwg_does() {
        assert_eq!(ipv6("0:0:0:0:0:0:0:1").as_deref(), Some("[::1]"));
        assert_eq!(ipv6("1:0:0:2:0:0:0:3").as_deref(), Some("[1:0:0:2::3]"));
        assert_eq!(ipv6("::ffff:1.2.3.4").as_deref(), Some("[::ffff:102:304]"));
        assert_eq!(
            ipv6("1:2:3:4:5:6:7:8").as_deref(),
            Some("[1:2:3:4:5:6:7:8]")
        );
        assert_eq!(ipv6("1::").as_deref(), Some("[1::]"));
    }
}
