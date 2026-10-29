//! Refresh Claude Code's existing login, preserving the shared Keychain document.
//! Protocol reference: https://github.com/TeancumTian/cc-codex-usagebar
//! No model requests or interactive Claude Code process are needed.

use super::{curl, now_secs, quoted, retry_after, Reply, CLAUDE_EXPIRED, CLAUDE_KEYCHAIN_SERVICE};
use serde_json::{json, Value};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const SAVE_ERROR: &str =
    "Claude login refresh couldn't be saved to the Keychain. Kern will retry automatically.";
const CHANGED_ERROR: &str = "Claude login changed during refresh. Kern will retry automatically.";

// Serialize refreshes from concurrent panels, polls and chat completions. Claude
// Code does not share this lock; re-read its entry after the HTTP call as well.
static AUTH: LazyLock<Mutex<Auth>> = LazyLock::new(|| Mutex::new(Auth::default()));

#[derive(Default)]
struct Auth {
    failure: Option<(Value, Instant, String)>,
    // A failed Keychain write must retry saving the rotated token, rather than
    // consume the old refresh token again. Never log or serialize this state.
    pending: Option<(Value, Value)>,
}

fn oauth(document: &Value) -> Result<Value, String> {
    document
        .get("claudeAiOauth")
        .filter(|value| value.is_object())
        .cloned()
        .ok_or_else(|| "Claude Code login is unreadable".into())
}

fn token<'a>(creds: &'a Value, key: &str) -> Option<&'a str> {
    creds.get(key)?.as_str().filter(|value| !value.is_empty())
}

fn same_login(left: &Value, right: &Value) -> bool {
    // Metadata (e.g. MCP state) can change independently during a refresh.
    left.get("accessToken") == right.get("accessToken")
        && left.get("refreshToken") == right.get("refreshToken")
}

fn expired(creds: &Value, now: i64) -> bool {
    creds
        .get("expiresAt")
        .and_then(Value::as_i64)
        .is_some_and(|expires| expires > 0 && expires / 1000 <= now)
}

fn read_keychain() -> Result<Value, String> {
    let user = std::env::var("USER").unwrap_or_default();
    let bytes = security_framework::passwords::get_generic_password(CLAUDE_KEYCHAIN_SERVICE, &user)
        .map_err(|_| "No Claude Code login in the Keychain".to_string())?;
    serde_json::from_slice(&bytes).map_err(|_| "Claude Code login is unreadable".into())
}

fn write_keychain(document: &Value) -> Result<(), String> {
    let user = std::env::var("USER").unwrap_or_default();
    let bytes = serde_json::to_vec(document).map_err(|_| SAVE_ERROR.to_string())?;
    security_framework::passwords::set_generic_password(CLAUDE_KEYCHAIN_SERVICE, &user, &bytes)
        .map_err(|_| SAVE_ERROR.into())
}

fn refresh(refresh_token: &str) -> Result<Reply, String> {
    // Secrets go only through curl's stdin, including JSON escaping and curl
    // config escaping. Never put tokens in argv or include response bodies in errors.
    let body = json!({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": CLIENT_ID,
    });
    curl(&format!(
        "url = \"https://platform.claude.com/v1/oauth/token\"\nrequest = \"POST\"\nheader = \"Content-Type: application/json\"\ndata = {}\n",
        quoted(&body.to_string())
    ))
    .map_err(|_| "Claude login refresh couldn't reach Anthropic. Kern will retry automatically.".into())
}

/// `rejected` is the access token that just returned 401. A newer login read
/// from the Keychain wins without another rotation.
pub(super) fn credentials(rejected: Option<&str>) -> Result<Value, String> {
    AUTH.lock()
        .unwrap_or_else(|error| error.into_inner())
        .credentials(
            read_keychain,
            write_keychain,
            refresh,
            rejected,
            now_secs(),
            Instant::now(),
        )
}

