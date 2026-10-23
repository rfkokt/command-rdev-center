//! Subscription quota: how much of each plan window is used and when it
//! resets, for the Claude login Claude Code keeps in the Keychain and for
//! every account connected to a 9router gateway.
//!
//! Providers expose percentages per window (5-hour, weekly), not remaining
//! tokens. Reset credits are redeemed through 9router's own routes, so Kern
//! never calls provider-internal reset endpoints itself.
//!
//! Secrets (the Claude access token, the 9router password and session
//! cookie) reach curl through `--config -` on stdin, never argv.

use serde::Serialize;
use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const CLAUDE_KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
const ROUTER_KEYCHAIN_SERVICE: &str = "command-rdev-center.9router";
const ROUTER_KEYCHAIN_ACCOUNT: &str = "dashboard";
pub const DEFAULT_ROUTER_URL: &str = "http://localhost:20128";

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct QuotaWindow {
    pub label: String,
    pub used_percent: f64,
    /// Unix seconds.
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct QuotaAccount {
    /// `"claude"` or `"9router:<connection id>"`.
    pub id: String,
    /// `"claude"` (Keychain) or `"9router"`.
    pub source: String,
    /// Provider id: `claude`, `codex`, `antigravity`, …
    pub provider: String,
    pub name: String,
    pub plan: Option<String>,
    pub windows: Vec<QuotaWindow>,
    /// Reset credits Kern can redeem for this account.
    pub reset_credits: u32,
    pub note: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct QuotaSnapshot {
    pub accounts: Vec<QuotaAccount>,
    pub router_configured: bool,
    /// Unix seconds.
    pub checked_at: i64,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Quote a value for a curl config file.
fn quoted(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

struct Reply {
    status: u16,
    headers: String,
    body: String,
}

/// Run curl with a config on stdin. `--write-out` appends the status code.
fn curl(config: &str) -> Result<Reply, String> {
    let mut child = Command::new("curl")
        .args([
            "--silent",
            "--show-error",
            "--max-time",
            "20",
            "--dump-header",
            "-",
            "--write-out",
            "\n%{http_code}",
            "--config",
            "-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("curl: {e}"))?;
    child
        .stdin
        .as_mut()
        .ok_or("curl stdin unavailable")?
        .write_all(config.as_bytes())
        .map_err(|e| e.to_string())?;
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    let (rest, code) = text.rsplit_once('\n').ok_or("curl: empty response")?;
    let (headers, body) = rest.split_once("\r\n\r\n").unwrap_or((rest, ""));
    Ok(Reply {
        status: code.trim().parse().unwrap_or(0),
        headers: headers.to_string(),
        body: body.to_string(),
    })
}

fn parse_time(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(n) => n
            .as_i64()
            .map(|t| if t > 10_000_000_000 { t / 1000 } else { t }),
        Value::String(s) => chrono_like_parse(s),
        _ => None,
    }
}

/// Minimal RFC 3339 parser (`2026-10-23T17:59:59.65+00:00`, `...Z`) to Unix
/// seconds, so this module needs no date crate.
fn chrono_like_parse(text: &str) -> Option<i64> {
    let (date, time) = text.split_once('T')?;
    let mut d = date.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let (clock, offset) = match time.find(['Z', '+', '-']) {
        Some(i) => (&time[..i], &time[i..]),
        None => (time, "Z"),
    };
    let mut c = clock.split(':');
    let h: i64 = c.next()?.parse().ok()?;
    let min: i64 = c.next()?.parse().ok()?;
    let sec: f64 = c.next().unwrap_or("0").parse().ok()?;
    let offset_secs = if offset.starts_with('Z') {
        0
    } else {
        let sign = if offset.starts_with('-') { -1 } else { 1 };
        let mut o = offset[1..].split(':');
        let oh: i64 = o.next()?.parse().ok()?;
        let om: i64 = o.next().unwrap_or("0").parse().ok()?;
        sign * (oh * 3600 + om * 60)
    };
    // Days from civil (Howard Hinnant).
    let (y, m) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * m + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + h * 3600 + min * 60 + sec as i64 - offset_secs)
}

// ------------------------------------------------------------------ Claude

fn claude_credentials() -> Result<Value, String> {
    let user = std::env::var("USER").unwrap_or_default();
    let bytes = security_framework::passwords::get_generic_password(CLAUDE_KEYCHAIN_SERVICE, &user)
        .map_err(|_| "No Claude Code login in the Keychain".to_string())?;
    serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|value| value.get("claudeAiOauth").cloned())
        .ok_or_else(|| "Claude Code login is unreadable".to_string())
}

fn claude_window(usage: &Value, key: &str, label: &str) -> Option<QuotaWindow> {
    let window = usage.get(key)?;
    Some(QuotaWindow {
        label: label.into(),
        used_percent: window.get("utilization")?.as_f64()?,
        resets_at: parse_time(window.get("resets_at")),
    })
}

fn parse_claude_usage(usage: &Value) -> Vec<QuotaWindow> {
    [
        ("five_hour", "5-hour"),
        ("seven_day", "Weekly"),
        ("seven_day_opus", "Weekly · Opus"),
        ("seven_day_sonnet", "Weekly · Sonnet"),
    ]
    .iter()
    .filter_map(|(key, label)| claude_window(usage, key, label))
    .collect()
}

fn claude_account() -> QuotaAccount {
    let mut account = QuotaAccount {
        id: "claude".into(),
        source: "claude".into(),
        provider: "claude".into(),
        name: "Claude".into(),
        plan: None,
        windows: Vec::new(),
        reset_credits: 0,
        note: None,
        error: None,
    };
    let creds = match claude_credentials() {
        Ok(creds) => creds,
        Err(error) => {
            account.error = Some(error);
            return account;
        }
    };
    account.plan = creds
        .get("subscriptionType")
        .and_then(Value::as_str)
        .map(str::to_string);
    // Kern never refreshes this token: rotating it would sign Claude Code out.
    let expires = creds.get("expiresAt").and_then(Value::as_i64).unwrap_or(0) / 1000;
    if expires > 0 && expires < now_secs() {
        account.error = Some("Claude login expired. Use Claude Code once to refresh it.".into());
        return account;
    }
    let Some(token) = creds.get("accessToken").and_then(Value::as_str) else {
        account.error = Some("Claude Code login has no access token".into());
        return account;
    };
    let config = format!(
        "url = \"https://api.anthropic.com/api/oauth/usage?cedar_ember=1\"\nheader = {}\nheader = \"anthropic-beta: oauth-2025-04-20\"\n",
        quoted(&format!("Authorization: Bearer {token}"))
    );
    match curl(&config) {
        Ok(reply) if reply.status == 200 => {
            let usage: Value = serde_json::from_str(&reply.body).unwrap_or(Value::Null);
            account.windows = parse_claude_usage(&usage);
            let grants = usage
                .pointer("/cedar_ember/grants")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            if grants > 0 {
                account.note = Some(format!(
                    "{grants} limit reset{} offered. Claim it in Claude Code, or connect Claude to 9router to reset from Kern.",
                    if grants == 1 { "" } else { "s" }
                ));
            }
        }
        Ok(reply) if reply.status == 401 => {
            account.error =
                Some("Claude login expired. Use Claude Code once to refresh it.".into());
        }
        Ok(reply) => account.error = Some(format!("Claude usage returned HTTP {}", reply.status)),
        Err(error) => account.error = Some(error),
    }
    account
}

// ----------------------------------------------------------------- 9router

static ROUTER_SESSION: Mutex<Option<(Instant, String)>> = Mutex::new(None);
const ROUTER_SESSION_TTL: Duration = Duration::from_secs(20 * 60 * 60);

fn router_password() -> Option<String> {
    security_framework::passwords::get_generic_password(
        ROUTER_KEYCHAIN_SERVICE,
        ROUTER_KEYCHAIN_ACCOUNT,
    )
    .ok()
    .and_then(|bytes| String::from_utf8(bytes).ok())
    .filter(|password| !password.is_empty())
}

fn router_url() -> String {
    crate::harness::read_settings()
        .router_url
        .filter(|url| !url.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_ROUTER_URL.into())
        .trim_end_matches('/')
        .to_string()
}

fn router_login(base: &str, password: &str) -> Result<String, String> {
    let body = json!({ "password": password }).to_string();
    let config = format!(
        "url = {}\nrequest = \"POST\"\nheader = \"Content-Type: application/json\"\ndata = {}\n",
        quoted(&format!("{base}/api/auth/login")),
        quoted(&body)
    );
    let reply = curl(&config).map_err(|e| format!("9router: {e}"))?;
    if reply.status == 401 || reply.status == 403 {
        return Err("9router rejected the password".into());
    }
    if reply.status != 200 {
        return Err(format!("9router login returned HTTP {}", reply.status));
    }
    reply
        .headers
        .lines()
        .filter(|line| line.to_ascii_lowercase().starts_with("set-cookie:"))
        .find_map(|line| {
            let cookie = line.split_once(':')?.1.trim();
            let value = cookie.strip_prefix("auth_token=")?;
            Some(value.split(';').next()?.to_string())
        })
        .ok_or_else(|| "9router login returned no session".into())
}

/// Authenticated request to 9router, logging in (again) when needed.
fn router_request(method: &str, path: &str) -> Result<Value, String> {
    let password = router_password().ok_or("9router password is not set")?;
    let base = router_url();
    for attempt in 0..2 {
        let cached = ROUTER_SESSION
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
            .filter(|(at, _)| attempt == 0 && at.elapsed() < ROUTER_SESSION_TTL)
            .map(|(_, token)| token);
        let token = match cached {
            Some(token) => token,
            None => {
                let token = router_login(&base, &password)?;
                if let Ok(mut guard) = ROUTER_SESSION.lock() {
                    *guard = Some((Instant::now(), token.clone()));
                }
                token
            }
        };
        let config = format!(
            "url = {}\nrequest = {}\nheader = {}\n",
            quoted(&format!("{base}{path}")),
            quoted(method),
            quoted(&format!("Cookie: auth_token={token}"))
        );
        let reply = curl(&config).map_err(|e| format!("9router: {e}"))?;
        if reply.status == 401 && attempt == 0 {
            if let Ok(mut guard) = ROUTER_SESSION.lock() {
                *guard = None;
            }
            continue;
        }
        let value: Value = serde_json::from_str(&reply.body).unwrap_or(Value::Null);
        if reply.status >= 400 {
            let message = value
                .get("message")
                .or_else(|| value.get("error"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("HTTP {}", reply.status));
            return Err(format!("9router: {message}"));
        }
        return Ok(value);
    }
    Err("9router session expired".into())
}

fn title_case(key: &str) -> String {
    key.split(['_', '-'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse_router_usage(usage: &Value) -> (Vec<QuotaWindow>, u32, Option<String>) {
    let mut windows = Vec::new();
    if let Some(quotas) = usage.get("quotas").and_then(Value::as_object) {
        for (key, quota) in quotas {
            if quota.get("unlimited").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let used = quota.get("used").and_then(Value::as_f64);
            let total = quota
                .get("total")
                .and_then(Value::as_f64)
                .filter(|t| *t > 0.0);
            let used_percent = match (used, total) {
                (Some(used), Some(total)) => used / total * 100.0,
                _ => match quota.get("remainingPercentage").and_then(Value::as_f64) {
                    Some(remaining) => 100.0 - remaining,
                    None => continue,
                },
            };
            let label = quota
                .get("displayName")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| match key.as_str() {
                    "session" => "5-hour".into(),
                    other => title_case(other),
                });
            windows.push(QuotaWindow {
                label,
                used_percent: used_percent.clamp(0.0, 100.0),
                resets_at: parse_time(quota.get("resetAt")),
            });
        }
    }
    let credits = usage
        .pointer("/resetCredits/availableCount")
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    let plan = usage
        .get("plan")
        .and_then(Value::as_str)
        .map(str::to_string);
    (windows, credits, plan)
}

fn router_accounts() -> Result<Vec<QuotaAccount>, String> {
    let supported: Vec<String> = router_request("GET", "/api/usage/providers")?
        .get("providers")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("id")?.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let connections: Vec<Value> = router_request("GET", "/api/providers")?
        .get("connections")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|c| c.get("isActive").and_then(Value::as_bool) != Some(false))
        .filter(|c| {
            c.get("provider")
                .and_then(Value::as_str)
                .is_some_and(|p| supported.iter().any(|s| s == p))
        })
        .collect();
    Ok(std::thread::scope(|scope| {
        let jobs: Vec<_> = connections
            .iter()
            .map(|connection| {
                scope.spawn(move || {
                    let id = connection.get("id").and_then(Value::as_str).unwrap_or("");
                    let provider = connection
                        .get("provider")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let mut account = QuotaAccount {
                        id: format!("9router:{id}"),
                        source: "9router".into(),
                        provider: provider.into(),
                        name: connection
                            .get("name")
                            .or_else(|| connection.get("email"))
                            .and_then(Value::as_str)
                            .unwrap_or(provider)
                            .to_string(),
                        plan: None,
                        windows: Vec::new(),
                        reset_credits: 0,
                        note: None,
                        error: None,
                    };
                    match router_request("GET", &format!("/api/usage/{id}")) {
                        Ok(usage) => {
                            let (windows, credits, plan) = parse_router_usage(&usage);
                            account.windows = windows;
                            // 9router can only redeem Codex credits today.
                            account.reset_credits = if provider == "codex" { credits } else { 0 };
                            account.plan = plan;
                        }
                        Err(error) => account.error = Some(error),
                    }
                    account
                })
            })
            .collect();
        jobs.into_iter().filter_map(|job| job.join().ok()).collect()
    }))
}

// ---------------------------------------------------------------- commands

static CACHE: Mutex<Option<(Instant, QuotaSnapshot)>> = Mutex::new(None);
/// Matches the frontend poll so several panels share one lookup.
const CACHE_TTL: Duration = Duration::from_secs(4 * 60);

fn snapshot() -> QuotaSnapshot {
    let settings = crate::harness::read_settings();
    let router_configured = router_password().is_some();
    let (claude, router) = std::thread::scope(|scope| {
        let claude = settings
            .quota_claude_enabled()
            .then(|| scope.spawn(claude_account));
        let router = router_configured.then(|| scope.spawn(router_accounts));
        (
            claude.and_then(|job| job.join().ok()),
            router.and_then(|job| job.join().ok()),
        )
    });
    let mut accounts: Vec<QuotaAccount> = claude.into_iter().collect();
    match router {
        Some(Ok(list)) => accounts.extend(list),
        Some(Err(error)) => accounts.push(QuotaAccount {
            id: "9router".into(),
            source: "9router".into(),
            provider: "9router".into(),
            name: "9router".into(),
            plan: None,
            windows: Vec::new(),
            reset_credits: 0,
            note: None,
            error: Some(error),
        }),
        None => {}
    }
    QuotaSnapshot {
        accounts,
        router_configured,
        checked_at: now_secs(),
    }
}

#[tauri::command]
pub async fn get_quota(refresh: Option<bool>) -> Result<QuotaSnapshot, String> {
    crate::pi_rpc::off_main_thread(move || {
        if !refresh.unwrap_or(false) {
            if let Some((at, cached)) = CACHE.lock().ok().and_then(|guard| guard.clone()) {
                if at.elapsed() < CACHE_TTL {
                    return Ok(cached);
                }
            }
        }
        let fresh = snapshot();
        if let Ok(mut guard) = CACHE.lock() {
            *guard = Some((Instant::now(), fresh.clone()));
        }
        Ok(fresh)
    })
    .await
}

/// Redeem one reset credit. Only from an explicit, confirmed click.
#[tauri::command]
pub async fn redeem_quota_reset(account_id: String) -> Result<String, String> {
    crate::pi_rpc::off_main_thread(move || {
        let connection = account_id
            .strip_prefix("9router:")
            .ok_or("Only 9router accounts can be reset from Kern")?;
        if !connection
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            return Err("Invalid account".into());
        }
        let reply = router_request(
            "POST",
            &format!("/api/usage/{connection}/codex-reset-credits"),
        )?;
        if let Ok(mut guard) = CACHE.lock() {
            *guard = None;
        }
        if reply.get("reset").and_then(Value::as_bool) == Some(false) {
            return Err(reply
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Reset was not applied")
                .to_string());
        }
        Ok(reply
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Limits reset")
            .to_string())
    })
    .await
}

#[derive(Debug, Clone, Serialize)]
pub struct QuotaSettings {
    pub claude: bool,
    pub router_url: String,
    pub router_password_set: bool,
}

#[tauri::command]
pub fn get_quota_settings() -> QuotaSettings {
    let settings = crate::harness::read_settings();
    QuotaSettings {
        claude: settings.quota_claude_enabled(),
        router_url: router_url(),
        router_password_set: router_password().is_some(),
    }
}

/// `password`: `None` keeps the stored one, `Some("")` removes it.
#[tauri::command]
pub async fn save_quota_settings(
    claude: bool,
    router_url: String,
    password: Option<String>,
) -> Result<QuotaSettings, String> {
    crate::pi_rpc::off_main_thread(move || {
        let url = router_url.trim().trim_end_matches('/').to_string();
        if !(url.is_empty() || url.starts_with("http://") || url.starts_with("https://")) {
            return Err("9router URL must start with http:// or https://".into());
        }
        if let Some(password) = password.as_deref() {
            if password.is_empty() {
                let _ = security_framework::passwords::delete_generic_password(
                    ROUTER_KEYCHAIN_SERVICE,
                    ROUTER_KEYCHAIN_ACCOUNT,
                );
            } else {
                // Check before storing so a typo is caught here, not on the next poll.
                router_login(
                    if url.is_empty() {
                        DEFAULT_ROUTER_URL
                    } else {
                        &url
                    },
                    password,
                )?;
                security_framework::passwords::set_generic_password(
                    ROUTER_KEYCHAIN_SERVICE,
                    ROUTER_KEYCHAIN_ACCOUNT,
                    password.as_bytes(),
                )
                .map_err(|e| format!("Keychain: {e}"))?;
            }
        }
        let mut settings = crate::harness::read_settings();
        settings.quota_claude = Some(claude);
        settings.router_url = (!url.is_empty() && url != DEFAULT_ROUTER_URL).then_some(url);
        crate::harness::write_settings(&settings)?;
        if let Ok(mut guard) = ROUTER_SESSION.lock() {
            *guard = None;
        }
        if let Ok(mut guard) = CACHE.lock() {
            *guard = None;
        }
        Ok(get_quota_settings())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rfc3339_with_offsets() {
        assert_eq!(chrono_like_parse("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            chrono_like_parse("2026-10-23T21:25:09.000Z"),
            Some(1_792_790_709)
        );
        assert_eq!(
            chrono_like_parse("2026-10-23T17:59:59.656536+00:00"),
            Some(1_792_778_399)
        );
        assert_eq!(
            chrono_like_parse("2026-10-24T00:59:59+07:00"),
            Some(1_792_778_399)
        );
        assert_eq!(
            parse_time(Some(&json!(1_792_790_532_000_i64))),
            Some(1_792_790_532)
        );
    }

    #[test]
    fn reads_claude_windows() {
        let usage = json!({
            "five_hour": { "utilization": 57.0, "resets_at": "2026-10-23T17:59:59+00:00" },
            "seven_day": { "utilization": 34.0, "resets_at": null },
            "seven_day_opus": null
        });
        let windows = parse_claude_usage(&usage);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].label, "5-hour");
        assert_eq!(windows[0].used_percent, 57.0);
        assert_eq!(windows[0].resets_at, Some(1_792_778_399));
        assert_eq!(windows[1].resets_at, None);
    }

    #[test]
    fn reads_9router_quotas_and_credits() {
        let codex = json!({
            "plan": "plus",
            "resetCredits": { "availableCount": 1 },
            "quotas": {
                "session": { "used": 0, "total": 100, "resetAt": "2026-10-23T21:25:09.000Z" },
                "weekly": { "used": 31, "total": 100, "resetAt": "2026-10-29T17:34:08.000Z" },
                "spark": { "unlimited": true }
            }
        });
        let (windows, credits, plan) = parse_router_usage(&codex);
        assert_eq!((credits, plan.as_deref()), (1, Some("plus")));
        let mut labels: Vec<_> = windows.iter().map(|w| w.label.as_str()).collect();
        labels.sort();
        assert_eq!(labels, ["5-hour", "Weekly"]);
        let weekly = windows.iter().find(|w| w.label == "Weekly").unwrap();
        assert_eq!(weekly.used_percent, 31.0);

        let antigravity = json!({ "quotas": {
            "gemini_weekly": { "used": 1000, "total": 1000, "displayName": "Gemini (Weekly)" },
            "claude_gpt_weekly": { "remainingPercentage": 40 }
        }});
        let (windows, credits, _) = parse_router_usage(&antigravity);
        assert_eq!(credits, 0);
        let used = |label: &str| {
            windows
                .iter()
                .find(|w| w.label == label)
                .map(|w| w.used_percent)
        };
        assert_eq!(used("Claude Gpt Weekly"), Some(60.0));
        assert_eq!(used("Gemini (Weekly)"), Some(100.0));
    }

    #[test]
    fn curl_config_values_are_escaped() {
        assert_eq!(quoted(r#"a"b\c"#), r#""a\"b\\c""#);
    }
}
