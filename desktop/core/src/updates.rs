//! Ручная проверка обновлений Кабинета через GitHub Releases (только по нажатию пользователя).

use crate::http::{Http, Req};
use serde_json::{json, Value};

pub const RELEASE_API_URL: &str = "https://api.github.com/repos/shavkynov/kabinet/releases/latest";
pub const RELEASES_PREFIX: &str = "https://github.com/shavkynov/kabinet/";
pub const RELEASES_PAGE: &str = "https://github.com/shavkynov/kabinet/releases";

pub fn parse_semver(s: &str) -> Option<(u64, u64, u64)> {
    let trimmed = s.trim().strip_prefix(['v', 'V']).unwrap_or(s.trim());
    let core = trimmed.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let major: u64 = parts.next()?.parse().ok()?;
    let minor: u64 = parts.next().unwrap_or("0").parse().ok()?;
    let patch: u64 = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

pub fn is_newer(current: &str, latest: &str) -> bool {
    match (parse_semver(current), parse_semver(latest)) {
        (Some(cur), Some(lat)) => lat > cur,
        _ => false,
    }
}

pub fn safe_release_url(raw: Option<&str>) -> String {
    match raw.map(str::trim) {
        Some(u) if u.starts_with(RELEASES_PREFIX) => u.to_string(),
        _ => RELEASES_PAGE.to_string(),
    }
}

pub fn check_latest(http: &dyn Http, current: &str) -> Result<Value, String> {
    let resp = http.request(Req {
        method: "GET".into(),
        url: RELEASE_API_URL.into(),
        headers: vec![
            ("Accept".into(), "application/vnd.github+json".into()),
            ("User-Agent".into(), format!("Kabinet/{}", current)),
        ],
        body: None,
    }).map_err(|e| format!("Не удалось связаться с GitHub: {}", e))?;

    match resp.status {
        200 => {}
        403 | 429 => return Err("GitHub временно ограничил число запросов. Попробуйте чуть позже или откройте страницу релизов.".into()),
        404 => return Err("На GitHub пока нет опубликованных релизов.".into()),
        s => return Err(format!("GitHub вернул ошибку HTTP {}.", s)),
    }

    let body: Value = serde_json::from_slice(&resp.body)
        .map_err(|_| "Не удалось разобрать ответ GitHub о последнем релизе.".to_string())?;
    let tag = body.get("tag_name").and_then(|v| v.as_str()).unwrap_or("").trim();
    if tag.is_empty() {
        return Err("В ответе GitHub не указана версия релиза.".into());
    }
    let latest = tag.strip_prefix(['v', 'V']).unwrap_or(tag).to_string();
    let notes_raw = body.get("body").and_then(|v| v.as_str()).unwrap_or("").trim();
    let notes: String = notes_raw.chars().take(1800).collect();
    let published = body.get("published_at").and_then(|v| v.as_str()).unwrap_or("");
    let url = safe_release_url(body.get("html_url").and_then(|v| v.as_str()));

    Ok(json!({
        "current": current,
        "latest": latest,
        "hasUpdate": is_newer(current, &latest),
        "url": url,
        "notes": notes,
        "publishedAt": published,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::Resp;

    struct MockHttp(u16, String);
    impl Http for MockHttp {
        fn request(&self, _req: Req) -> Result<Resp, String> {
            Ok(Resp { status: self.0, body: self.1.as_bytes().to_vec(), location: None })
        }
    }

    #[test]
    fn semver_parsing_and_comparison() {
        assert_eq!(parse_semver("0.42.3"), Some((0, 42, 3)));
        assert_eq!(parse_semver("v1.2.10-rc.1"), Some((1, 2, 10)));
        assert!(is_newer("0.42.3", "0.42.4"));
        assert!(is_newer("0.42.3", "v0.43.0"));
        assert!(!is_newer("0.42.3", "0.42.3"));
        assert!(!is_newer("0.42.4", "0.42.3"));
        assert!(!is_newer("0.42.3", "not-a-version"));
    }

    #[test]
    fn check_latest_parses_update_and_sanitizes_url() {
        let http = MockHttp(200, serde_json::to_string(&json!({
            "tag_name": "v0.43.0",
            "html_url": "https://evil.example.com/phish",
            "body": "  Новые функции  ",
            "published_at": "2026-11-27T00:00:00Z"
        })).unwrap());
        let res = check_latest(&http, "0.42.3").unwrap();
        assert_eq!(res["latest"], json!("0.43.0"));
        assert_eq!(res["hasUpdate"], json!(true));
        assert_eq!(res["url"], json!(RELEASES_PAGE));
        assert_eq!(res["notes"], json!("Новые функции"));

        let same = MockHttp(200, serde_json::to_string(&json!({
            "tag_name": "v0.42.3",
            "html_url": "https://github.com/shavkynov/kabinet/releases/tag/v0.42.3"
        })).unwrap());
        let res2 = check_latest(&same, "0.42.3").unwrap();
        assert_eq!(res2["hasUpdate"], json!(false));
        assert_eq!(res2["url"], json!("https://github.com/shavkynov/kabinet/releases/tag/v0.42.3"));
    }

    #[test]
    fn check_latest_reports_rate_limit() {
        let http = MockHttp(403, "{}".into());
        let err = check_latest(&http, "0.42.3").unwrap_err();
        assert!(err.contains("ограничил"));
    }
}