impl Auth {
    fn credentials(
        &mut self,
        read: impl Fn() -> Result<Value, String>,
        write: impl Fn(&Value) -> Result<(), String>,
        request: impl Fn(&str) -> Result<Reply, String>,
        rejected: Option<&str>,
        now: i64,
        at: Instant,
    ) -> Result<Value, String> {
        let mut document = read()?;
        let creds = oauth(&document)?;
        if let Some((original, updated)) = &self.pending {
            if same_login(&creds, original) {
                // Merge into the latest document, retaining unrelated fields.
                let mut merged = creds.clone();
                merge_refresh(&mut merged, updated);
                document["claudeAiOauth"] = merged.clone();
                write(&document).map_err(|_| SAVE_ERROR.to_string())?;
                self.pending = None;
                self.failure = None;
                return Ok(merged);
            }
            self.pending = None;
        }
        let access = token(&creds, "accessToken").ok_or("Claude Code login has no access token")?;
        if !expired(&creds, now) && rejected != Some(access) {
            return Ok(creds);
        }
        if let Some((failed, until, message)) = &self.failure {
            if same_login(failed, &creds) && *until > at {
                return Err(message.clone());
            }
        }
        let refresh_token = token(&creds, "refreshToken").ok_or(CLAUDE_EXPIRED)?;
        let reply = request(refresh_token).and_then(|reply| {
            if reply.status == 200 {
                let body: Value = serde_json::from_str(&reply.body)
                    .map_err(|_| "Claude login refresh returned an invalid response".to_string())?;
                let mut updated = creds.clone();
                apply_refresh(&mut updated, &body, now)?;
                // Preserve rotated tokens even if the post-request read fails.
                self.pending = Some((creds.clone(), updated));
            }
            Ok(reply)
        });
        // The CLI may have refreshed or switched accounts while HTTP was in
        // flight. Never overwrite that newer login or restore a signed-out one.
        let mut latest = read()?;
        let latest_creds = oauth(&latest)?;
        if !same_login(&creds, &latest_creds) {
            self.pending = None;
            self.failure = None;
            return if !expired(&latest_creds, now) && token(&latest_creds, "accessToken").is_some()
            {
                Ok(latest_creds)
            } else {
                Err(CHANGED_ERROR.into())
            };
        }
        let result = reply.and_then(|reply| {
            if reply.status != 200 {
                let message = match reply.status {
                    400 | 401 | 403 => CLAUDE_EXPIRED.to_string(),
                    429 => "Claude login refresh is rate-limited. Kern will retry automatically.".into(),
                    status => format!("Claude login refresh returned HTTP {status}. Kern will retry automatically."),
                };
                let wait = retry_after(&reply.headers).unwrap_or(60).clamp(60, 30 * 60);
                self.failure = Some((creds.clone(), at + Duration::from_secs(wait), message.clone()));
                return Err(message);
            }
            let mut updated = latest_creds;
            merge_refresh(&mut updated, &self.pending.as_ref().unwrap().1);
            latest["claudeAiOauth"] = updated.clone();
            write(&latest).map_err(|_| SAVE_ERROR.to_string())?;
            self.pending = None;
            self.failure = None;
            Ok(updated)
        });
        if let Err(message) = &result {
            if self
                .failure
                .as_ref()
                .is_none_or(|(failed, until, _)| !same_login(failed, &creds) || *until <= at)
            {
                self.failure = Some((creds, at + Duration::from_secs(60), message.clone()));
            }
        }
        result
    }
}

