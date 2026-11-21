//! Системная проверка орфографии: Windows (ISpellChecker) и macOS (NSSpellChecker).
//! Окно просмотра само рисует красную волну, но слово и подсказки не отдаёт; здесь они берутся у той же системы.
//! На других системах (Linux) проверка недоступна: меню остаётся без вариантов.

use serde_json::{json, Value};

pub struct Verdict {
    pub ok: bool,
    pub suggestions: Vec<String>,
}

/// Проверить слово. None: системная проверка для этого языка недоступна.
pub fn check(word: &str, english: bool) -> Option<Verdict> {
    imp::check(word, english)
}

/// Добавить слово в пользовательский словарь системы (красная волна у него пропадёт и в других программах).
pub fn learn(word: &str, english: bool) -> bool {
    imp::learn(word, english)
}

pub fn to_json(v: Option<Verdict>) -> Value {
    match v {
        Some(v) => json!({ "available": true, "ok": v.ok, "suggestions": v.suggestions }),
        None => json!({ "available": false }),
    }
}

#[cfg(windows)]
mod imp {
    use super::Verdict;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Globalization::{ISpellChecker, ISpellCheckerFactory, SpellCheckerFactory};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn checker(english: bool) -> Option<ISpellChecker> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED); // S_FALSE «уже включён» не ошибка
            let factory: ISpellCheckerFactory = CoCreateInstance(&SpellCheckerFactory, None, CLSCTX_INPROC_SERVER).ok()?;
            let tag = wide(if english { "en-US" } else { "ru-RU" });
            if !factory.IsSupported(PCWSTR(tag.as_ptr())).ok()?.as_bool() { return None; }
            factory.CreateSpellChecker(PCWSTR(tag.as_ptr())).ok()
        }
    }

    pub fn check(word: &str, english: bool) -> Option<Verdict> {
        let c = checker(english)?;
        let w = wide(word);
        unsafe {
            let errors = c.Check(PCWSTR(w.as_ptr())).ok()?;
            let mut first = None;
            let _ = errors.Next(&mut first);
            if first.is_none() { return Some(Verdict { ok: true, suggestions: vec![] }); }
            let mut out = Vec::new();
            if let Ok(list) = c.Suggest(PCWSTR(w.as_ptr())) {
                for _ in 0..8 {
                    let mut item = [PWSTR::null()];
                    let mut got = 0u32;
                    if list.Next(&mut item, Some(&mut got)).0 != 0 || got == 0 { break; }
                    if let Ok(s) = item[0].to_string() { out.push(s); }
                    CoTaskMemFree(Some(item[0].0 as *const _));
                }
            }
            Some(Verdict { ok: false, suggestions: out })
        }
    }

    pub fn learn(word: &str, english: bool) -> bool {
        let Some(c) = checker(english) else { return false };
        let w = wide(word);
        unsafe { c.Add(PCWSTR(w.as_ptr())).is_ok() }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::Verdict;
    use objc2_app_kit::NSSpellChecker;
    use objc2_foundation::{NSRange, NSString};

    pub fn check(word: &str, _english: bool) -> Option<Verdict> {
        let sc = NSSpellChecker::sharedSpellChecker();
        let s = NSString::from_str(word);
        let r = sc.checkSpellingOfString_startingAt(&s, 0);
        if r.length == 0 { return Some(Verdict { ok: true, suggestions: vec![] }); }
        let range = NSRange::new(r.location, r.length);
        let guesses = sc.guessesForWordRange_inString_language_inSpellDocumentWithTag(range, &s, None, 0);
        let out = guesses.map(|a| a.iter().take(8).map(|g| g.to_string()).collect()).unwrap_or_default();
        Some(Verdict { ok: false, suggestions: out })
    }

    pub fn learn(word: &str, _english: bool) -> bool {
        NSSpellChecker::sharedSpellChecker().learnWord(&NSString::from_str(word));
        true
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    use super::Verdict;
    pub fn check(_word: &str, _english: bool) -> Option<Verdict> { None }
    pub fn learn(_word: &str, _english: bool) -> bool { false }
}
