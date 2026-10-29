//! Subscription quota: how much of each plan window is used and when it
//! resets, for the Claude login Claude Code keeps in the Keychain and for
//! every account connected to the user's 9router gateways (e.g. a local one
//! and one on a VPS).
//!
//! Providers expose percentages per window (5-hour, weekly), not remaining
//! tokens. Reset credits are redeemed through 9router's own routes, so Kern
//! never calls provider-internal reset endpoints itself.
//!
//! Secrets (the Claude access token, the 9router password and session
//! cookie) reach curl through `--config -` on stdin, never argv.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const CLAUDE_KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
mod claude_auth;
/// One Keychain entry per router, keyed by `RouterConfig::id`.
const ROUTER_KEYCHAIN_SERVICE: &str = "command-rdev-center.9router";

/// A 9router gateway, stored in `harnesses.json` (password in the Keychain).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct RouterConfig {
    pub id: String,
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct QuotaWindow {
    pub label: String,
    pub used_percent: f64,
    /// Unix seconds.
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct QuotaAccount {
    /// `"claude"` or `"9router:<router id>:<connection id>"`.
    pub id: String,
    /// Heading the panel groups this account under ("Claude", router name).
    pub group: String,
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
    /// Routers with a stored password.
    pub routers: usize,
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
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\r', "\\r")
            .replace('\n', "\\n")
    )
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

/// Last good Claude usage reply, and when Anthropic lets Kern ask again.
#[derive(Default)]
struct ClaudeUsage {
    credential_token: Option<String>,
    fetched: Option<(Instant, Vec<QuotaWindow>, Option<String>)>,
    last_try: Option<Instant>,
    blocked_until: Option<Instant>,
}
static CLAUDE_USAGE: LazyLock<Mutex<ClaudeUsage>> =
    LazyLock::new(|| Mutex::new(ClaudeUsage::default()));
/// The usage endpoint rate-limits hard (429 + Retry-After). Several chats
/// refreshing after every reply would trip it, so a good reply is reused for
/// `CLAUDE_REUSE` and calls are never closer than `CLAUDE_MIN_RETRY`.
const CLAUDE_REUSE: Duration = Duration::from_secs(90);
const CLAUDE_MIN_RETRY: Duration = Duration::from_secs(30);
const CLAUDE_DEFAULT_BACKOFF: u64 = 5 * 60;

fn claude_usage() -> std::sync::MutexGuard<'static, ClaudeUsage> {
    CLAUDE_USAGE.lock().unwrap_or_else(|e| e.into_inner())
}

fn rate_limited(wait_secs: u64) -> String {
    format!(
        "Anthropic is rate-limiting usage checks; Kern retries in {}m.",
        wait_secs.div_ceil(60).max(1)
    )
}

fn retry_after(headers: &str) -> Option<u64> {
    headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if !name.trim().eq_ignore_ascii_case("retry-after") {
            return None;
        }
        value.trim().parse().ok()
    })
}

/// Fill `account` from the last good reply; with nothing cached, `reason`
/// becomes the error.
fn claude_from_cache(usage: &ClaudeUsage, account: &mut QuotaAccount, reason: Option<String>) {
    match &usage.fetched {
        Some((at, windows, note)) => {
            account.windows = windows.clone();
            account.note = match reason {
                Some(reason) => {
                    let minutes = at.elapsed().as_secs() / 60;
                    let age = if minutes == 0 {
                        "just now".to_string()
                    } else {
                        format!("{minutes}m ago")
                    };
                    Some(format!("{reason} Showing data from {age}."))
                }
                None => note.clone(),
            };
        }
        None => account.error = reason,
    }
}

