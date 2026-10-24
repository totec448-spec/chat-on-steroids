//! Where the bridge may listen (`bridgePortSelection` in `bridge-ports.ts`).

use std::io;
use std::net::Ipv4Addr;

use cos_store::BridgePortOverride;
use cos_types::bridge::{BROWSER_BRIDGE_FALLBACK_PORTS, BROWSER_BRIDGE_PORTS};
use cos_types::config::BrowserBridgePort;

/// Auto's order, and exactly the list the extension scans (`extension/background.js` `PORTS`).
pub fn auto_ports() -> impl Iterator<Item = u16> {
    BROWSER_BRIDGE_PORTS
        .into_iter()
        .chain(BROWSER_BRIDGE_FALLBACK_PORTS)
}

/// The ports to try, in order, and whether `CLF_BRIDGE_PORTS` chose them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PortSelection {
    pub candidates: Vec<u16>,
    /// `CLF_BRIDGE_PORTS` holds the ports. Settings cannot change them then.
    pub overridden: bool,
}

impl PortSelection {
    pub fn new(choice: BrowserBridgePort, ports: Option<&BridgePortOverride>) -> Self {
        match ports {
            Some(ports) => Self {
                candidates: ports.ports().to_vec(),
                overridden: true,
            },
            None => Self {
                candidates: match choice {
                    BrowserBridgePort::Auto => auto_ports().collect(),
                    BrowserBridgePort::Fixed(port) => vec![port],
                },
                overridden: false,
            },
        }
    }

    /// Whether a listener could bind one of the candidates now, with the error text the bridge
    /// would report if none can. Settings checks a port change with this before it saves, as
    /// `publishBridgePortChange` refuses a save whose port it cannot bind.
    pub fn probe(&self) -> Result<(), String> {
        let mut failure = None;
        for &port in &self.candidates {
            match std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port)) {
                Ok(_) => return Ok(()),
                Err(error) => failure = Some((port, error)),
            }
        }
        Err(bind_failure(&self.candidates, failure))
    }
}

/// The message `prepareBridgeListener` throws when no candidate binds.
pub(crate) fn bind_failure(candidates: &[u16], failure: Option<(u16, io::Error)>) -> String {
    let ports = candidates
        .iter()
        .map(u16::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    match (candidates, &failure) {
        ([only], Some((_, error))) if error.kind() == io::ErrorKind::AddrInUse => {
            format!("Port {only} is already in use (EADDRINUSE).")
        }
        _ => format!(
            "Port{} {ports}: {}",
            if candidates.len() == 1 { "" } else { "s" },
            failure.map_or_else(
                || "unavailable".to_owned(),
                |(port, error)| node_listen_error(port, &error)
            )
        ),
    }
}

/// The `message` Node gives a failed `listen`, from the Rust error kind.
fn node_listen_error(port: u16, error: &io::Error) -> String {
    let (code, text) = match error.kind() {
        io::ErrorKind::AddrInUse => ("EADDRINUSE", "address already in use".to_owned()),
        io::ErrorKind::PermissionDenied => ("EACCES", "permission denied".to_owned()),
        io::ErrorKind::AddrNotAvailable => ("EADDRNOTAVAIL", "address not available".to_owned()),
        _ => ("UNKNOWN", error.to_string()),
    };
    format!("listen {code}: {text} 127.0.0.1:{port}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_uses_the_supported_order_and_a_fixed_choice_is_one_candidate() {
        let auto: Vec<u16> = auto_ports().collect();
        assert_eq!(
            auto,
            [
                8765, 8766, 8767, 8768, 8769, 18765, 18766, 18767, 18768, 18769, 38765, 38766,
                38767, 38768, 38769
            ]
        );
        assert_eq!(
            PortSelection::new(BrowserBridgePort::Auto, None),
            PortSelection {
                candidates: auto,
                overridden: false
            }
        );
        for port in BROWSER_BRIDGE_PORTS {
            assert_eq!(
                PortSelection::new(BrowserBridgePort::Fixed(port), None).candidates,
                [port]
            );
        }
    }

    #[test]
    fn the_environment_override_wins_over_the_setting_and_keeps_port_zero() {
        let fixed = BrowserBridgePort::Fixed(8767);
        let select = |raw: &str| PortSelection::new(fixed, BridgePortOverride::parse(raw).as_ref());
        assert_eq!(select("0").candidates, [0]);
        assert!(select("0").overridden);
        assert_eq!(select("12345, bad, 65536, -1, 0").candidates, [12345, 0]);
        let ignored = select("bad,-1");
        assert_eq!(
            (ignored.candidates, ignored.overridden),
            (vec![8767], false)
        );
    }

    #[test]
    fn a_probe_reports_a_taken_port_as_the_bridge_would_and_passes_a_free_one() {
        let blocker = std::net::TcpListener::bind("127.0.0.1:0").expect("binds");
        let taken = blocker.local_addr().expect("an address").port();
        let fixed = |port| PortSelection::new(BrowserBridgePort::Fixed(port), None);
        assert_eq!(
            fixed(taken).probe(),
            Err(format!("Port {taken} is already in use (EADDRINUSE)."))
        );
        let free = std::net::TcpListener::bind("127.0.0.1:0")
            .and_then(|listener| listener.local_addr())
            .expect("a free port")
            .port();
        assert_eq!(fixed(free).probe(), Ok(()));
        let both = PortSelection {
            candidates: vec![taken, free],
            overridden: false,
        };
        assert_eq!(both.probe(), Ok(()), "a later free candidate is enough");
        drop(blocker);
        assert_eq!(fixed(taken).probe(), Ok(()), "a released port binds again");
    }

    #[test]
    fn the_extension_scans_every_port_auto_may_choose() {
        let source = include_str!("../../../../extension/background.js");
        let line = source
            .lines()
            .find_map(|line| line.strip_prefix("const PORTS = ["))
            .and_then(|rest| rest.strip_suffix("];"))
            .expect("background.js declares PORTS");
        let scanned: Vec<u16> = line
            .split(',')
            .map(|port| port.trim().parse().expect("a port"))
            .collect();
        assert_eq!(scanned, auto_ports().collect::<Vec<_>>());
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../../../extension/manifest.json"))
                .expect("manifest.json");
        let hosts = manifest["host_permissions"].as_array().expect("hosts");
        for port in auto_ports() {
            let host = format!("http://127.0.0.1:{port}/*");
            assert!(hosts.iter().any(|entry| entry == &host), "{host}");
        }
    }
}