fn apply_refresh(creds: &mut Value, body: &Value, now: i64) -> Result<(), String> {
    let invalid = || "Claude login refresh returned an invalid response".to_string();
    let access = token(body, "access_token").ok_or_else(invalid)?;
    let expires = body
        .get("expires_in")
        .and_then(Value::as_i64)
        .filter(|seconds| *seconds > 0)
        .and_then(|seconds| now.checked_add(seconds))
        .and_then(|seconds| seconds.checked_mul(1000))
        .ok_or_else(invalid)?;
    creds["accessToken"] = json!(access);
    creds["expiresAt"] = json!(expires);
    if let Some(refresh) = token(body, "refresh_token") {
        creds["refreshToken"] = json!(refresh);
        // The old refresh-token expiry belongs to the old token.
        creds
            .as_object_mut()
            .unwrap()
            .remove("refreshTokenExpiresAt");
    }
    if let Some(expires) = body
        .get("refresh_token_expires_in")
        .and_then(Value::as_i64)
        .filter(|seconds| *seconds > 0)
        .and_then(|seconds| now.checked_add(seconds))
        .and_then(|seconds| seconds.checked_mul(1000))
    {
        creds["refreshTokenExpiresAt"] = json!(expires);
    }
    if let Some(scope) = body.get("scope").and_then(Value::as_str) {
        creds["scopes"] = json!(scope.split_whitespace().collect::<Vec<_>>());
    }
    Ok(())
}