fn claude_account() -> QuotaAccount {
    // Backend callers can overlap even though the frontend shares requests.
    static LOOKUP: Mutex<()> = Mutex::new(());
    let _lookup = LOOKUP.lock().unwrap_or_else(|error| error.into_inner());
    let mut account = QuotaAccount {
        id: "claude".into(),
        group: "Claude".into(),
        source: "claude".into(),
        provider: "claude".into(),
        name: "Claude".into(),
        plan: None,
        windows: Vec::new(),
        reset_credits: 0,
        note: None,
        error: None,
    };
    let mut creds = match claude_auth::credentials(None) {
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
    let Some(token) = creds.get("accessToken").and_then(Value::as_str) else {
        account.error = Some("Claude Code login has no access token".into());
        return account;
    };
    {
        let mut usage = claude_usage();
        if usage.credential_token.as_deref() != Some(token) {
            // A different login must never inherit another account's quota.
            *usage = ClaudeUsage {
                credential_token: Some(token.to_string()),
                ..ClaudeUsage::default()
            };
        }
        let now = Instant::now();
        if let Some(until) = usage.blocked_until.filter(|until| *until > now) {
            let reason = rate_limited((until - now).as_secs());
            claude_from_cache(&usage, &mut account, Some(reason));
            return account;
        }
        let fresh = usage
            .fetched
            .as_ref()
            .is_some_and(|(at, _, _)| at.elapsed() < CLAUDE_REUSE);
        let too_soon = usage
            .last_try
            .is_some_and(|at| at.elapsed() < CLAUDE_MIN_RETRY);
        if fresh || (too_soon && usage.fetched.is_some()) {
            claude_from_cache(&usage, &mut account, None);
            return account;
        }
        usage.last_try = Some(now);
    }
    let reply = claude_reply(
        &mut creds,
        |token| {
            curl(&format!(
            "url = \"https://api.anthropic.com/api/oauth/usage?cedar_ember=1\"\nheader = {}\nheader = \"anthropic-beta: oauth-2025-04-20\"\n",
            quoted(&format!("Authorization: Bearer {token}"))
        ))
        },
        |token| claude_auth::credentials(Some(token)),
    );
    account.plan = creds
        .get("subscriptionType")
        .and_then(Value::as_str)
        .map(str::to_string);
    {
        let mut usage = claude_usage();
        let token = creds.get("accessToken").and_then(Value::as_str);
        if usage.credential_token.as_deref() != token {
            *usage = ClaudeUsage {
                credential_token: token.map(str::to_string),
                last_try: Some(Instant::now()),
                ..ClaudeUsage::default()
            };
        }
    }
    match reply {
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
            let mut usage = claude_usage();
            usage.fetched = Some((
                Instant::now(),
                account.windows.clone(),
                account.note.clone(),
            ));
            usage.blocked_until = None;
        }
        Ok(reply) if reply.status == 429 => {
            let wait = retry_after(&reply.headers)
                .unwrap_or(CLAUDE_DEFAULT_BACKOFF)
                .clamp(60, 30 * 60);
            let mut usage = claude_usage();
            usage.blocked_until = Some(Instant::now() + Duration::from_secs(wait));
            claude_from_cache(&usage, &mut account, Some(rate_limited(wait)));
        }
        Ok(reply) if reply.status == 401 => {
            account.error = Some(CLAUDE_EXPIRED.into());
        }
        Ok(reply) => account.error = Some(format!("Claude usage returned HTTP {}", reply.status)),
        Err(error) => account.error = Some(error),
    }
    account
}

/// A server can reject an access token before its recorded expiry. Recover
/// once and retry the usage GET once; repeated 401s must not rotate in a loop.
fn claude_reply(
    creds: &mut Value,
    request: impl Fn(&str) -> Result<Reply, String>,
    recover: impl Fn(&str) -> Result<Value, String>,
) -> Result<Reply, String> {
    let token = creds
        .get("accessToken")
        .and_then(Value::as_str)
        .ok_or("Claude Code login has no access token")?;
    let reply = request(token)?;
    if reply.status != 401 {
        return Ok(reply);
    }
    *creds = recover(token)?;
    request(
        creds
            .get("accessToken")
            .and_then(Value::as_str)
            .ok_or("Claude Code login has no access token")?,
    )
}

// ----------------------------------------------------------------- 9router

static ROUTER_SESSIONS: LazyLock<Mutex<HashMap<String, (Instant, String)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const ROUTER_SESSION_TTL: Duration = Duration::from_secs(20 * 60 * 60);

fn routers() -> Vec<RouterConfig> {
    crate::harness::read_settings().routers
}

fn router_password(id: &str) -> Option<String> {
    security_framework::passwords::get_generic_password(ROUTER_KEYCHAIN_SERVICE, id)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .filter(|password| !password.is_empty())
}

fn forget_session(id: &str) {
    if let Ok(mut sessions) = ROUTER_SESSIONS.lock() {
        sessions.remove(id);
    }
}

