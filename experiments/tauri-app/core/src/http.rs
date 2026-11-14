//! HTTP для Яндекс Диска, входа в Яндекс и проверки текста. HTTP вынесен в трейт `Http`, чтобы тесты шли на поддельном сервере.
use std::time::Duration;

pub struct Req {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

pub struct Resp {
    pub status: u16,
    pub body: Vec<u8>,
    /// Заголовок Location у ответов-переадресаций (сами переходы клиент не выполняет).
    pub location: Option<String>,
}

pub trait Http: Send {
    fn request(&self, req: Req) -> Result<Resp, String>;
}

impl Http for Box<dyn Http> {
    fn request(&self, req: Req) -> Result<Resp, String> { (**self).request(req) }
}

/// Настоящие запросы через ureq. Коды 4xx/5xx возвращаются как обычный ответ.
pub struct UreqHttp {
    agent: ureq::Agent,
}

impl UreqHttp {
    pub fn new() -> Self { Self::with_timeout(120) }

    pub fn with_timeout(secs: u64) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(15))
            .timeout(Duration::from_secs(secs))
            .redirects(0)
            .build();
        UreqHttp { agent }
    }
}

const MAX_BODY: u64 = 256 * 1024 * 1024;

/// Читает ответ целиком, но не обрезает молча: слишком большой ответ - это ошибка, а не «файл поменьше».
pub fn read_capped(reader: impl std::io::Read, limit: u64) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut body = Vec::new();
    reader.take(limit + 1).read_to_end(&mut body).map_err(|e| e.to_string())?;
    if body.len() as u64 > limit {
        return Err(format!("ответ сервера больше {} МБ, файл не прочитан целиком", limit / (1024 * 1024)));
    }
    Ok(body)
}

impl Default for UreqHttp {
    fn default() -> Self { Self::new() }
}

impl Http for UreqHttp {
    fn request(&self, req: Req) -> Result<Resp, String> {
        let mut r = self.agent.request(&req.method, &req.url);
        for (k, v) in &req.headers { r = r.set(k, v); }
        let res = match &req.body {
            Some(b) => r.send_bytes(b),
            None => r.call(),
        };
        let resp = match res {
            Ok(x) => x,
            Err(ureq::Error::Status(_, x)) => x,
            Err(e) => return Err(e.to_string()),
        };
        let status = resp.status();
        let location = resp.header("location").map(String::from);
        let body = read_capped(resp.into_reader(), MAX_BODY)?;
        Ok(Resp { status, body, location })
    }
}

/// Повтор при обрыве связи и при ответах «подождите»/«сервер занят». Порт src/net-retry.js (упрощённо).
pub struct Retrying<H: Http> {
    pub inner: H,
    pub tries: u32,
    pub pause_ms: u64,
}

impl<H: Http> Retrying<H> {
    pub fn new(inner: H) -> Self { Retrying { inner, tries: 3, pause_ms: 700 } }
}

impl<H: Http> Http for Retrying<H> {
    fn request(&self, req: Req) -> Result<Resp, String> {
        let mut last: Result<Resp, String> = Err("нет ответа".into());
        for attempt in 0..self.tries.max(1) {
            if attempt > 0 && self.pause_ms > 0 {
                std::thread::sleep(Duration::from_millis(self.pause_ms * u64::from(attempt)));
            }
            let copy = Req { method: req.method.clone(), url: req.url.clone(), headers: req.headers.clone(), body: req.body.clone() };
            match self.inner.request(copy) {
                Ok(r) if matches!(r.status, 429 | 502 | 503 | 504) => last = Ok(r),
                Ok(r) => return Ok(r),
                Err(e) => last = Err(e),
            }
        }
        last
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retrying_repeats_busy_server() {
        use std::sync::atomic::{AtomicU32, Ordering};
        struct Flaky(AtomicU32);
        impl Http for Flaky { fn request(&self, _: Req) -> Result<Resp, String> {
            if self.0.fetch_add(1, Ordering::SeqCst) < 2 { Ok(Resp { status: 503, body: vec![], location: None }) } else { Ok(Resp { status: 200, body: b"ok".to_vec(), location: None }) }
        } }
        let mut r = Retrying::new(Flaky(AtomicU32::new(0)));
        r.pause_ms = 0;
        let res = r.request(Req { method: "GET".into(), url: "https://x".into(), headers: vec![], body: None }).unwrap();
        assert_eq!(res.status, 200);
    }

    #[test]
    fn read_capped_reports_oversized_bodies_instead_of_truncating() {
        assert_eq!(read_capped(&b"abcd"[..], 4).unwrap(), b"abcd".to_vec());
        assert!(read_capped(&b"abcde"[..], 4).unwrap_err().contains("больше"));
        assert!(read_capped(&b""[..], 4).unwrap().is_empty());
    }
}
