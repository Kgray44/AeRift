//! Narrow, deny-by-default origin policy for a disposable native browser proof.
//! This policy validates URL syntax and provenance, not DNS answers or connections.
use tauri::Url;

const MAX_URL_BYTES: usize = 4096;
const MAX_ORIGINS: usize = 8;

#[derive(Clone)]
pub(crate) struct BrowserPolicy {
    origins: Vec<String>,
}

fn web_url(raw: &str) -> Option<Url> {
    if raw.len() > MAX_URL_BYTES
        || raw.bytes().any(|byte| byte <= b' ' || byte == 0x7f || byte == b'\\')
    {
        return None;
    }
    let (scheme, tail) = raw.split_once("://")?;
    if !(scheme.eq_ignore_ascii_case("https") || scheme.eq_ignore_ascii_case("http")) {
        return None;
    }
    let authority = tail.split(['/', '?', '#']).next()?;
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    let parsed = Url::parse(raw).ok()?;
    if parsed.as_str().len() > MAX_URL_BYTES || !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    // The first proof deliberately accepts no IP literals, even globally routed ones.
    let host = parsed.host_str()?;
    let host = host.strip_suffix('.').unwrap_or(host);
    if !host.contains('.')
        || host.contains(':')
        || host.parse::<std::net::IpAddr>().is_ok()
        || ["localhost", "local", "lan", "internal", "home.arpa"].iter().any(|suffix| {
            host == *suffix || host.strip_suffix(*suffix).is_some_and(|prefix| prefix.ends_with('.'))
        })
    {
        return None;
    }
    Some(parsed)
}

impl BrowserPolicy {
    /// Only build/test configuration should supply this list, never a web page or IPC.
    pub(crate) fn from_approved_origins(approved: &[&str]) -> Option<Self> {
        if approved.is_empty() || approved.len() > MAX_ORIGINS {
            return None;
        }
        let mut origins = Vec::with_capacity(approved.len());
        for raw in approved {
            let parsed = web_url(raw)?;
            if parsed.path() != "/" || parsed.query().is_some() || parsed.fragment().is_some() {
                return None;
            }
            let origin = parsed.origin().ascii_serialization();
            if !origins.contains(&origin) {
                origins.push(origin);
            }
        }
        Some(Self { origins })
    }

    pub(crate) fn approved_url(&self, raw: &str) -> Option<Url> {
        let parsed = web_url(raw)?;
        let origin = parsed.origin().ascii_serialization();
        self.origins.contains(&origin).then_some(parsed)
    }
}

#[cfg(test)]
mod tests {
    use super::BrowserPolicy;

    #[test]
    fn rejects_missing_and_noncanonical_allowlist_entries() {
        for origins in [
            &[][..],
            &["https://builder.example/specific/path"][..],
            &["https://builder.example/?token=do-not-persist"][..],
            &["https://builder.example/#section"][..],
            &["https://tauri.localhost/"][..],
            &["https://name:secret@builder.example/"][..],
        ] {
            assert!(BrowserPolicy::from_approved_origins(origins).is_none());
        }
    }

    #[test]
    fn routes_only_explicit_origins_and_normalizes_http_addresses() {
        let p = BrowserPolicy::from_approved_origins(&["https://builder.example", "http://static.example:8080"])
            .expect("fixture origins should be approved");
        assert_eq!(
            p.approved_url("HTTPS://BUILDER.example:443/docs?a=1#intro")
                .expect("equivalent public origin")
                .as_str(),
            "https://builder.example/docs?a=1#intro"
        );
        assert!(p.approved_url("http://static.example:8080/image.png").is_some());
        for url in [
            "https://static.example:8080/",
            "https://builder.example:8443/",
            "http://builder.example/",
            "https://cdn.builder.example/",
            "https://builder.example.invalid/",
            "https://builder.example./",
            "https://@builder.example/",
            "https://builder.example\\invalid",
            "file:///C:/example.txt",
            "javascript:void(0)",
            "data:text/html,example",
            "tauri://localhost/",
            "https://ipc.localhost/",
            "http://127.0.0.1/",
            "http://2130706433/",
            "http://192.168.1.24/",
            "http://[::1]/",
            "https://x.home.arpa/",
            "https://service.internal/",
        ] {
            assert!(p.approved_url(url).is_none(), "{url}");
        }
    }
}
