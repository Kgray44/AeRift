use tauri::Url;

/// Only a bounded, credential-free web destination may go to a platform browser.
/// Reject control characters before the URL parser can normalize them away.
pub(crate) fn browser_destination(raw: &str) -> Option<Url> {
    if raw.len() > 4096 || raw.chars().any(char::is_control) {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    Some(url)
}

#[cfg(test)]
mod tests {
    use super::browser_destination;

    #[test]
    fn accepts_bounded_web_destinations() {
        let url = browser_destination("https://example.test/docs?a=1#part").unwrap();
        assert_eq!(url.as_str(), "https://example.test/docs?a=1#part");
        assert!(browser_destination("http://example.test/").is_some());
        let root = "https://example.test/";
        assert!(browser_destination(&format!("{root}{}", "a".repeat(4096 - root.len()))).is_some());
    }

    #[test]
    fn rejects_non_web_credentials_controls_and_excess_input() {
        for raw in [
            "",
            "example.test/report",
            "file:///example",
            "data:,test",
            "aerift:test",
            "https://user:password@example.test/",
            "https://example.test/\nreport",
            "http://",
        ] {
            assert!(browser_destination(raw).is_none());
        }
        assert!(
            browser_destination(&format!("https://example.test/{}", "é".repeat(2048))).is_none()
        );
    }
}