fn merge_refresh(creds: &mut Value, updated: &Value) {
    for key in [
        "accessToken",
        "refreshToken",
        "expiresAt",
        "refreshTokenExpiresAt",
        "scopes",
    ] {
        if let Some(value) = updated.get(key) {
            creds[key] = value.clone();
        } else {
            creds.as_object_mut().unwrap().remove(key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    const NOW: i64 = 1_000;

    fn login(expires: i64) -> Value {
        json!({
            "mcpOAuth": {"server": {"accessToken": "mcp-secret"}},
            "other": true,
            "claudeAiOauth": {
                "accessToken": "old-access", "refreshToken": "old-refresh",
                "expiresAt": expires * 1000, "subscriptionType": "max",
                "rateLimitTier": "default_claude_max_5x",
                "scopes": ["user:profile"], "custom": 42
            }
        })
    }

    fn reply(status: u16, body: Value) -> Reply {
        Reply {
            status,
            headers: String::new(),
            body: body.to_string(),
        }
    }

    fn renewed() -> Reply {
        reply(
            200,
            json!({
                "access_token": "new-access", "refresh_token": "new-refresh",
                "expires_in": 3600, "refresh_token_expires_in": 86400,
                "scope": "user:profile user:inference"
            }),
        )
    }

    #[test]
    fn valid_login_and_external_rotation_need_no_refresh() {
        for rejected in [None, Some("previous-access")] {
            let doc = login(NOW + 3600);
            let creds = Auth::default()
                .credentials(
                    || Ok(doc.clone()),
                    |_| panic!("must not write"),
                    |_| panic!("must not refresh"),
                    rejected,
                    NOW,
                    Instant::now(),
                )
                .unwrap();
            assert_eq!(creds, doc["claudeAiOauth"]);
        }
    }

    #[test]
    fn expired_or_rejected_login_is_rotated_and_saved_with_metadata() {
        for (expires, rejected) in [(NOW, None), (NOW + 3600, Some("old-access"))] {
            let doc = RefCell::new(login(expires));
            let before = doc.borrow().clone();
            let creds = Auth::default()
                .credentials(
                    || Ok(doc.borrow().clone()),
                    |updated| {
                        *doc.borrow_mut() = updated.clone();
                        Ok(())
                    },
                    |refresh| {
                        assert_eq!(refresh, "old-refresh");
                        Ok(renewed())
                    },
                    rejected,
                    NOW,
                    Instant::now(),
                )
                .unwrap();
            assert_eq!(creds["accessToken"], "new-access");
            assert_eq!(creds["refreshToken"], "new-refresh");
            assert_eq!(creds["expiresAt"], (NOW + 3600) * 1000);
            assert_eq!(creds["refreshTokenExpiresAt"], (NOW + 86400) * 1000);
            assert_eq!(creds["scopes"], json!(["user:profile", "user:inference"]));
            assert_eq!(creds["subscriptionType"], "max");
            assert_eq!(creds["custom"], 42);
            assert_eq!(doc.borrow()["mcpOAuth"], before["mcpOAuth"]);
            assert_eq!(doc.borrow()["other"], before["other"]);
            assert_eq!(doc.borrow()["claudeAiOauth"], creds);
        }
    }

    #[test]
    fn concurrent_cli_login_wins_over_refresh_success_or_failure() {
        for status in [200, 400] {
            let doc = RefCell::new(login(NOW - 1));
            let mut replacement = login(NOW + 7200);
            replacement["claudeAiOauth"]["accessToken"] = json!("other-account");
            replacement["claudeAiOauth"]["refreshToken"] = json!("other-refresh");
            let creds = Auth::default()
                .credentials(
                    || Ok(doc.borrow().clone()),
                    |_| panic!("must not overwrite CLI login"),
                    |_| {
                        *doc.borrow_mut() = replacement.clone();
                        Ok(if status == 200 {
                            renewed()
                        } else {
                            reply(status, json!({}))
                        })
                    },
                    None,
                    NOW,
                    Instant::now(),
                )
                .unwrap();
            assert_eq!(creds["accessToken"], "other-account");
        }
    }

    #[test]
    fn failed_keychain_write_retries_persistence_without_rotating_again() {
        let doc = RefCell::new(login(NOW - 1));
        let mut auth = Auth::default();
        let first = auth.credentials(
            || Ok(doc.borrow().clone()),
            |_| Err("locked".into()),
            |_| Ok(renewed()),
            None,
            NOW,
            Instant::now(),
        );
        assert_eq!(first.unwrap_err(), SAVE_ERROR);
        // Preserve unrelated changes made while the write was blocked.
        doc.borrow_mut()["mcpOAuth"]["new-server"] = json!({"accessToken": "another-mcp"});
        doc.borrow_mut()["claudeAiOauth"]["custom"] = json!(99);
        let saved = auth
            .credentials(
                || Ok(doc.borrow().clone()),
                |updated| {
                    *doc.borrow_mut() = updated.clone();
                    Ok(())
                },
                |_| panic!("must reuse pending tokens"),
                None,
                NOW,
                Instant::now(),
            )
            .unwrap();
        assert_eq!(saved["accessToken"], "new-access");
        assert_eq!(saved["custom"], 99);
        assert!(doc.borrow()["mcpOAuth"]["new-server"].is_object());
    }

    #[test]
    fn post_refresh_read_failure_retains_rotated_tokens() {
        let doc = RefCell::new(login(NOW - 1));
        let reads = Cell::new(0);
        let mut auth = Auth::default();
        assert!(auth
            .credentials(
                || {
                    reads.set(reads.get() + 1);
                    if reads.get() == 2 {
                        Err("Keychain locked".into())
                    } else {
                        Ok(doc.borrow().clone())
                    }
                },
                |_| panic!("read failed"),
                |_| Ok(renewed()),
                None,
                NOW,
                Instant::now(),
            )
            .is_err());
        let creds = auth
            .credentials(
                || Ok(doc.borrow().clone()),
                |updated| {
                    *doc.borrow_mut() = updated.clone();
                    Ok(())
                },
                |_| panic!("must not reuse consumed refresh token"),
                None,
                NOW,
                Instant::now(),
            )
            .unwrap();
        assert_eq!(creds["refreshToken"], "new-refresh");
    }

    #[test]
    fn pending_refresh_never_restores_a_different_account() {
        let doc = RefCell::new(login(NOW - 1));
        let mut auth = Auth::default();
        assert!(auth
            .credentials(
                || Ok(doc.borrow().clone()),
                |_| Err("locked".into()),
                |_| Ok(renewed()),
                None,
                NOW,
                Instant::now(),
            )
            .is_err());
        doc.borrow_mut()["claudeAiOauth"]["accessToken"] = json!("different");
        doc.borrow_mut()["claudeAiOauth"]["expiresAt"] = json!((NOW + 3600) * 1000);
        let creds = auth
            .credentials(
                || Ok(doc.borrow().clone()),
                |_| panic!("must not save old login"),
                |_| panic!("must not refresh"),
                None,
                NOW,
                Instant::now(),
            )
            .unwrap();
        assert_eq!(creds["accessToken"], "different");
    }

    #[test]
    fn refresh_errors_back_off_and_do_not_expose_response_secrets() {
        for status in [400, 401, 403, 429, 503] {
            let mut auth = Auth::default();
            let doc = login(NOW - 1);
            let at = Instant::now();
            let first = auth
                .credentials(
                    || Ok(doc.clone()),
                    |_| panic!("must not write"),
                    |_| {
                        Ok(Reply {
                            headers: "Retry-After: 155".into(),
                            ..reply(status, json!({"error": "sensitive-response"}))
                        })
                    },
                    None,
                    NOW,
                    at,
                )
                .unwrap_err();
            assert!(!first.contains("sensitive-response"));
            assert_eq!(
                first.contains("login expired"),
                matches!(status, 400 | 401 | 403)
            );
            let next = auth
                .credentials(
                    || Ok(doc.clone()),
                    |_| panic!("must not write"),
                    |_| panic!("must respect Retry-After"),
                    None,
                    NOW + 100,
                    at + Duration::from_secs(100),
                )
                .unwrap_err();
            assert_eq!(first, next);
        }
    }

    #[test]
    fn malformed_refresh_does_not_write_and_retries_are_throttled() {
        for body in [
            json!({}),
            json!({"access_token": "", "expires_in": 3600}),
            json!({"access_token": "new", "expires_in": -1}),
            json!({"access_token": "new", "expires_in": i64::MAX}),
        ] {
            let mut auth = Auth::default();
            let doc = login(NOW - 1);
            let at = Instant::now();
            assert!(auth
                .credentials(
                    || Ok(doc.clone()),
                    |_| panic!("invalid token must not be saved"),
                    |_| Ok(reply(200, body.clone())),
                    None,
                    NOW,
                    at,
                )
                .unwrap_err()
                .contains("invalid response"));
            assert!(auth
                .credentials(
                    || Ok(doc.clone()),
                    |_| panic!("must not write"),
                    |_| panic!("must back off"),
                    None,
                    NOW,
                    at,
                )
                .is_err());
        }
    }

    #[test]
    fn normal_lookup_preserves_backoff_after_unexpired_token_is_rejected() {
        let doc = login(NOW + 3600);
        let mut auth = Auth::default();
        let at = Instant::now();
        assert!(auth
            .credentials(
                || Ok(doc.clone()),
                |_| panic!("must not write"),
                |_| Err("Claude login refresh couldn't reach Anthropic".into()),
                Some("old-access"),
                NOW,
                at,
            )
            .is_err());
        assert!(auth
            .credentials(
                || Ok(doc.clone()),
                |_| panic!("must not write"),
                |_| panic!("normal lookup"),
                None,
                NOW,
                at,
            )
            .is_ok());
        assert!(auth
            .credentials(
                || Ok(doc.clone()),
                |_| panic!("must not write"),
                |_| panic!("must still back off"),
                Some("old-access"),
                NOW,
                at,
            )
            .is_err());
    }

    #[test]
    fn revoked_login_without_refresh_token_requires_sign_in() {
        let mut doc = login(NOW - 1);
        doc["claudeAiOauth"]
            .as_object_mut()
            .unwrap()
            .remove("refreshToken");
        assert_eq!(
            Auth::default()
                .credentials(
                    || Ok(doc.clone()),
                    |_| panic!("must not write"),
                    |_| panic!("no refresh token"),
                    None,
                    NOW,
                    Instant::now(),
                )
                .unwrap_err(),
            CLAUDE_EXPIRED
        );
    }
}