fn router_login(base: &str, password: &str) -> Result<String, String> {
    let body = json!({ "password": password }).to_string();
    let config = format!(
        "url = {}\nrequest = \"POST\"\nheader = \"Content-Type: application/json\"\ndata = {}\n",
        quoted(&format!("{base}/api/auth/login")),
        quoted(&body)
    );
    let reply = curl(&config)?;
    if reply.status == 401 || reply.status == 403 {
        return Err("password rejected".into());
    }
    if reply.status != 200 {
        return Err(format!("login returned HTTP {}", reply.status));
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
        .ok_or_else(|| "login returned no session".into())
}

/// Authenticated request to one router, logging in (again) when needed.
fn router_request(router: &RouterConfig, method: &str, path: &str) -> Result<Value, String> {
    let password = router_password(&router.id).ok_or("password is not set")?;
    for attempt in 0..2 {
        let cached = ROUTER_SESSIONS
            .lock()
            .ok()
            .and_then(|sessions| sessions.get(&router.id).cloned())
            .filter(|(at, _)| attempt == 0 && at.elapsed() < ROUTER_SESSION_TTL)
            .map(|(_, token)| token);
        let token = match cached {
            Some(token) => token,
            None => {
                let token = router_login(&router.url, &password)?;
                if let Ok(mut sessions) = ROUTER_SESSIONS.lock() {
                    sessions.insert(router.id.clone(), (Instant::now(), token.clone()));
                }
                token
            }
        };
        let config = format!(
            "url = {}\nrequest = {}\nheader = {}\n",
            quoted(&format!("{}{path}", router.url)),
            quoted(method),
            quoted(&format!("Cookie: auth_token={token}"))
        );
        let reply = curl(&config)?;
        if reply.status == 401 && attempt == 0 {
            forget_session(&router.id);
            continue;
        }
        let value: Value = serde_json::from_str(&reply.body).unwrap_or(Value::Null);
        if reply.status >= 400 {
            return Err(value
                .get("message")
                .or_else(|| value.get("error"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("HTTP {}", reply.status)));
        }
        return Ok(value);
    }
    Err("session expired".into())
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

fn router_accounts(router: &RouterConfig) -> Result<Vec<QuotaAccount>, String> {
    let supported: Vec<String> = router_request(router, "GET", "/api/usage/providers")?
        .get("providers")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("id")?.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let connections: Vec<Value> = router_request(router, "GET", "/api/providers")?
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
                        id: format!("9router:{}:{id}", router.id),
                        group: router.name.clone(),
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
                    match router_request(router, "GET", &format!("/api/usage/{id}")) {
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

// --------------------------------------------------------------------- Jev

fn compact_tokens(tokens: u64) -> String {
    match tokens {
        0..=999 => tokens.to_string(),
        1_000..=999_999 => format!("{:.1}k", tokens as f64 / 1e3),
        _ => format!("{:.1}M", tokens as f64 / 1e6),
    }
}

/// Jev's balance is an estimate: TypeSafe has no balance API, so Kern counts
/// billed tokens since the balance the user last entered.
fn jev_card(mode: &str, usage: &crate::settings::JevUsage) -> QuotaAccount {
    let mut windows = Vec::new();
    let activity = format!(
        "{} requests · {} tokens this month",
        usage.month_requests,
        compact_tokens(usage.month_input_tokens)
    );
    let note = match (usage.balance_usd, usage.remaining_usd()) {
        (Some(balance), Some(remaining)) => {
            if balance > 0.0 {
                windows.push(QuotaWindow {
                    label: "Balance".into(),
                    used_percent: ((balance - remaining) / balance * 100.0).clamp(0.0, 100.0),
                    resets_at: None,
                });
            }
            format!("≈ ${remaining:.2} left of ${balance:.2} (estimate) · {activity}")
        }
        _ => format!(
            "Enter your TypeSafe balance in Settings → Jev to track what's left · {activity}"
        ),
    };
    QuotaAccount {
        id: "jev".into(),
        group: "Jev".into(),
        source: "jev".into(),
        provider: "jev".into(),
        name: "Jev (TypeSafe)".into(),
        plan: Some(mode.to_string()),
        windows,
        reset_credits: 0,
        note: Some(note),
        error: usage.billing_exhausted_at.map(|_| {
            "TypeSafe reported exhausted credits, so Jev is Off. Top up, update the balance in Settings → Jev, then turn Jev back on.".into()
        }),
    }
}

fn jev_account() -> Option<QuotaAccount> {
    let settings = crate::settings::get_jev_settings().ok()?;
    let usage = crate::settings::jev_usage();
    (settings.has_api_key || usage.total_input_tokens > 0).then(|| jev_card(&settings.mode, &usage))
}

// ---------------------------------------------------------------- commands

static CACHE: Mutex<Option<(Instant, QuotaSnapshot)>> = Mutex::new(None);
/// Matches the frontend poll so several panels share one lookup.
const CACHE_TTL: Duration = Duration::from_secs(4 * 60);
/// Retry a temporary auth failure or notice a new login promptly.
const EXPIRED_CACHE_TTL: Duration = Duration::from_secs(20);
const CLAUDE_EXPIRED: &str =
    "Claude login expired and couldn't be renewed. Sign in again with Claude Code (/login).";

fn cache_ttl(snapshot: &QuotaSnapshot) -> Duration {
    let expired = snapshot.accounts.iter().any(|account| {
        account.source == "claude"
            && account
                .error
                .as_deref()
                .is_some_and(|error| error.starts_with("Claude login"))
    });
    if expired {
        EXPIRED_CACHE_TTL
    } else {
        CACHE_TTL
    }
}

fn clear_cache() {
    if let Ok(mut guard) = CACHE.lock() {
        *guard = None;
    }
}

fn snapshot() -> QuotaSnapshot {
    let settings = crate::harness::read_settings();
    let routers: Vec<RouterConfig> = settings
        .routers
        .iter()
        .filter(|router| router_password(&router.id).is_some())
        .cloned()
        .collect();
    let (claude, per_router) = std::thread::scope(|scope| {
        let claude = settings
            .quota_claude_enabled()
            .then(|| scope.spawn(claude_account));
        let jobs: Vec<_> = routers
            .iter()
            .map(|router| (router, scope.spawn(move || router_accounts(router))))
            .collect();
        (
            claude.and_then(|job| job.join().ok()),
            jobs.into_iter()
                .map(|(router, job)| {
                    (
                        router,
                        job.join()
                            .unwrap_or_else(|_| Err("lookup crashed".to_string())),
                    )
                })
                .collect::<Vec<_>>(),
        )
    });
    let mut accounts: Vec<QuotaAccount> = claude.into_iter().collect();
    accounts.extend(jev_account());
    for (router, result) in per_router {
        match result {
            Ok(list) => accounts.extend(list),
            Err(error) => accounts.push(QuotaAccount {
                id: format!("9router:{}", router.id),
                group: router.name.clone(),
                source: "9router".into(),
                provider: "9router".into(),
                name: router.name.clone(),
                plan: None,
                windows: Vec::new(),
                reset_credits: 0,
                note: None,
                error: Some(format!("{}: {error}", router.name)),
            }),
        }
    }
    QuotaSnapshot {
        accounts,
        routers: routers.len(),
        checked_at: now_secs(),
    }
}

#[tauri::command]
pub async fn get_quota(refresh: Option<bool>) -> Result<QuotaSnapshot, String> {
    crate::pi_rpc::off_main_thread(move || {
        if !refresh.unwrap_or(false) {
            if let Some((at, cached)) = CACHE.lock().ok().and_then(|guard| guard.clone()) {
                if at.elapsed() < cache_ttl(&cached) {
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

fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Redeem one reset credit. Only from an explicit, confirmed click.
#[tauri::command]
pub async fn redeem_quota_reset(account_id: String) -> Result<String, String> {
    crate::pi_rpc::off_main_thread(move || {
        let (router_id, connection) = account_id
            .strip_prefix("9router:")
            .and_then(|rest| rest.split_once(':'))
            .ok_or("Only 9router accounts can be reset from Kern")?;
        if !safe_id(router_id) || !safe_id(connection) {
            return Err("Invalid account".into());
        }
        let router = routers()
            .into_iter()
            .find(|router| router.id == router_id)
            .ok_or("That 9router is no longer configured")?;
        let reply = router_request(
            &router,
            "POST",
            &format!("/api/usage/{connection}/codex-reset-credits"),
        )
        .map_err(|e| format!("{}: {e}", router.name))?;
        clear_cache();
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
pub struct RouterView {
    pub id: String,
    pub name: String,
    pub url: String,
    pub password_set: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct QuotaSettings {
    pub claude: bool,
    pub routers: Vec<RouterView>,
}

#[tauri::command(async)]
pub fn get_quota_settings() -> QuotaSettings {
    let settings = crate::harness::read_settings();
    QuotaSettings {
        claude: settings.quota_claude_enabled(),
        routers: settings
            .routers
            .into_iter()
            .map(|router| RouterView {
                password_set: router_password(&router.id).is_some(),
                id: router.id,
                name: router.name,
                url: router.url,
            })
            .collect(),
    }
}

#[tauri::command(async)]
pub fn set_quota_claude(enabled: bool) -> Result<QuotaSettings, String> {
    let _state = crate::state_lock::state_write_lock();
    let mut settings = crate::harness::read_settings();
    settings.quota_claude = Some(enabled);
    crate::harness::write_settings(&settings)?;
    clear_cache();
    Ok(get_quota_settings())
}

/// URL without a trailing slash; must be http(s).
fn normalize_url(url: &str) -> Result<String, String> {
    let url = url.trim().trim_end_matches('/').to_string();
    if url.starts_with("http://") || url.starts_with("https://") {
        Ok(url)
    } else {
        Err("9router URL must start with http:// or https://".into())
    }
}

/// Add (`id: None`) or update a router. `password: None` keeps the stored
/// one. The login is checked before anything is saved.
#[tauri::command]
pub async fn save_router(
    id: Option<String>,
    name: String,
    url: String,
    password: Option<String>,
) -> Result<QuotaSettings, String> {
    crate::pi_rpc::off_main_thread(move || {
        let url = normalize_url(&url)?;
        let name = match name.trim() {
            "" => url.split("://").nth(1).unwrap_or(&url).to_string(),
            name => name.to_string(),
        };
        let mut settings = crate::harness::read_settings();
        let id = match id {
            Some(id) if settings.routers.iter().any(|router| router.id == id) => id,
            Some(_) => return Err("That 9router is no longer configured".into()),
            None => format!("r{}", now_secs().unsigned_abs() % 1_000_000_000),
        };
        let password = password.filter(|password| !password.is_empty());
        let check = password.clone().or_else(|| router_password(&id));
        let Some(check) = check else {
            return Err("Enter the 9router dashboard password".into());
        };
        router_login(&url, &check).map_err(|e| format!("{name}: {e}"))?;
        if let Some(password) = password {
            security_framework::passwords::set_generic_password(
                ROUTER_KEYCHAIN_SERVICE,
                &id,
                password.as_bytes(),
            )
            .map_err(|e| format!("Keychain: {e}"))?;
        }
        let entry = RouterConfig {
            id: id.clone(),
            name,
            url,
        };
        match settings.routers.iter_mut().find(|router| router.id == id) {
            Some(existing) => *existing = entry,
            None => settings.routers.push(entry),
        }
        crate::harness::write_settings(&settings)?;
        forget_session(&id);
        clear_cache();
        Ok(get_quota_settings())
    })
    .await
}

#[tauri::command(async)]
pub fn delete_router(id: String) -> Result<QuotaSettings, String> {
    let _state = crate::state_lock::state_write_lock();
    let mut settings = crate::harness::read_settings();
    settings.routers.retain(|router| router.id != id);
    crate::harness::write_settings(&settings)?;
    let _ = security_framework::passwords::delete_generic_password(ROUTER_KEYCHAIN_SERVICE, &id);
    forget_session(&id);
    clear_cache();
    Ok(get_quota_settings())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unauthorized_usage_recovers_and_retries_only_once() {
        use std::cell::Cell;
        for final_status in [200, 401] {
            let mut creds = json!({"accessToken": "old"});
            let requests = Cell::new(0);
            let recoveries = Cell::new(0);
            let reply = claude_reply(
                &mut creds,
                |token| {
                    requests.set(requests.get() + 1);
                    assert_eq!(token, if requests.get() == 1 { "old" } else { "new" });
                    Ok(Reply {
                        status: if requests.get() == 1 {
                            401
                        } else {
                            final_status
                        },
                        headers: String::new(),
                        body: "{}".into(),
                    })
                },
                |rejected| {
                    assert_eq!(rejected, "old");
                    recoveries.set(recoveries.get() + 1);
                    Ok(json!({"accessToken": "new", "subscriptionType": "max"}))
                },
            )
            .unwrap();
            assert_eq!(reply.status, final_status);
            assert_eq!(requests.get(), 2);
            assert_eq!(recoveries.get(), 1);
            assert_eq!(creds["subscriptionType"], "max");
        }
    }

    #[test]
    fn other_usage_errors_do_not_refresh_login() {
        for status in [200, 403, 429, 503] {
            let reply = claude_reply(
                &mut json!({"accessToken": "valid"}),
                |_| {
                    Ok(Reply {
                        status,
                        headers: String::new(),
                        body: "{}".into(),
                    })
                },
                |_| panic!("only 401 should refresh"),
            )
            .unwrap();
            assert_eq!(reply.status, status);
        }
    }

    #[test]
    fn automatic_login_recovery_uses_short_snapshot_cache() {
        let mut account = claude_account_shell();
        account.error = Some(
            "Claude login refresh couldn't reach Anthropic. Kern will retry automatically.".into(),
        );
        let mut snapshot = QuotaSnapshot {
            accounts: vec![account],
            routers: 0,
            checked_at: 0,
        };
        assert_eq!(cache_ttl(&snapshot), EXPIRED_CACHE_TTL);
        snapshot.accounts[0].error = Some(CLAUDE_EXPIRED.into());
        assert_eq!(cache_ttl(&snapshot), EXPIRED_CACHE_TTL);
        snapshot.accounts[0].error = None;
        assert_eq!(cache_ttl(&snapshot), CACHE_TTL);
    }

    #[test]
    fn reads_retry_after() {
        let headers = "HTTP/2 429\r\ncontent-type: application/json\r\nRetry-After: 155";
        assert_eq!(retry_after(headers), Some(155));
        assert_eq!(retry_after("HTTP/2 429\r\nx: y"), None);
    }

    #[test]
    fn rate_limit_falls_back_to_last_reply() {
        let window = QuotaWindow {
            label: "5-hour".into(),
            used_percent: 52.0,
            resets_at: None,
        };
        let mut account = claude_account_shell();
        claude_from_cache(
            &ClaudeUsage::default(),
            &mut account,
            Some(rate_limited(155)),
        );
        assert!(account.windows.is_empty());
        assert_eq!(
            account.error.as_deref(),
            Some("Anthropic is rate-limiting usage checks; Kern retries in 3m.")
        );

        let usage = ClaudeUsage {
            fetched: Some((Instant::now(), vec![window.clone()], None)),
            ..ClaudeUsage::default()
        };
        let mut account = claude_account_shell();
        claude_from_cache(&usage, &mut account, Some(rate_limited(155)));
        assert_eq!(account.windows, vec![window]);
        assert!(account.error.is_none());
        assert!(account
            .note
            .unwrap()
            .ends_with("Showing data from just now."));
    }

    fn claude_account_shell() -> QuotaAccount {
        QuotaAccount {
            id: "claude".into(),
            group: "Claude".into(),
            source: "claude".into(),
            provider: "claude".into(),
            name: "Claude".into(),
            plan: None,
            windows: Vec::new(),
            reset_credits: 0,
            note: None,
            error: None,
        }
    }

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
    fn router_urls_and_ids_are_validated() {
        assert_eq!(
            normalize_url(" https://9router.example.com/ "),
            Ok("https://9router.example.com".to_string())
        );
        assert!(normalize_url("localhost:20128").is_err());
        assert!(safe_id("a6eca261-6fbb-45cb"));
        assert!(!safe_id("../etc"));
        assert!(!safe_id(""));
    }

    #[test]
    fn jev_card_estimates_the_balance() {
        let mut usage = crate::settings::JevUsage {
            month_requests: 312,
            month_input_tokens: 1_234_567,
            total_input_tokens: 2_000_000,
            balance_usd: Some(4.86),
            balance_tokens: 0,
            ..Default::default()
        };
        let card = jev_card("advisory", &usage);
        assert_eq!(card.plan.as_deref(), Some("advisory"));
        assert!(card.error.is_none());
        let note = card.note.unwrap();
        assert!(note.starts_with("≈ $4.78 left of $4.86"), "{note}");
        assert!(note.contains("312 requests · 1.2M tokens this month"));
        assert!((card.windows[0].used_percent - 0.084 / 4.86 * 100.0).abs() < 1e-6);

        usage.balance_usd = None;
        usage.billing_exhausted_at = Some(1);
        let card = jev_card("off", &usage);
        assert!(card.windows.is_empty());
        assert!(card
            .note
            .unwrap()
            .starts_with("Enter your TypeSafe balance"));
        assert!(card.error.unwrap().contains("exhausted"));
    }

    #[test]
    fn curl_config_values_are_escaped() {
        assert_eq!(quoted(r#"a"b\c"#), r#""a\"b\\c""#);
        assert_eq!(quoted("a\r\nb"), r#""a\r\nb""#);
    }
}
