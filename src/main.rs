use tokio::net::TcpListener;
use tower_http::services::ServeDir;
use axum::{
    Json, Router,
    extract::{ FromRequestParts, Path, Request, State },
    http::{ HeaderMap, StatusCode, Uri, header, request::Parts },
    middleware::{ self, Next },
    response::{ IntoResponse, Response },
    routing::{ any, delete, get, post }
};
use argon2::{ Argon2, password_hash::{ PasswordHasher, PasswordVerifier, phc::PasswordHash } };
use sha2::{ Digest, Sha256 };
use sqlx::Row;

const SESSION_TTL_HOURS: i32 = 24;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::dotenv().ok();
    let listener = TcpListener::bind("0.0.0.0:8080").await?;
    let pool = connect().await?;
    println!("Server running: http://127.0.0.1:8080");
    axum::serve(listener, app(pool)).await?;
    Ok(())
}

#[derive(serde::Deserialize)]
struct Registration {
    displayed_nickname: String,
    login: String,
    email: String,
    password: String,
}

#[derive(serde::Deserialize)]
struct Login {
    email: String,
    password: String,
}

fn app(pool: sqlx::PgPool) -> Router {
    let login = post(login_user).layer(
        middleware::from_fn_with_state(pool.clone(), rate_limit_login_ip)
    );
    let register = post(register_user).layer(
        middleware::from_fn_with_state(pool.clone(), rate_limit_register_ip)
    );
    let claim = post(claim_link).layer(
        middleware::from_fn_with_state(pool.clone(), rate_limit_claim_ip)
    );
    Router::new()
        .route("/api/register", register)
        .route("/api/login", login)
        .route("/api/logout", post(logout_user))
        .route("/api/me", get(current_user))
        .route("/api/security", get(account_security))
        .route("/api/security/password", post(change_password).layer(middleware::from_fn_with_state(pool.clone(), rate_limit_security_ip)))
        .route("/api/security/email", post(request_email_confirmation).layer(middleware::from_fn_with_state(pool.clone(), rate_limit_security_ip)))
        .route("/api/security/email/confirm", post(confirm_email).layer(middleware::from_fn_with_state(pool.clone(), rate_limit_security_ip)))
        .route("/api/link", get(list_links))
        .route("/api/link/start", post(start_link))
        .route("/api/link/{uuid}", delete(unlink_account))
        .route("/api/stats", get(stats_for_user))
        .route("/internal/link/claim", claim)
        .route("/internal/link/status", post(link_status))
        .route("/internal/link/email", post(link_email))
        .route("/internal/stats/report", post(report_stats))
        // An unmatched API path answers 404 instead of falling through to the SPA
        // shell, so a wrong endpoint never returns an HTML page with a 200.
        .route("/api/{*rest}", any(not_found))
        .route("/internal/{*rest}", any(not_found))
        // Serve the built frontend, and hand back the SPA shell for any path that is
        // not a real file, so a deep link to /cabinet works. Without this the in-game
        // message's link 404s, because only client-side navigation from / ever reaches
        // a route.
        //
        // `fallback`, not `not_found_service`: the latter overrides the fallback's
        // status to 404, which would serve the shell with a 404 and break the promise
        // that this route exists.
        .fallback_service(ServeDir::new("frontend/dist").fallback(get(spa_fallback)))
        .with_state(pool)
}

async fn not_found() -> StatusCode {
    StatusCode::NOT_FOUND
}

/// The built frontend's shell. Every client-side route lives in this one file.
const SPA_SHELL: &str = "frontend/dist/index.html";

/// Whether a path is asking for a file rather than naming a client-side route.
fn asks_for_a_file(path: &str) -> bool {
    path.rsplit('/').next().is_some_and(|last| last.contains('.'))
}

/// Serves the SPA shell to anything that is not a real file and does not look like one.
///
/// A path whose last segment carries an extension is asking for a file, so a missing
/// one keeps its `404`: a stale shell pointing at a chunk that no longer exists should
/// fail loudly, not return HTML with a `200` and break the module loader in a way
/// nobody can read.
async fn spa_fallback(uri: Uri) -> Response {
    if asks_for_a_file(uri.path()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    match tokio::fs::read_to_string(SPA_SHELL).await {
        Ok(shell) =>
            (
                // Never cached: the shell names the hashed assets, so a redeploy has to
                // be picked up on the next load or the browser asks for a chunk that is
                // gone.
                [
                    (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                    (header::CACHE_CONTROL, "no-cache"),
                ],
                shell,
            ).into_response(),
        // No build on disk, which is the ordinary state inside the test container.
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn connect() -> Result<sqlx::PgPool, Box<dyn std::error::Error>> {
    let url = std::env::var("DATABASE_URL")?;
    let pool = sqlx::PgPool::connect(&url).await?;
    sqlx::migrate::Migrator::new(std::path::Path::new("./migrations")).await?.run(&pool).await?;
    Ok(pool)
}

// --- Rate limiting and account lockout --------------------------------------

fn env_i64(name: &str, default: i64) -> i64 {
    std::env::var(name).ok().and_then(|value| value.parse().ok()).unwrap_or(default)
}

fn login_ip_limit() -> i64 {
    env_i64("LOGIN_IP_LIMIT", 20)
}

fn login_ip_window_seconds() -> i64 {
    env_i64("LOGIN_IP_WINDOW_SECONDS", 900)
}

fn register_ip_limit() -> i64 {
    env_i64("REGISTER_IP_LIMIT", 10)
}

fn register_ip_window_seconds() -> i64 {
    env_i64("REGISTER_IP_WINDOW_SECONDS", 3600)
}

fn lockout_threshold() -> i64 {
    env_i64("LOCKOUT_THRESHOLD", 10)
}

fn lockout_window_seconds() -> i64 {
    env_i64("LOCKOUT_WINDOW_SECONDS", 900)
}

fn lockout_base_seconds() -> i64 {
    env_i64("LOCKOUT_BASE_SECONDS", 900)
}

fn lockout_max_seconds() -> i64 {
    env_i64("LOCKOUT_MAX_SECONDS", 86400)
}

fn now_unix() -> i64 {
    std::time::SystemTime
        ::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

// Caddy replaces any client-supplied `X-Forwarded-For` with the real peer address
// (verified: a spoofed value does not survive), and the Caddyfile also sets an
// explicit `X-Real-IP`. We take the last forwarded entry, i.e. the address Caddy
// itself saw, so a spoofed value on the left can never be selected.
fn client_ip(headers: &HeaderMap) -> String {
    if
        let Some(value) = headers.get("x-real-ip").and_then(|value| value.to_str().ok()) &&
        !value.trim().is_empty()
    {
        return value.trim().to_owned();
    }
    if let Some(value) = headers.get("x-forwarded-for").and_then(|value| value.to_str().ok()) {
        if
            let Some(last) = value.split(',').next_back() &&
            !last.trim().is_empty()
        {
            return last.trim().to_owned();
        }
    }
    "unknown".to_owned()
}

fn rate_limited(retry_after_seconds: i64) -> Response {
    (
        StatusCode::TOO_MANY_REQUESTS,
        [(header::RETRY_AFTER, retry_after_seconds.max(1).to_string())],
    ).into_response()
}

// Fixed-window counter. Returns `Some(retry_after_seconds)` when `subject` is over
// `limit` for the current window, or `None` when the request is allowed.
async fn ip_limit_exceeded(
    pool: &sqlx::PgPool,
    scope: &str,
    limit: i64,
    window_seconds: i64,
    subject: &str
) -> Result<Option<i64>, sqlx::Error> {
    let window_index = now_unix() / window_seconds;
    let row = sqlx
        ::query(
            "INSERT INTO auth_rate_limits (scope, subject, window_index, count)
             VALUES ($1, $2, $3, 1)
             ON CONFLICT (scope, subject) DO UPDATE SET
               count = CASE WHEN auth_rate_limits.window_index = $3 THEN auth_rate_limits.count + 1 ELSE 1 END,
               window_index = $3
             RETURNING count"
        )
        .bind(scope)
        .bind(subject)
        .bind(window_index)
        .fetch_one(pool).await?;
    let count: i32 = row.try_get("count")?;
    if (count as i64) > limit {
        Ok(Some(window_seconds - now_unix() % window_seconds))
    } else {
        Ok(None)
    }
}

async fn rate_limit_request(
    pool: &sqlx::PgPool,
    scope: &str,
    limit: i64,
    window_seconds: i64,
    request: Request,
    next: Next
) -> Response {
    let subject = client_ip(request.headers());
    match ip_limit_exceeded(pool, scope, limit, window_seconds, &subject).await {
        Ok(Some(retry_after)) => rate_limited(retry_after),
        Ok(None) => next.run(request).await,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn rate_limit_login_ip(
    State(pool): State<sqlx::PgPool>,
    request: Request,
    next: Next
) -> Response {
    rate_limit_request(
        &pool,
        "login_ip",
        login_ip_limit(),
        login_ip_window_seconds(),
        request,
        next
    ).await
}

async fn rate_limit_register_ip(
    State(pool): State<sqlx::PgPool>,
    request: Request,
    next: Next
) -> Response {
    rate_limit_request(
        &pool,
        "register_ip",
        register_ip_limit(),
        register_ip_window_seconds(),
        request,
        next
    ).await
}

async fn rate_limit_security_ip(State(pool): State<sqlx::PgPool>, request: Request, next: Next) -> Response {
    rate_limit_request(&pool, "security_ip", 30, 900, request, next).await
}

async fn account_is_locked(pool: &sqlx::PgPool, email: &str) -> Result<bool, sqlx::Error> {
    let row = sqlx
        ::query(
            "SELECT locked_until IS NOT NULL AND locked_until > now() AS locked FROM login_failures WHERE email = $1"
        )
        .bind(email)
        .fetch_optional(pool).await?;
    match row {
        Some(row) => row.try_get("locked"),
        None => Ok(false),
    }
}

async fn record_login_failure(pool: &sqlx::PgPool, email: &str) -> Result<(), sqlx::Error> {
    let threshold = lockout_threshold();
    let mut transaction = pool.begin().await?;
    // The failure window resets only before the first lockout. Preserve escalation
    // across expired lockouts; a successful login clears the entire history.
    let row = sqlx
        ::query(
            "INSERT INTO login_failures (email, failed_count, first_failed_at)
             VALUES ($1, 1, now())
             ON CONFLICT (email) DO UPDATE SET
               failed_count = CASE WHEN login_failures.locked_until IS NULL AND login_failures.first_failed_at < now() - make_interval(secs => $2::double precision)
                                   THEN 1 ELSE login_failures.failed_count + 1 END,
               first_failed_at = CASE WHEN login_failures.locked_until IS NULL AND login_failures.first_failed_at < now() - make_interval(secs => $2::double precision)
                                      THEN now() ELSE login_failures.first_failed_at END
             RETURNING failed_count"
        )
        .bind(email)
        .bind(lockout_window_seconds())
        .fetch_one(&mut *transaction).await?;
    let failed_count: i32 = row.try_get("failed_count")?;
    if (failed_count as i64) >= threshold {
        sqlx
            ::query(
                "UPDATE login_failures SET locked_until = now() + make_interval(secs => $2::double precision) WHERE email = $1"
            )
            .bind(email)
            .bind(
                lockout_seconds(
                    failed_count as i64,
                    threshold,
                    lockout_base_seconds(),
                    lockout_max_seconds()
                )
            )
            .execute(&mut *transaction).await?;
    }
    transaction.commit().await?;
    Ok(())
}

async fn clear_login_failures(pool: &sqlx::PgPool, email: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM login_failures WHERE email = $1").bind(email).execute(pool).await?;
    Ok(())
}

// Lock duration doubles for every failure past the threshold, capped at `max`.
fn lockout_seconds(failed_count: i64, threshold: i64, base: i64, max: i64) -> i64 {
    let excess = (failed_count - threshold).max(0).min(32) as u32;
    let factor = 2i64.checked_pow(excess).unwrap_or(i64::MAX);
    base.saturating_mul(factor).min(max)
}

async fn register_user(
    State(pool): State<sqlx::PgPool>,
    Json(input): Json<Registration>
) -> Result<StatusCode, StatusCode> {
    let email = input.email.to_lowercase();
    let login = input.login.to_lowercase();
    let missing_text = [&input.email, &input.displayed_nickname, &input.login]
        .iter()
        .any(|value| value.trim().is_empty());
    if
        !login.chars().all(|ch| { ch.is_ascii_alphanumeric() || matches!(ch, '_' | '!' | '@') }) ||
        !email_address::EmailAddress::is_valid(&email) ||
        missing_text ||
        input.password.chars().count() < 15
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let existing = sqlx
        ::query("SELECT 1 FROM users WHERE email=$1 OR login=$2")
        .bind(&email)
        .bind(&login)
        .fetch_optional(&pool).await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    match existing {
        Some(_) => {
            return Err(StatusCode::CONFLICT);
        }
        None => {}
    }
    let argon2 = Argon2::default();
    let password_bytes = input.password.as_bytes();
    let password_hash = argon2
        .hash_password(password_bytes)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .to_string();
    sqlx
        ::query(
            "INSERT INTO users (displayed_nickname,login,login_displayed,email,password_hash) VALUES ($1,$2,$3,$4,$5)"
        )
        .bind(input.displayed_nickname.trim())
        .bind(&login)
        .bind(&input.login)
        .bind(&email)
        .bind(&password_hash)
        .execute(&pool).await
        .map_err(|error| {
            match error {
                sqlx::Error::Database(db) if db.is_unique_violation() => StatusCode::CONFLICT,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            }
        })?;
    Ok(StatusCode::CREATED)
}

async fn login_user(
    State(pool): State<sqlx::PgPool>,
    Json(input): Json<Login>
) -> Result<impl IntoResponse, StatusCode> {
    let email = input.email.to_lowercase();
    // A locked account must look exactly like a wrong password, so the endpoint
    // never reveals which accounts exist.
    if account_is_locked(&pool, &email).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)? {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let row = sqlx
        ::query("SELECT id, password_hash FROM users WHERE email = $1")
        .bind(&email)
        .fetch_optional(&pool).await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let Some(row) = row else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let user_id: i64 = row.try_get("id").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let password_hash: String = row
        .try_get("password_hash")
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let parsed_hash = PasswordHash::new(&password_hash).map_err(
        |_| StatusCode::INTERNAL_SERVER_ERROR
    )?;
    if Argon2::default().verify_password(input.password.as_bytes(), &parsed_hash).is_err() {
        record_login_failure(&pool, &email).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        return Err(StatusCode::UNAUTHORIZED);
    }
    clear_login_failures(&pool, &email).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let token = new_session_token()?;
    let mut login_tx = pool.begin().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    // Serialize session issuance with password/email changes. A password verified
    // before a concurrent change must not create a fresh session afterwards.
    sqlx::query("SELECT id FROM users WHERE id = $1 AND password_hash = $2 AND email = $3 FOR UPDATE")
        .bind(user_id).bind(&password_hash).bind(&email).fetch_optional(&mut *login_tx).await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?.ok_or(StatusCode::UNAUTHORIZED)?;
    sqlx
        ::query(
            "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))"
        )
        .bind(user_id)
        .bind(hash_token(&token))
        .bind(SESSION_TTL_HOURS)
        .execute(&mut *login_tx).await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    login_tx.commit().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(([(header::SET_COOKIE, session_cookie(&token))], StatusCode::OK))
}

async fn logout_user(
    State(pool): State<sqlx::PgPool>,
    headers: HeaderMap
) -> Result<impl IntoResponse, StatusCode> {
    if let Some(token) = session_token_from_headers(&headers) {
        sqlx
            ::query("DELETE FROM sessions WHERE token_hash = $1")
            .bind(hash_token(&token))
            .execute(&pool).await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    Ok(([(header::SET_COOKIE, cleared_session_cookie())], StatusCode::OK))
}

#[derive(serde::Serialize)]
struct Me {
    id: i64,
    displayed_nickname: String,
    email: String,
    login_displayed: String,
}

async fn current_user(
    State(pool): State<sqlx::PgPool>,
    SessionUser { user_id }: SessionUser
) -> Result<Json<Me>, StatusCode> {
    let row = sqlx
        ::query("SELECT id, displayed_nickname, email, login_displayed FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&pool).await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::UNAUTHORIZED)?;
    Ok(
        Json(Me {
            id: row.try_get("id").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
            displayed_nickname: row.try_get("displayed_nickname").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
            email: row.try_get("email").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
            login_displayed: row
                .try_get("login_displayed")
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
        })
    )
}

// A logged-in panel user, resolved from the session cookie. Any handler that takes
// `SessionUser` is treated as protected by the compiler.
struct SessionUser {
    user_id: i64,
}

impl FromRequestParts<sqlx::PgPool> for SessionUser {
    type Rejection = StatusCode;

    async fn from_request_parts(
        parts: &mut Parts,
        pool: &sqlx::PgPool
    ) -> Result<Self, Self::Rejection> {
        let token = session_token_from_headers(&parts.headers).ok_or(StatusCode::UNAUTHORIZED)?;
        let row = sqlx
            ::query("SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > now()")
            .bind(hash_token(&token))
            .fetch_optional(pool).await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .ok_or(StatusCode::UNAUTHORIZED)?;
        let user_id: i64 = row
            .try_get("user_id")
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        Ok(SessionUser { user_id })
    }
}

// 32 bytes of OS randomness. This is a bearer credential, so it must be a CSPRNG.
fn new_session_token() -> Result<String, StatusCode> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(hex::encode(bytes))
}

// Tokens have 256 bits of entropy, so a plain SHA-256 is the right way to store them.
// (Argon2 is for low-entropy passwords; using it here would only add latency.)
fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(&hasher.finalize()[..])
}

fn cookie_secure() -> bool {
    std::env::var("COOKIE_SECURE").map(|value| value != "false").unwrap_or(true)
}

fn session_cookie(token: &str) -> String {
    let secure = if cookie_secure() { "; Secure" } else { "" };
    format!(
        "session={token}; HttpOnly; Path=/; SameSite=Lax; Max-Age={}{secure}",
        SESSION_TTL_HOURS * 60 * 60
    )
}

fn cleared_session_cookie() -> String {
    let secure = if cookie_secure() { "; Secure" } else { "" };
    format!("session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0{secure}")
}

fn session_token_from_headers(headers: &HeaderMap) -> Option<String> {
    for value in headers.get_all(header::COOKIE) {
        let Ok(value) = value.to_str() else {
            continue;
        };
        for pair in value.split(';') {
            let pair = pair.trim();
            if
                let Some(token) = pair.strip_prefix("session=") &&
                !token.is_empty()
            {
                return Some(token.to_owned());
            }
        }
    }
    None
}

#[derive(serde::Serialize)]
struct SecurityView {
    email_verified: bool,
    email_delivery: &'static str,
}

fn smtp_mode() -> &'static str {
    match std::env::var("SMTP_HOST").ok().as_deref() {
        Some("mailpit") => "preview",
        Some(host) if !host.trim().is_empty() => "smtp",
        _ => "unavailable",
    }
}

async fn account_security(
    State(pool): State<sqlx::PgPool>,
    SessionUser { user_id }: SessionUser
) -> Result<Json<SecurityView>, StatusCode> {
    let verified = sqlx::query_scalar::<_, bool>("SELECT email_verified_at IS NOT NULL FROM users WHERE id = $1")
        .bind(user_id).fetch_one(&pool).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(SecurityView { email_verified: verified, email_delivery: smtp_mode() }))
}

async fn security_budget(pool: &sqlx::PgPool, user_id: i64) -> Result<(), StatusCode> {
    match ip_limit_exceeded(pool, "security_user", 10, 900, &user_id.to_string()).await {
        Ok(None) => Ok(()),
        Ok(Some(_)) => Err(StatusCode::TOO_MANY_REQUESTS),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

fn password_matches(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash).is_ok_and(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok())
}

async fn send_account_mail(to: &str, subject: &str, body: String) -> Result<(), StatusCode> {
    use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
    use lettre::transport::smtp::authentication::Credentials;
    let unavailable = || StatusCode::SERVICE_UNAVAILABLE;
    let host = std::env::var("SMTP_HOST").ok().filter(|value| !value.trim().is_empty()).ok_or_else(unavailable)?;
    let from = std::env::var("SMTP_FROM").map_err(|_| unavailable())?;
    let tls = std::env::var("SMTP_TLS").unwrap_or_else(|_| "starttls".to_owned());
    let builder = match tls.as_str() {
        "starttls" => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&host).map_err(|_| unavailable())?,
        "tls" => AsyncSmtpTransport::<Tokio1Executor>::relay(&host).map_err(|_| unavailable())?,
        // Unencrypted SMTP is confined to the local development catcher.
        "none" if host == "mailpit" || host == "127.0.0.1" || host == "localhost" =>
            AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&host),
        _ => return Err(unavailable()),
    };
    let default_port = if tls == "none" { 1025 } else if tls == "tls" { 465 } else { 587 };
    let mut builder = builder.port(env_i64("SMTP_PORT", default_port) as u16)
        .timeout(Some(std::time::Duration::from_secs(10)));
    if let Ok(username) = std::env::var("SMTP_USERNAME") {
        let password = std::env::var("SMTP_PASSWORD").map_err(|_| unavailable())?;
        builder = builder.credentials(Credentials::new(username, password));
    }
    let message = Message::builder()
        .from(from.parse().map_err(|_| unavailable())?)
        .to(to.parse().map_err(|_| StatusCode::BAD_REQUEST)?)
        .subject(subject).body(body).map_err(|_| unavailable())?;
    builder.build().send(message).await.map_err(|_| unavailable())?;
    Ok(())
}

#[derive(serde::Deserialize)]
struct PasswordChange {
    current_password: String,
    new_password: String,
}

async fn change_password(
    State(pool): State<sqlx::PgPool>,
    SessionUser { user_id }: SessionUser,
    Json(input): Json<PasswordChange>
) -> Result<impl IntoResponse, StatusCode> {
    security_budget(&pool, user_id).await?;
    if input.new_password.chars().count() < 15 || input.new_password == input.current_password {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut tx = pool.begin().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let row = sqlx::query("SELECT email, password_hash FROM users WHERE id = $1 FOR UPDATE")
        .bind(user_id).fetch_one(&mut *tx).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let hash: String = row.try_get("password_hash").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if !password_matches(&input.current_password, &hash) { return Err(StatusCode::FORBIDDEN); }
    let new_hash = Argon2::default().hash_password(input.new_password.as_bytes())
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?.to_string();
    sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2").bind(new_hash).bind(user_id)
        .execute(&mut *tx).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    revoke_account_credentials(&mut tx, user_id).await?;
    tx.commit().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let _ = audit(&pool, "password_changed", Some(user_id), None, None).await;
    let email: String = row.try_get("email").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if smtp_mode() != "unavailable" {
        let _ = send_account_mail(&email, "Your website password changed",
            "Your website password was changed. All website sessions were signed out. If this was not you, contact the server operator. Your Minecraft password was not changed.".to_owned()).await;
    }
    Ok(([(header::SET_COOKIE, cleared_session_cookie())], StatusCode::NO_CONTENT))
}

async fn revoke_account_credentials(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, user_id: i64) -> Result<(), StatusCode> {
    for query in [
        "DELETE FROM sessions WHERE user_id = $1",
        "DELETE FROM account_email_tokens WHERE user_id = $1",
        "DELETE FROM link_codes WHERE user_id = $1 AND used_at IS NULL",
    ] {
        sqlx::query(query).bind(user_id).execute(&mut **tx).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    Ok(())
}

#[derive(serde::Deserialize)]
struct EmailChange {
    current_password: String,
    new_email: String,
}

async fn request_email_confirmation(
    State(pool): State<sqlx::PgPool>,
    SessionUser { user_id }: SessionUser,
    Json(input): Json<EmailChange>
) -> Result<StatusCode, StatusCode> {
    security_budget(&pool, user_id).await?;
    let target = input.new_email.trim().to_lowercase();
    if !email_address::EmailAddress::is_valid(&target) { return Err(StatusCode::BAD_REQUEST); }
    let base = std::env::var("PUBLIC_SITE_URL").map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let uri: Uri = base.parse().map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    if uri.scheme_str() != Some("https") || uri.authority().is_none()
        || uri.authority().is_some_and(|value| value.as_str().contains('@'))
        || uri.query().is_some() || uri.path() != "/" {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    let mut tx = pool.begin().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let row = sqlx::query("SELECT email, password_hash FROM users WHERE id = $1 FOR UPDATE")
        .bind(user_id).fetch_one(&mut *tx).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let hash: String = row.try_get("password_hash").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if !password_matches(&input.current_password, &hash) { return Err(StatusCode::FORBIDDEN); }
    let old_email: String = row.try_get("email").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let taken: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE email = $1 AND id <> $2)")
        .bind(&target).bind(user_id).fetch_one(&mut *tx).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if taken { return Err(StatusCode::CONFLICT); }
    let token = new_session_token()?;
    sqlx::query("INSERT INTO account_email_tokens (user_id, token_hash, current_email, target_email, expires_at)
        VALUES ($1, $2, $3, $4, now() + interval '15 minutes')
        ON CONFLICT (user_id) DO UPDATE SET token_hash = EXCLUDED.token_hash,
        current_email = EXCLUDED.current_email, target_email = EXCLUDED.target_email, expires_at = EXCLUDED.expires_at")
        .bind(user_id).bind(hash_token(&token)).bind(&old_email).bind(&target)
        .execute(&mut *tx).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let link = format!("{}/account/confirm-email#token={}", base.trim_end_matches('/'), token);
    send_account_mail(&target, "Confirm your website email",
        format!("Confirm this address for your website account:\n\n{link}\n\nThis link expires in 15 minutes and can be used once. Open the link and press Confirm email. If you did not request this, ignore it.")).await?;
    if old_email != target {
        send_account_mail(&old_email, "Website email change requested",
            "Someone who entered your current website password requested an email change. The address changes only after the new mailbox is confirmed. If this was not you, change your password now; that cancels the pending change. Your Minecraft account is unchanged.".to_owned()).await?;
    }
    tx.commit().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let _ = audit(&pool, "email_confirmation_requested", Some(user_id), None, None).await;
    Ok(StatusCode::ACCEPTED)
}

#[derive(serde::Deserialize)]
struct EmailConfirmation { token: String }

async fn confirm_email(
    State(pool): State<sqlx::PgPool>,
    Json(input): Json<EmailConfirmation>
) -> Result<impl IntoResponse, StatusCode> {
    if input.token.len() != 64 || !input.token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let hash = hash_token(&input.token);
    let user_id: i64 = sqlx::query_scalar("SELECT user_id FROM account_email_tokens WHERE token_hash = $1")
        .bind(&hash).fetch_optional(&pool).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::BAD_REQUEST)?;
    let mut tx = pool.begin().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let email: String = sqlx::query_scalar("SELECT email FROM users WHERE id = $1 FOR UPDATE")
        .bind(user_id).fetch_optional(&mut *tx).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::BAD_REQUEST)?;
    let row = sqlx::query("SELECT current_email, target_email FROM account_email_tokens
        WHERE user_id = $1 AND token_hash = $2 AND expires_at > now() FOR UPDATE")
        .bind(user_id).bind(hash).fetch_optional(&mut *tx).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::BAD_REQUEST)?;
    let current: String = row.try_get("current_email").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let target: String = row.try_get("target_email").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if current != email { return Err(StatusCode::BAD_REQUEST); }
    sqlx::query("DELETE FROM login_failures WHERE email = $1").bind(&email)
        .execute(&mut *tx).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    sqlx::query("UPDATE users SET email = $1, email_verified_at = now() WHERE id = $2")
        .bind(&target).bind(user_id).execute(&mut *tx).await.map_err(|error| match error {
            sqlx::Error::Database(db) if db.is_unique_violation() => StatusCode::CONFLICT,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        })?;
    revoke_account_credentials(&mut tx, user_id).await?;
    tx.commit().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let _ = audit(&pool, "email_confirmed", Some(user_id), None, None).await;
    Ok(([(header::SET_COOKIE, cleared_session_cookie())], StatusCode::NO_CONTENT))
}

// --- Account linking ---------------------------------------------------------

fn link_code_ttl_seconds() -> i64 {
    env_i64("LINK_CODE_TTL_SECONDS", 300)
}

fn link_claim_ip_limit() -> i64 {
    env_i64("LINK_CLAIM_IP_LIMIT", 30)
}

fn link_claim_ip_window_seconds() -> i64 {
    env_i64("LINK_CLAIM_IP_WINDOW_SECONDS", 60)
}

// Codes are read aloud and typed in-game, so the alphabet drops the characters people
// confuse (I, L, O, U, 0, 1).
const LINK_CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTVWXYZ23456789";
const LINK_CODE_LENGTH: usize = 8;

fn new_link_code() -> Result<String, StatusCode> {
    let alphabet = LINK_CODE_ALPHABET;
    // Rejection sampling keeps every symbol equally likely.
    let limit = 256 / alphabet.len() * alphabet.len();
    let mut code = String::with_capacity(LINK_CODE_LENGTH);
    let mut bytes = [0u8; 64];
    while code.len() < LINK_CODE_LENGTH {
        getrandom::fill(&mut bytes).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        for byte in bytes.iter() {
            let value = *byte as usize;
            if value < limit {
                code.push(alphabet[value % alphabet.len()] as char);
                if code.len() == LINK_CODE_LENGTH {
                    break;
                }
            }
        }
    }
    Ok(code)
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes
        .iter()
        .enumerate()
        .all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                *byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn is_minecraft_username(value: &str) -> bool {
    let length = value.chars().count();
    (3..=16).contains(&length) &&
        value.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = value.strip_prefix("Bearer ")?.trim();
    if token.is_empty() { None } else { Some(token.to_owned()) }
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        difference |= a ^ b;
    }
    difference == 0
}

// The plugin's shared secret is compared as SHA-256 digests, which keeps the check
// constant-time and independent of the two lengths.
//
// Fail closed: an unset token switches the endpoint off rather than opening it, and a
// wrong token is answered identically however close it was.
fn require_service_token(headers: &HeaderMap) -> Result<(), StatusCode> {
    let configured = std::env
        ::var("LINK_SERVICE_TOKEN")
        .ok()
        .filter(|token| !token.is_empty())
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let provided = bearer_token(headers).ok_or(StatusCode::UNAUTHORIZED)?;
    if !constant_time_eq(hash_token(&provided).as_bytes(), hash_token(&configured).as_bytes()) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(())
}

async fn audit(
    pool: &sqlx::PgPool,
    event: &str,
    user_id: Option<i64>,
    detail: Option<&str>,
    ip: Option<&str>
) -> Result<(), sqlx::Error> {
    sqlx
        ::query("INSERT INTO audit_log (event, user_id, detail, ip) VALUES ($1, $2, $3, $4)")
        .bind(event)
        .bind(user_id)
        .bind(detail)
        .bind(ip)
        .execute(pool).await?;
    Ok(())
}

#[derive(serde::Deserialize)]
struct LinkClaim {
    code: String,
    uuid: String,
    username: String,
}

#[derive(serde::Serialize)]
struct LinkCode {
    code: String,
    expires_in: i64,
}

#[derive(serde::Serialize)]
struct LinkedAccount {
    uuid: String,
    username: String,
    linked_at: String,
}

#[derive(serde::Serialize)]
struct LinkedAccounts {
    accounts: Vec<LinkedAccount>,
}

async fn start_link(
    State(pool): State<sqlx::PgPool>,
    headers: HeaderMap,
    SessionUser { user_id }: SessionUser
) -> Result<Json<LinkCode>, StatusCode> {
    let code = new_link_code()?;
    let code_hash = hash_token(&code);
    let mut transaction = pool.begin().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    // Serialize issuance even when there are no existing codes to lock. Under
    // READ COMMITTED the following DELETE then sees the previous issuer's commit.
    sqlx::query("SELECT id FROM users WHERE id = $1 FOR UPDATE")
        .bind(user_id)
        .fetch_one(&mut *transaction).await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    // Only the newest code is ever valid.
    sqlx
        ::query("DELETE FROM link_codes WHERE user_id = $1 AND used_at IS NULL")
        .bind(user_id)
        .execute(&mut *transaction).await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let row = sqlx
        ::query(
            "INSERT INTO link_codes (user_id, code_hash, expires_at)
             VALUES ($1, $2, now() + make_interval(secs => $3::double precision))
             RETURNING extract(epoch from (expires_at - now()))::bigint AS expires_in"
        )
        .bind(user_id)
        .bind(&code_hash)
        .bind(link_code_ttl_seconds())
        .fetch_one(&mut *transaction).await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let expires_in: i64 = row
        .try_get("expires_in")
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    transaction.commit().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let _ = audit(&pool, "link_code_created", Some(user_id), None, Some(&client_ip(&headers))).await;
    Ok(Json(LinkCode { code, expires_in }))
}

async fn claim_link(
    State(pool): State<sqlx::PgPool>,
    headers: HeaderMap,
    Json(input): Json<LinkClaim>
) -> Result<StatusCode, StatusCode> {
    let ip = client_ip(&headers);
    require_service_token(&headers)?;
    let code = input.code.trim().to_uppercase();
    let uuid = input.uuid.trim().to_lowercase();
    let username = input.username.trim().to_owned();
    if code.is_empty() || !is_uuid(&uuid) || !is_minecraft_username(&username) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut transaction = pool.begin().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    // Marking the code used is the single-use gate: only one claim can win it.
    let claimed = sqlx
        ::query(
            "UPDATE link_codes SET used_at = now()
             WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
             RETURNING user_id"
        )
        .bind(hash_token(&code))
        .fetch_optional(&mut *transaction).await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    // An unknown, used, or expired code is answered identically.
    let Some(claimed) = claimed else {
        return Err(StatusCode::NOT_FOUND);
    };
    let user_id: i64 = claimed
        .try_get("user_id")
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let inserted = sqlx
        ::query("INSERT INTO minecraft_accounts (user_id, uuid, username) VALUES ($1, $2, $3)")
        .bind(user_id)
        .bind(&uuid)
        .bind(&username)
        .execute(&mut *transaction).await;
    match inserted {
        Ok(_) => {}
        // Rolling back keeps the code usable, so the player can retry with a fix.
        Err(sqlx::Error::Database(error)) if error.is_unique_violation() => {
            return Err(StatusCode::CONFLICT);
        }
        Err(_) => {
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
    }
    transaction.commit().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let _ = audit(&pool, "link_claimed", Some(user_id), Some(&uuid), Some(&ip)).await;
    Ok(StatusCode::OK)
}

#[derive(serde::Deserialize)]
struct LinkStatusRequest {
    uuid: String,
}

// The in-game plugin calls this right after a player authenticates, so it can point
// them at the panel if they have not linked yet.
//
// It answers with a bare status code, exactly like the claim endpoint, so the plugin
// never has to parse JSON: `200` when the UUID is linked, `404` when it is not.
//
// Deliberately not rate limited: it is a single indexed lookup behind the service
// token, on an endpoint the proxy already hides from the internet. Sharing the claim
// endpoint's budget would make one busy login minute look like an attack and take
// real claims down with it, and a check that fails costs a player a chat message and
// nothing else.
async fn link_status(
    State(pool): State<sqlx::PgPool>,
    headers: HeaderMap,
    Json(input): Json<LinkStatusRequest>
) -> Result<StatusCode, StatusCode> {
    require_service_token(&headers)?;
    let uuid = input.uuid.trim().to_lowercase();
    if !is_uuid(&uuid) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let linked = sqlx
        ::query("SELECT 1 FROM minecraft_accounts WHERE uuid = $1")
        .bind(&uuid)
        .fetch_optional(&pool).await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .is_some();
    if linked { Ok(StatusCode::OK) } else { Err(StatusCode::NOT_FOUND) }
}

// Only the trusted game plugin may request this, for its authenticated player's
// own UUID. Never return the complete address or use this as a recovery token.
fn masked_email(email: &str) -> String {
    let Some((local, domain)) = email.rsplit_once('@') else {
        return "***".to_owned();
    };
    let first = if local.chars().count() > 1 {
        local.chars().next().filter(|character| character.is_ascii_alphanumeric())
    } else {
        None
    };
    // Keep legacy chat formatting/control characters out of the plugin response,
    // even if an unusual quoted or international address exists in the database.
    let domain = if !domain.is_empty()
        && domain.chars().all(|character| character.is_ascii_alphanumeric() || character == '.' || character == '-') {
        domain
    } else {
        "hidden"
    };
    format!("{}***@{}", first.map(|character| character.to_string()).unwrap_or_default(), domain)
}

async fn link_email(
    State(pool): State<sqlx::PgPool>,
    headers: HeaderMap,
    Json(input): Json<LinkStatusRequest>
) -> Result<impl IntoResponse, StatusCode> {
    require_service_token(&headers)?;
    let uuid = input.uuid.trim().to_lowercase();
    if !is_uuid(&uuid) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let email = sqlx::query_scalar::<_, String>(
        "SELECT users.email FROM minecraft_accounts
         JOIN users ON users.id = minecraft_accounts.user_id
         WHERE minecraft_accounts.uuid = $1"
    )
        .bind(&uuid)
        .fetch_optional(&pool).await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    Ok(([(header::CACHE_CONTROL, "no-store")], masked_email(&email)))
}

async fn list_links(
    State(pool): State<sqlx::PgPool>,
    SessionUser { user_id }: SessionUser
) -> Result<Json<LinkedAccounts>, StatusCode> {
    let rows = sqlx
        ::query(
            "SELECT uuid, username, linked_at::text AS linked_at
             FROM minecraft_accounts WHERE user_id = $1 ORDER BY linked_at"
        )
        .bind(user_id)
        .fetch_all(&pool).await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut accounts = Vec::with_capacity(rows.len());
    for row in rows {
        accounts.push(LinkedAccount {
            uuid: row.try_get("uuid").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
            username: row
                .try_get("username")
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
            linked_at: row
                .try_get("linked_at")
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
        });
    }
    Ok(Json(LinkedAccounts { accounts }))
}

async fn unlink_account(
    State(pool): State<sqlx::PgPool>,
    headers: HeaderMap,
    SessionUser { user_id }: SessionUser,
    Path(uuid): Path<String>
) -> Result<StatusCode, StatusCode> {
    let uuid = uuid.trim().to_lowercase();
    let deleted = sqlx
        ::query("DELETE FROM minecraft_accounts WHERE user_id = $1 AND uuid = $2")
        .bind(user_id)
        .bind(&uuid)
        .execute(&pool).await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if deleted.rows_affected() == 0 {
        return Err(StatusCode::NOT_FOUND);
    }
    let _ = audit(
        &pool,
        "link_unlinked",
        Some(user_id),
        Some(&uuid),
        Some(&client_ip(&headers))
    ).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn rate_limit_claim_ip(
    State(pool): State<sqlx::PgPool>,
    request: Request,
    next: Next
) -> Response {
    rate_limit_request(
        &pool,
        "link_claim_ip",
        link_claim_ip_limit(),
        link_claim_ip_window_seconds(),
        request,
        next
    ).await
}

// --- Player statistics ---------------------------------------------------------
//
// The game server's LinkBridge plugin measures what it can see in game (time a
// player is online, blocks placed and broken) and reports the growth since its
// last accepted report. The panel adds those deltas per in-game UUID. The panel
// never measures the game itself: a row means "the game server told us this much
// activity happened", and the cabinet shows only what was actually reported.
//
// Deltas rather than totals: the plugin's counters restart when the server
// restarts, so no absolute number here can be wrong after a restart. The costs
// of that choice are both small and documented: a crash loses at most one flush
// (a few minutes of activity), and a delta is double-counted only if its
// response is lost after this endpoint committed — rare on the Compose network,
// and then an over-count of at most one flush.

// A single report covers the players active since the last flush, so one server
// fit into a request; anything larger is a bug in the plugin, not a player base.
const STATS_REPORT_MAX_PLAYERS: usize = 1000;
// About 136 years of play, or four billion blocks, in one report. Larger values
// are broken counters, and one broken field must not poison a whole flush.
const STATS_REPORT_MAX_COUNTER: i64 = 4_294_967_295;

#[derive(serde::Deserialize)]
struct StatsReport {
    players: Vec<StatsPlayer>,
}

#[derive(serde::Deserialize)]
struct StatsPlayer {
    uuid: String,
    username: String,
    play_seconds: i64,
    blocks_placed: i64,
    blocks_broken: i64,
}

fn valid_counter(value: i64) -> bool {
    (0..=STATS_REPORT_MAX_COUNTER).contains(&value)
}

fn valid_stats_report(report: &StatsReport) -> bool {
    (1..=STATS_REPORT_MAX_PLAYERS).contains(&report.players.len())
        && report.players.iter().all(|player| {
            is_uuid(&player.uuid)
                && is_minecraft_username(&player.username)
                && valid_counter(player.play_seconds)
                && valid_counter(player.blocks_placed)
                && valid_counter(player.blocks_broken)
        })
}

// Deliberately not rate limited: the plugin sends at most one batched request
// per flush (every few minutes), one per player quit, and one on shutdown, all
// from the game server's single container address. Sharing the claim budget
// would let a busy login minute starve the statistics the same way it could
// starve claims, and this endpoint is a token check plus indexed upserts behind
// a proxy block, like link_status.
async fn report_stats(
    State(pool): State<sqlx::PgPool>,
    headers: HeaderMap,
    Json(mut report): Json<StatsReport>
) -> Result<StatusCode, StatusCode> {
    require_service_token(&headers)?;
    for player in report.players.iter_mut() {
        player.uuid = player.uuid.trim().to_lowercase();
        player.username = player.username.trim().to_owned();
    }
    if !valid_stats_report(&report) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut transaction = pool.begin().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    for player in &report.players {
        sqlx
            ::query(
                "INSERT INTO player_stats (uuid, username, play_seconds, blocks_placed, blocks_broken)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (uuid) DO UPDATE SET
                   username = EXCLUDED.username,
                   play_seconds = player_stats.play_seconds + EXCLUDED.play_seconds,
                   blocks_placed = player_stats.blocks_placed + EXCLUDED.blocks_placed,
                   blocks_broken = player_stats.blocks_broken + EXCLUDED.blocks_broken,
                   last_seen_at = now()"
            )
            .bind(&player.uuid)
            .bind(&player.username)
            .bind(player.play_seconds)
            .bind(player.blocks_placed)
            .bind(player.blocks_broken)
            .execute(&mut *transaction).await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    transaction.commit().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::OK)
}

#[derive(serde::Serialize)]
struct AccountStats {
    play_seconds: i64,
    blocks_placed: i64,
    blocks_broken: i64,
    first_seen_at: String,
    last_seen_at: String,
}

#[derive(serde::Serialize)]
struct StatsAccount {
    uuid: String,
    username: String,
    linked_at: String,
    stats: Option<AccountStats>,
}

#[derive(serde::Serialize)]
struct StatsSummary {
    accounts: i64,
    accounts_with_stats: i64,
    play_seconds: i64,
    blocks_placed: i64,
    blocks_broken: i64,
}

#[derive(serde::Serialize)]
struct StatsView {
    accounts: Vec<StatsAccount>,
    summary: StatsSummary,
}

// The session cookie decides what is visible: only the statistics of accounts
// this user has linked. A report about a UUID nobody linked (or that another
// user linked) is stored, but no request can make it visible.
async fn stats_for_user(
    State(pool): State<sqlx::PgPool>,
    SessionUser { user_id }: SessionUser
) -> Result<Json<StatsView>, StatusCode> {
    let rows = sqlx
        ::query(
            "SELECT ma.uuid, ma.username, ma.linked_at::text AS linked_at,
                    ps.play_seconds, ps.blocks_placed, ps.blocks_broken,
                    ps.first_seen_at::text AS first_seen_at,
                    ps.last_seen_at::text AS last_seen_at
             FROM minecraft_accounts ma
             LEFT JOIN player_stats ps ON ps.uuid = ma.uuid
             WHERE ma.user_id = $1
             ORDER BY ma.linked_at"
        )
        .bind(user_id)
        .fetch_all(&pool).await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut accounts = Vec::with_capacity(rows.len());
    let mut summary = StatsSummary {
        accounts: 0,
        accounts_with_stats: 0,
        play_seconds: 0,
        blocks_placed: 0,
        blocks_broken: 0,
    };
    for row in &rows {
        let uuid: String = row.try_get("uuid").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let username: String = row.try_get("username").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let linked_at: String = row.try_get("linked_at").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let stats = match row.try_get::<Option<i64>, &str>("play_seconds") {
            Ok(Some(play_seconds)) => {
                let blocks_placed: i64 = row
                    .try_get("blocks_placed")
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
                let blocks_broken: i64 = row
                    .try_get("blocks_broken")
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
                let first_seen_at: String = row
                    .try_get("first_seen_at")
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
                let last_seen_at: String = row
                    .try_get("last_seen_at")
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
                summary.accounts_with_stats += 1;
                summary.play_seconds += play_seconds;
                summary.blocks_placed += blocks_placed;
                summary.blocks_broken += blocks_broken;
                Some(AccountStats {
                    play_seconds,
                    blocks_placed,
                    blocks_broken,
                    first_seen_at,
                    last_seen_at,
                })
            }
            // Linked, but the server has not reported anything about this UUID yet.
            Ok(None) => None,
            Err(_) => return Err(StatusCode::INTERNAL_SERVER_ERROR),
        };
        summary.accounts += 1;
        accounts.push(StatsAccount { uuid, username, linked_at, stats });
    }
    Ok(Json(StatsView { accounts, summary }))
}

#[cfg(test)]
mod test {
    use super::*;
    use axum::{ body::Body, http::Request };
    use rand::{ distr::Alphanumeric, RngExt };
    use tower::ServiceExt;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    // Send one request through the real router.
    async fn send(
        pool: &sqlx::PgPool,
        method: &str,
        uri: &str,
        cookie: Option<&str>,
        body: Option<serde_json::Value>
    ) -> Result<axum::response::Response, Box<dyn std::error::Error>> {
        send_from(pool, method, uri, cookie, body, None).await
    }

    // A random client IP per request keeps the per-IP limiter from bleeding across
    // parallel tests. Rate-limit tests pass a fixed IP via `send_from`.
    async fn send_from(
        pool: &sqlx::PgPool,
        method: &str,
        uri: &str,
        cookie: Option<&str>,
        body: Option<serde_json::Value>,
        ip: Option<&str>
    ) -> Result<axum::response::Response, Box<dyn std::error::Error>> {
        let ip = ip.map(str::to_owned).unwrap_or_else(random_ip);
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header("x-real-ip", ip);
        if let Some(cookie) = cookie {
            builder = builder.header("cookie", cookie);
        }
        let body = match body {
            Some(body) => {
                builder = builder.header("content-type", "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        Ok(app(pool.clone()).oneshot(builder.body(body)?).await?)
    }

    async fn post_json_response(
        pool: &sqlx::PgPool,
        uri: &str,
        body: serde_json::Value
    ) -> Result<axum::response::Response, Box<dyn std::error::Error>> {
        send(pool, "POST", uri, None, Some(body)).await
    }

    // Send one JSON request through the real router and return the status code.
    async fn post_json(
        pool: &sqlx::PgPool,
        uri: &str,
        body: serde_json::Value
    ) -> Result<StatusCode, Box<dyn std::error::Error>> {
        Ok(post_json_response(pool, uri, body).await?.status())
    }

    async fn get_with_cookie(
        pool: &sqlx::PgPool,
        uri: &str,
        cookie: Option<&str>
    ) -> Result<axum::response::Response, Box<dyn std::error::Error>> {
        send(pool, "GET", uri, cookie, None).await
    }

    // Pull the `session=...` cookie out of a login response.
    fn session_cookie_from(response: &axum::response::Response) -> Option<String> {
        let value = response.headers().get(axum::http::header::SET_COOKIE)?.to_str().ok()?;
        let token = value.split(';').next()?.strip_prefix("session=")?;
        if token.is_empty() { None } else { Some(format!("session={token}")) }
    }

    async fn body_json(
        response: axum::response::Response
    ) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
        Ok(serde_json::from_slice(&bytes)?)
    }

    async fn register_request(
        pool: &sqlx::PgPool,
        displayed_nickname: &str,
        login: &str,
        email: &str,
        password: &str
    ) -> Result<StatusCode, Box<dyn std::error::Error>> {
        post_json(
            pool,
            "/api/register",
            serde_json::json!({
                "displayed_nickname": displayed_nickname,
                "login": login,
                "email": email,
                "password": password,
            })
        ).await
    }

    async fn login_request(
        pool: &sqlx::PgPool,
        email: &str,
        password: &str
    ) -> Result<StatusCode, Box<dyn std::error::Error>> {
        post_json(
            pool,
            "/api/login",
            serde_json::json!({ "email": email, "password": password })
        ).await
    }

    // Log in and return the `session=...` cookie (panics if login did not set one).
    async fn login_cookie(
        pool: &sqlx::PgPool,
        email: &str,
        password: &str
    ) -> Result<String, Box<dyn std::error::Error>> {
        let response = post_json_response(
            pool,
            "/api/login",
            serde_json::json!({ "email": email, "password": password })
        ).await?;
        Ok(session_cookie_from(&response).expect("login should set a session cookie"))
    }

    fn set_cookie_of(response: &axum::response::Response) -> String {
        response
            .headers()
            .get(axum::http::header::SET_COOKIE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned()
    }

    fn random_id() -> String {
        rand::rng().sample_iter(Alphanumeric).take(16).map(char::from).collect()
    }

    fn random_ip() -> String {
        let mut rng = rand::rng();
        format!(
            "10.{}.{}.{}",
            rng.random_range(0..=255u8),
            rng.random_range(0..=255u8),
            rng.random_range(0..=255u8)
        )
    }

    async fn post_json_from(
        pool: &sqlx::PgPool,
        uri: &str,
        body: serde_json::Value,
        ip: &str
    ) -> Result<StatusCode, Box<dyn std::error::Error>> {
        Ok(send_from(pool, "POST", uri, None, Some(body), Some(ip)).await?.status())
    }

    async fn login_from(
        pool: &sqlx::PgPool,
        email: &str,
        password: &str,
        ip: &str
    ) -> Result<StatusCode, Box<dyn std::error::Error>> {
        post_json_from(
            pool,
            "/api/login",
            serde_json::json!({ "email": email, "password": password }),
            ip
        ).await
    }

    // Clear this subject's limiter rows so repeated runs start from zero.
    async fn clear_rate_limits(
        pool: &sqlx::PgPool,
        subject: &str
    ) -> Result<(), Box<dyn std::error::Error>> {
        sqlx::query("DELETE FROM auth_rate_limits WHERE subject = $1")
            .bind(subject)
            .execute(pool).await?;
        Ok(())
    }

    // Drop limiter rows from earlier runs, whose window has already rolled over.
    async fn prune_rate_limits(pool: &sqlx::PgPool) -> Result<(), Box<dyn std::error::Error>> {
        for (scope, window) in [
            ("login_ip", login_ip_window_seconds()),
            ("register_ip", register_ip_window_seconds()),
            ("link_claim_ip", link_claim_ip_window_seconds()),
        ] {
            sqlx::query("DELETE FROM auth_rate_limits WHERE scope = $1 AND window_index < $2")
                .bind(scope)
                .bind(now_unix() / window)
                .execute(pool).await?;
        }
        Ok(())
    }

    // The service token the tests service is configured with.
    fn test_service_token() -> String {
        std::env::var("LINK_SERVICE_TOKEN").unwrap_or_else(|_| "test-service-token".to_owned())
    }

    // Register a user, log in, and hand back the email (for cleanup) and the cookie.
    async fn fresh_user(
        pool: &sqlx::PgPool
    ) -> Result<(String, String), Box<dyn std::error::Error>> {
        let random = random_id();
        let email = format!("test_{random}@example.com").to_lowercase();
        let login = format!("test_{random}").to_lowercase();
        register_request(pool, "Test", &login, &email, "a-long-test-password").await?;
        let cookie = login_cookie(pool, &email, "a-long-test-password").await?;
        Ok((email, cookie))
    }

    // Remove a test user and everything it produced, including audit rows.
    async fn delete_user(pool: &sqlx::PgPool, email: &str) -> Result<(), Box<dyn std::error::Error>> {
        sqlx
            ::query("DELETE FROM audit_log WHERE user_id = (SELECT id FROM users WHERE email = $1)")
            .bind(email)
            .execute(pool).await?;
        sqlx::query("DELETE FROM users WHERE email= $1").bind(email).execute(pool).await?;
        Ok(())
    }

    async fn post_internal(
        pool: &sqlx::PgPool,
        uri: &str,
        token: Option<&str>,
        body: serde_json::Value,
        ip: &str
    ) -> Result<axum::response::Response, Box<dyn std::error::Error>> {
        let mut builder = Request::builder()
            .method("POST")
            .uri(uri)
            .header("x-real-ip", ip)
            .header("content-type", "application/json");
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        Ok(app(pool.clone()).oneshot(builder.body(Body::from(body.to_string()))?).await?)
    }

    // Start a link flow for a logged-in user and return the one-time code.
    async fn start_code(
        pool: &sqlx::PgPool,
        cookie: &str
    ) -> Result<String, Box<dyn std::error::Error>> {
        let response = send(pool, "POST", "/api/link/start", Some(cookie), None).await?;
        assert_eq!(response.status(), StatusCode::OK);
        Ok(body_json(response).await?["code"].as_str().unwrap_or_default().to_owned())
    }

    async fn claim(
        pool: &sqlx::PgPool,
        code: &str,
        uuid: &str,
        username: &str
    ) -> Result<StatusCode, Box<dyn std::error::Error>> {
        post_internal(
            pool,
            "/internal/link/claim",
            Some(&test_service_token()),
            serde_json::json!({ "code": code, "uuid": uuid, "username": username }),
            &random_ip()
        ).await
            .map(|response| response.status())
    }

    fn test_uuid(seed: &str) -> String {
        // A stable, well-formed UUID derived from the seed.
        let hash = hash_token(seed);
        format!(
            "{}-{}-{}-{}-{}",
            &hash[0..8],
            &hash[8..12],
            &hash[12..16],
            &hash[16..20],
            &hash[20..32]
        )
    }

    #[tokio::test]
    async fn database_connection_works() -> TestResult {
        let pool = connect().await?;
        sqlx::query("SELECT 1").execute(&pool).await?;
        Ok(())
    }

    #[tokio::test]
    async fn database_user_login_or_register_works() -> TestResult {
        let pool = connect().await?;
        let random = random_id();
        let email = format!("test_{random}@example.com").to_lowercase();
        let login = format!("test_{random}").to_lowercase();
        let registered = register_request(&pool, "Test",
            &login,
            &email,
            "a-long-test-password"
        ).await?;
        let logged_in = login_request(&pool, &email, "a-long-test-password").await?;
        sqlx::query("DELETE FROM users WHERE email= $1").bind(&email).execute(&pool).await?;
        assert_eq!(registered, StatusCode::CREATED);
        assert_eq!(logged_in, StatusCode::OK);
        Ok(())
    }

    #[tokio::test]
    async fn register_empty_fields() -> TestResult {
        let pool = connect().await?;
        let random = random_id();
        let email = format!("test_{random}@example.com").to_lowercase();
        let login = random.to_lowercase();
        let empty_nickname = register_request(&pool, "",
            &login,
            &email,
            "a-long-test-password"
        ).await?;
        let empty_login = register_request(&pool, "Test",
            "",
            &email,
            "a-long-test-password"
        ).await?;
        let empty_email = register_request(&pool, "Test",
            &login,
            "",
            "a-long-test-password"
        ).await?;
        let empty_password = register_request(&pool, "Test", &login, &email, "").await?;
        sqlx::query("DELETE FROM users WHERE email= $1").bind(&email).execute(&pool).await?;
        assert_eq!(empty_nickname, StatusCode::BAD_REQUEST);
        assert_eq!(empty_login, StatusCode::BAD_REQUEST);
        assert_eq!(empty_email, StatusCode::BAD_REQUEST);
        assert_eq!(empty_password, StatusCode::BAD_REQUEST);
        Ok(())
    }

    #[tokio::test]
    async fn register_login_characters_fields() -> TestResult {
        let pool = connect().await?;
        let random = random_id();
        let email = format!("test_{random}@example.com").to_lowercase();
        let login = format!("!te_{random}@").to_lowercase();
        let space = register_request(&pool, "Test",
            "Test Test",
            &email,
            "a-long-test-password"
        ).await?;
        let dot = register_request(&pool, "Test",
            "Test.Test",
            &email,
            "a-long-test-password"
        ).await?;
        let comma = register_request(&pool, "Test",
            "Test,Test",
            &email,
            "a-long-test-password"
        ).await?;
        let valid = register_request(&pool, "Test",
            &login,
            &email,
            "a-long-test-password"
        ).await?;
        sqlx::query("DELETE FROM users WHERE email= $1").bind(&email).execute(&pool).await?;
        assert_eq!(space, StatusCode::BAD_REQUEST);
        assert_eq!(dot, StatusCode::BAD_REQUEST);
        assert_eq!(comma, StatusCode::BAD_REQUEST);
        assert_eq!(valid, StatusCode::CREATED);
        Ok(())
    }

    #[tokio::test]
    async fn register_invalid_email() -> TestResult {
        let pool = connect().await?;
        let email = random_id();
        let result = register_request(&pool, "Test",
            &email,
            &email,
            "a-long-test-password"
        ).await?;
        sqlx::query("DELETE FROM users WHERE email= $1").bind(&email).execute(&pool).await?;
        assert_eq!(result, StatusCode::BAD_REQUEST);
        Ok(())
    }

    #[tokio::test]
    async fn register_short_password() -> TestResult {
        let pool = connect().await?;
        let random = random_id();
        let email = format!("test_{random}@example.com").to_lowercase();
        let login = random.to_lowercase();
        let fifteen = register_request(&pool, "Test",
            &login,
            &email,
            "15fifteencharac"
        ).await?;
        let fourteen = register_request(&pool, "Test",
            &login,
            &email,
            "14fourteenchar"
        ).await?;
        sqlx::query("DELETE FROM users WHERE email= $1").bind(&email).execute(&pool).await?;
        assert_eq!(fifteen, StatusCode::CREATED);
        assert_eq!(fourteen, StatusCode::BAD_REQUEST);
        Ok(())
    }

    #[tokio::test]
    async fn register_duplicate_email() -> TestResult {
        let pool = connect().await?;
        let random = random_id();
        let email = format!("test_{random}@example.com").to_lowercase();
        let first_login = format!("test_{random}").to_lowercase();
        let second_login = format!("duplicate_{random}").to_lowercase();
        let first = register_request(&pool, "Test",
            &first_login,
            &email,
            "a-long-test-password"
        ).await?;
        let second = register_request(&pool, "Test",
            &second_login,
            &email,
            "a-long-test-password"
        ).await?;
        sqlx::query("DELETE FROM users WHERE email= $1").bind(&email).execute(&pool).await?;
        assert_eq!(first, StatusCode::CREATED);
        assert_eq!(second, StatusCode::CONFLICT);
        Ok(())
    }

    #[tokio::test]
    async fn register_duplicate_login() -> TestResult {
        let pool = connect().await?;
        let random = random_id();
        let login = format!("test_{random}").to_lowercase();
        let first_email = format!("test_{random}@example.com").to_lowercase();
        let second_email = format!("other_{random}@example.com").to_lowercase();
        let first = register_request(&pool, "Test",
            &login,
            &first_email,
            "a-long-test-password"
        ).await?;
        let second = register_request(&pool, "Test",
            &login,
            &second_email,
            "a-long-test-password"
        ).await?;
        sqlx::query("DELETE FROM users WHERE email= $1").bind(&first_email).execute(&pool).await?;
        assert_eq!(first, StatusCode::CREATED);
        assert_eq!(second, StatusCode::CONFLICT);
        Ok(())
    }

    #[tokio::test]
    async fn register_duplicate_case_insensitive() -> TestResult {
        let pool = connect().await?;
        let random = random_id();
        let mixed_email = format!("Test_{random}@Example.com");
        let upper_email = format!("TEST_{random}@EXAMPLE.COM");
        let stored_email = mixed_email.to_lowercase();
        let first_login = format!("first_{random}").to_lowercase();
        let second_login = format!("second_{random}").to_lowercase();
        let first = register_request(&pool, "Test",
            &first_login,
            &mixed_email,
            "a-long-test-password"
        ).await?;
        let second = register_request(&pool, "Test",
            &second_login,
            &upper_email,
            "a-long-test-password"
        ).await?;
        sqlx::query("DELETE FROM users WHERE email= $1").bind(&stored_email).execute(&pool).await?;
        assert_eq!(first, StatusCode::CREATED);
        assert_eq!(second, StatusCode::CONFLICT);
        Ok(())
    }

    #[tokio::test]
    async fn login_unknown_email() -> TestResult {
        let pool = connect().await?;
        let random = random_id();
        let email = format!("missing_{random}@example.com").to_lowercase();
        let result = login_request(&pool, &email, "a-long-test-password").await?;
        assert_eq!(result, StatusCode::UNAUTHORIZED);
        Ok(())
    }

    #[tokio::test]
    async fn login_wrong_password() -> TestResult {
        let pool = connect().await?;
        let random = random_id();
        let email = format!("test_{random}@example.com").to_lowercase();
        let login = format!("test_{random}").to_lowercase();
        let registered = register_request(&pool, "Test",
            &login,
            &email,
            "a-long-test-password"
        ).await?;
        let wrong = login_request(&pool, &email, "a-different-password").await?;
        sqlx::query("DELETE FROM users WHERE email= $1").bind(&email).execute(&pool).await?;
        assert_eq!(registered, StatusCode::CREATED);
        assert_eq!(wrong, StatusCode::UNAUTHORIZED);
        Ok(())
    }

    #[tokio::test]
    async fn login_email_case_insensitive() -> TestResult {
        let pool = connect().await?;
        let random = random_id();
        let email = format!("test_{random}@example.com").to_lowercase();
        let login = format!("test_{random}").to_lowercase();
        let registered = register_request(&pool, "Test",
            &login,
            &email,
            "a-long-test-password"
        ).await?;
        let logged_in = login_request(&pool, &email.to_uppercase(), "a-long-test-password").await?;
        sqlx::query("DELETE FROM users WHERE email= $1").bind(&email).execute(&pool).await?;
        assert_eq!(registered, StatusCode::CREATED);
        assert_eq!(logged_in, StatusCode::OK);
        Ok(())
    }

    #[tokio::test]
    async fn login_creates_session_and_me_returns_user() -> TestResult {
        let pool = connect().await?;
        let random = random_id();
        let email = format!("test_{random}@example.com").to_lowercase();
        let login = format!("test_{random}").to_lowercase();
        let registered = register_request(&pool, "Test",
            &login,
            &email,
            "a-long-test-password"
        ).await?;
        let login_response = post_json_response(
            &pool,
            "/api/login",
            serde_json::json!({ "email": email.clone(), "password": "a-long-test-password" })
        ).await?;
        let cookie = session_cookie_from(&login_response);
        let me_response = get_with_cookie(&pool, "/api/me", cookie.as_deref()).await?;
        let me_status = me_response.status();
        let me = body_json(me_response).await?;
        sqlx::query("DELETE FROM users WHERE email= $1").bind(&email).execute(&pool).await?;
        assert_eq!(registered, StatusCode::CREATED);
        assert_eq!(login_response.status(), StatusCode::OK);
        assert!(cookie.is_some(), "login should set a session cookie");
        assert_eq!(me_status, StatusCode::OK);
        assert_eq!(me["email"], email);
        Ok(())
    }

    #[tokio::test]
    async fn me_without_session_is_unauthorized() -> TestResult {
        let pool = connect().await?;
        let status = get_with_cookie(&pool, "/api/me", None).await?.status();
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        Ok(())
    }

    #[tokio::test]
    async fn me_with_invalid_token_is_unauthorized() -> TestResult {
        let pool = connect().await?;
        let status = get_with_cookie(&pool, "/api/me", Some("session=not-a-real-token")).await?.status();
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        Ok(())
    }

    #[tokio::test]
    async fn logout_revokes_session() -> TestResult {
        let pool = connect().await?;
        let random = random_id();
        let email = format!("test_{random}@example.com").to_lowercase();
        let login = format!("test_{random}").to_lowercase();
        register_request(&pool, "Test", &login, &email, "a-long-test-password").await?;
        let login_response = post_json_response(
            &pool,
            "/api/login",
            serde_json::json!({ "email": email.clone(), "password": "a-long-test-password" })
        ).await?;
        let cookie = session_cookie_from(&login_response).expect("login should set a session cookie");
        let before = get_with_cookie(&pool, "/api/me", Some(&cookie)).await?.status();
        let logout = send(&pool, "POST", "/api/logout", Some(&cookie), None).await?;
        let after = get_with_cookie(&pool, "/api/me", Some(&cookie)).await?.status();
        sqlx::query("DELETE FROM users WHERE email= $1").bind(&email).execute(&pool).await?;
        assert_eq!(before, StatusCode::OK);
        assert_eq!(logout.status(), StatusCode::OK);
        assert_eq!(after, StatusCode::UNAUTHORIZED);
        Ok(())
    }

    #[tokio::test]
    async fn expired_session_is_rejected() -> TestResult {
        let pool = connect().await?;
        let random = random_id();
        let email = format!("test_{random}@example.com").to_lowercase();
        let login = format!("test_{random}").to_lowercase();
        register_request(&pool, "Test", &login, &email, "a-long-test-password").await?;
        let login_response = post_json_response(
            &pool,
            "/api/login",
            serde_json::json!({ "email": email.clone(), "password": "a-long-test-password" })
        ).await?;
        let cookie = session_cookie_from(&login_response).expect("login should set a session cookie");
        let token = cookie.strip_prefix("session=").unwrap();
        sqlx::query(
            "UPDATE sessions SET expires_at = now() - interval '1 hour' WHERE token_hash = $1"
        )
            .bind(hash_token(token))
            .execute(&pool).await?;
        let status = get_with_cookie(&pool, "/api/me", Some(&cookie)).await?.status();
        sqlx::query("DELETE FROM users WHERE email= $1").bind(&email).execute(&pool).await?;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        Ok(())
    }

    // --- Registration: validation edges -------------------------------------

    #[tokio::test]
    async fn register_whitespace_only_fields_are_rejected() -> TestResult {
        let pool = connect().await?;
        let random = random_id();
        let email = format!("test_{random}@example.com").to_lowercase();
        let login = random.to_lowercase();
        let blank_nickname = register_request(&pool, "   ",
            &login,
            &email,
            "a-long-test-password"
        ).await?;
        let blank_login = register_request(&pool, "Test",
            "   ",
            &email,
            "a-long-test-password"
        ).await?;
        sqlx::query("DELETE FROM users WHERE email= $1").bind(&email).execute(&pool).await?;
        assert_eq!(blank_nickname, StatusCode::BAD_REQUEST);
        assert_eq!(blank_login, StatusCode::BAD_REQUEST);
        Ok(())
    }

    #[tokio::test]
    async fn register_non_ascii_login_is_rejected() -> TestResult {
        let pool = connect().await?;
        let random = random_id();
        let email = format!("test_{random}@example.com").to_lowercase();
        let result = register_request(&pool, "Test",
            "café",
            &email,
            "a-long-test-password"
        ).await?;
        sqlx::query("DELETE FROM users WHERE email= $1").bind(&email).execute(&pool).await?;
        assert_eq!(result, StatusCode::BAD_REQUEST);
        Ok(())
    }

    #[tokio::test]
    async fn register_missing_field_is_a_client_error() -> TestResult {
        let pool = connect().await?;
        let random = random_id();
        let email = format!("test_{random}@example.com").to_lowercase();
        let status = post_json(
            &pool,
            "/api/register",
            serde_json::json!({
                "displayed_nickname": "Test",
                "login": random.to_lowercase(),
                "email": email,
            })
        ).await?;
        sqlx::query("DELETE FROM users WHERE email= $1").bind(&email).execute(&pool).await?;
        assert!(status.is_client_error(), "expected a 4xx, got {status}");
        Ok(())
    }

    // The row must store the normalized email/login, keep the original casing in
    // `login_displayed`, and never keep the plaintext password.
    #[tokio::test]
    async fn register_stores_normalized_and_displayed_values() -> TestResult {
        let pool = connect().await?;
        let random = random_id();
        let mixed_email = format!("Test_{random}@Example.com");
        let mixed_login = format!("Test_{random}");
        let stored_email = mixed_email.to_lowercase();
        let stored_login = mixed_login.to_lowercase();
        let registered = register_request(&pool, "Test",
            &mixed_login,
            &mixed_email,
            "a-long-test-password"
        ).await?;
        let row = sqlx
            ::query("SELECT email, login, login_displayed, password_hash FROM users WHERE email = $1")
            .bind(&stored_email)
            .fetch_one(&pool).await?;
        let email_in_db: String = row.try_get("email")?;
        let login_in_db: String = row.try_get("login")?;
        let displayed: String = row.try_get("login_displayed")?;
        let hash: String = row.try_get("password_hash")?;
        sqlx::query("DELETE FROM users WHERE email= $1").bind(&stored_email).execute(&pool).await?;
        assert_eq!(registered, StatusCode::CREATED);
        assert_eq!(email_in_db, stored_email);
        assert_eq!(login_in_db, stored_login);
        assert_eq!(displayed, mixed_login);
        assert!(hash.starts_with("$argon2"), "password must be hashed with Argon2: {hash}");
        assert_ne!(hash, "a-long-test-password");
        Ok(())
    }

    // --- Login: cookie hardening and token-at-rest --------------------------

    #[tokio::test]
    async fn login_sets_hardened_session_cookie() -> TestResult {
        let pool = connect().await?;
        let random = random_id();
        let email = format!("test_{random}@example.com").to_lowercase();
        let login = format!("test_{random}").to_lowercase();
        register_request(&pool, "Test", &login, &email, "a-long-test-password").await?;
        let response = post_json_response(
            &pool,
            "/api/login",
            serde_json::json!({ "email": email.clone(), "password": "a-long-test-password" })
        ).await?;
        let status = response.status();
        let set_cookie = set_cookie_of(&response);
        sqlx::query("DELETE FROM users WHERE email= $1").bind(&email).execute(&pool).await?;
        assert_eq!(status, StatusCode::OK);
        assert!(set_cookie.starts_with("session="), "cookie: {set_cookie}");
        assert!(set_cookie.contains("HttpOnly"), "cookie: {set_cookie}");
        assert!(set_cookie.contains("Path=/"), "cookie: {set_cookie}");
        assert!(set_cookie.contains("SameSite=Lax"), "cookie: {set_cookie}");
        assert!(set_cookie.contains("Max-Age=86400"), "cookie: {set_cookie}");
        Ok(())
    }

    // Only the SHA-256 of the token may reach the database, never the token itself.
    #[tokio::test]
    async fn session_stores_only_the_token_hash() -> TestResult {
        let pool = connect().await?;
        let random = random_id();
        let email = format!("test_{random}@example.com").to_lowercase();
        let login = format!("test_{random}").to_lowercase();
        register_request(&pool, "Test", &login, &email, "a-long-test-password").await?;
        let cookie = login_cookie(&pool, &email, "a-long-test-password").await?;
        let token = cookie.strip_prefix("session=").unwrap().to_owned();
        let hashed: i64 = sqlx
            ::query_scalar("SELECT count(*) FROM sessions WHERE token_hash = $1")
            .bind(hash_token(&token))
            .fetch_one(&pool).await?;
        let raw: i64 = sqlx
            ::query_scalar("SELECT count(*) FROM sessions WHERE token_hash = $1")
            .bind(&token)
            .fetch_one(&pool).await?;
        sqlx::query("DELETE FROM users WHERE email= $1").bind(&email).execute(&pool).await?;
        assert_eq!(hashed, 1, "the SHA-256 of the token should be stored");
        assert_eq!(raw, 0, "the raw token must never be stored");
        Ok(())
    }

    // --- Logout -------------------------------------------------------------

    #[tokio::test]
    async fn logout_without_session_is_ok_and_clears_cookie() -> TestResult {
        let pool = connect().await?;
        let response = send(&pool, "POST", "/api/logout", None, None).await?;
        let status = response.status();
        let set_cookie = set_cookie_of(&response);
        assert_eq!(status, StatusCode::OK);
        assert!(set_cookie.contains("Max-Age=0"), "cookie should be cleared: {set_cookie}");
        Ok(())
    }

    #[tokio::test]
    async fn logout_with_unknown_token_is_ok() -> TestResult {
        let pool = connect().await?;
        let status = send(
            &pool,
            "POST",
            "/api/logout",
            Some("session=not-a-real-token"),
            None
        ).await?.status();
        assert_eq!(status, StatusCode::OK);
        Ok(())
    }

    // Logging out of one device must not log the user out of another.
    #[tokio::test]
    async fn logout_revokes_only_its_own_session() -> TestResult {
        let pool = connect().await?;
        let random = random_id();
        let email = format!("test_{random}@example.com").to_lowercase();
        let login = format!("test_{random}").to_lowercase();
        register_request(&pool, "Test", &login, &email, "a-long-test-password").await?;
        let first = login_cookie(&pool, &email, "a-long-test-password").await?;
        let second = login_cookie(&pool, &email, "a-long-test-password").await?;
        assert_ne!(first, second, "each login should mint a distinct session");
        let logged_out = send(&pool, "POST", "/api/logout", Some(&first), None).await?.status();
        let first_after = get_with_cookie(&pool, "/api/me", Some(&first)).await?.status();
        let second_after = get_with_cookie(&pool, "/api/me", Some(&second)).await?.status();
        sqlx::query("DELETE FROM users WHERE email= $1").bind(&email).execute(&pool).await?;
        assert_eq!(logged_out, StatusCode::OK);
        assert_eq!(first_after, StatusCode::UNAUTHORIZED);
        assert_eq!(second_after, StatusCode::OK);
        Ok(())
    }

    // --- Me / session resolution --------------------------------------------

    #[tokio::test]
    async fn me_reads_session_from_among_other_cookies() -> TestResult {
        let pool = connect().await?;
        let random = random_id();
        let email = format!("test_{random}@example.com").to_lowercase();
        let login = format!("test_{random}").to_lowercase();
        register_request(&pool, "Test", &login, &email, "a-long-test-password").await?;
        let cookie = login_cookie(&pool, &email, "a-long-test-password").await?;
        let token = cookie.strip_prefix("session=").unwrap();
        let combined = format!("theme=dark; session={token}; other=1");
        let status = get_with_cookie(&pool, "/api/me", Some(&combined)).await?.status();
        sqlx::query("DELETE FROM users WHERE email= $1").bind(&email).execute(&pool).await?;
        assert_eq!(status, StatusCode::OK);
        Ok(())
    }

    #[tokio::test]
    async fn me_with_empty_session_cookie_is_unauthorized() -> TestResult {
        let pool = connect().await?;
        let status = get_with_cookie(&pool, "/api/me", Some("session=")).await?.status();
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        Ok(())
    }

    #[tokio::test]
    async fn me_returns_profile_and_preserves_login_casing() -> TestResult {
        let pool = connect().await?;
        let random = random_id();
        let email = format!("test_{random}@example.com").to_lowercase();
        let mixed_login = format!("Test_{random}");
        register_request(&pool, "Ada",
            &mixed_login,
            &email,
            "a-long-test-password"
        ).await?;
        let cookie = login_cookie(&pool, &email, "a-long-test-password").await?;
        let me_response = get_with_cookie(&pool, "/api/me", Some(&cookie)).await?;
        let status = me_response.status();
        let me = body_json(me_response).await?;
        sqlx::query("DELETE FROM users WHERE email= $1").bind(&email).execute(&pool).await?;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(me["displayed_nickname"], "Ada");
        assert!(me.get("name").is_none() && me.get("surname").is_none());
        assert_eq!(me["email"], email);
        assert_eq!(me["login_displayed"], mixed_login);
        assert!(me["id"].as_i64().unwrap_or(0) > 0);
        Ok(())
    }

    // Deleting a user must cascade to its sessions (FK ON DELETE CASCADE).
    #[tokio::test]
    async fn deleting_user_cascades_to_sessions() -> TestResult {
        let pool = connect().await?;
        let random = random_id();
        let email = format!("test_{random}@example.com").to_lowercase();
        let login = format!("test_{random}").to_lowercase();
        register_request(&pool, "Test", &login, &email, "a-long-test-password").await?;
        let cookie = login_cookie(&pool, &email, "a-long-test-password").await?;
        let before = get_with_cookie(&pool, "/api/me", Some(&cookie)).await?.status();
        sqlx::query("DELETE FROM users WHERE email= $1").bind(&email).execute(&pool).await?;
        let after = get_with_cookie(&pool, "/api/me", Some(&cookie)).await?.status();
        assert_eq!(before, StatusCode::OK);
        assert_eq!(after, StatusCode::UNAUTHORIZED);
        Ok(())
    }

    // --- Rate limiting and lockout ------------------------------------------

    // The limiter trusts the value Caddy appended, never a client-supplied one.
    #[test]
    fn client_ip_uses_the_last_forwarded_entry() {
        let mut headers = HeaderMap::new();
        assert_eq!(client_ip(&headers), "unknown");
        headers.insert("x-forwarded-for", "6.6.6.6, 203.0.113.7".parse().unwrap());
        assert_eq!(client_ip(&headers), "203.0.113.7");
        headers.insert("x-real-ip", "198.51.100.2".parse().unwrap());
        assert_eq!(client_ip(&headers), "198.51.100.2");
    }

    #[test]
    fn lockout_backoff_doubles_then_caps() {
        assert_eq!(lockout_seconds(10, 10, 900, 86400), 900);
        assert_eq!(lockout_seconds(11, 10, 900, 86400), 1800);
        assert_eq!(lockout_seconds(12, 10, 900, 86400), 3600);
        assert_eq!(lockout_seconds(40, 10, 900, 86400), 86400);
    }

    #[tokio::test]
    async fn login_is_rate_limited_per_ip() -> TestResult {
        let pool = connect().await?;
        let ip = random_ip();
        prune_rate_limits(&pool).await?;
        clear_rate_limits(&pool, &ip).await?;
        let mut response = None;
        for _ in 0..(login_ip_limit() + 1) {
            response = Some(
                send_from(
                    &pool,
                    "POST",
                    "/api/login",
                    None,
                    Some(
                        serde_json::json!({
                            "email": "nobody@example.com",
                            "password": "a-long-test-password",
                        })
                    ),
                    Some(&ip)
                ).await?
            );
        }
        let response = response.expect("at least one request");
        clear_rate_limits(&pool, &ip).await?;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(response.headers().contains_key(axum::http::header::RETRY_AFTER));
        Ok(())
    }

    #[tokio::test]
    async fn register_is_rate_limited_per_ip() -> TestResult {
        let pool = connect().await?;
        let ip = random_ip();
        prune_rate_limits(&pool).await?;
        clear_rate_limits(&pool, &ip).await?;
        let mut response = None;
        for _ in 0..(register_ip_limit() + 1) {
            response = Some(
                send_from(
                    &pool,
                    "POST",
                    "/api/register",
                    None,
                    // Invalid email, so no user row is ever created.
                    Some(
                        serde_json::json!({
                            "displayed_nickname": "Test",
                            "login": "tester",
                            "email": "not-an-email",
                            "password": "a-long-test-password",
                        })
                    ),
                    Some(&ip)
                ).await?
            );
        }
        let response = response.expect("at least one request");
        clear_rate_limits(&pool, &ip).await?;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        Ok(())
    }

    #[tokio::test]
    async fn rate_limit_does_not_affect_other_ips() -> TestResult {
        let pool = connect().await?;
        let blocked = random_ip();
        let other = random_ip();
        prune_rate_limits(&pool).await?;
        clear_rate_limits(&pool, &blocked).await?;
        clear_rate_limits(&pool, &other).await?;
        for _ in 0..=login_ip_limit() {
            login_from(&pool, "nobody@example.com", "a-long-test-password", &blocked).await?;
        }
        let from_other = login_from(
            &pool,
            "nobody@example.com",
            "a-long-test-password",
            &other
        ).await?;
        let from_blocked = login_from(
            &pool,
            "nobody@example.com",
            "a-long-test-password",
            &blocked
        ).await?;
        clear_rate_limits(&pool, &blocked).await?;
        clear_rate_limits(&pool, &other).await?;
        assert_eq!(from_other, StatusCode::UNAUTHORIZED);
        assert_eq!(from_blocked, StatusCode::TOO_MANY_REQUESTS);
        Ok(())
    }

    #[tokio::test]
    async fn account_locks_after_repeated_failures() -> TestResult {
        let pool = connect().await?;
        let random = random_id();
        let email = format!("test_{random}@example.com").to_lowercase();
        let login = format!("test_{random}").to_lowercase();
        let registered = register_request(&pool, "Test",
            &login,
            &email,
            "a-long-test-password"
        ).await?;
        let mut failures = Vec::new();
        let threshold = lockout_threshold();
        for _ in 0..threshold {
            failures.push(
                login_from(&pool, &email, "the-wrong-password", &random_ip()).await?
            );
        }
        // The right password must now look exactly like a wrong one.
        let locked_out = login_from(&pool, &email, "a-long-test-password", &random_ip()).await?;
        let locked: bool = sqlx
            ::query_scalar("SELECT locked_until > now() FROM login_failures WHERE email = $1")
            .bind(&email)
            .fetch_one(&pool).await?;
        sqlx::query("DELETE FROM users WHERE email= $1").bind(&email).execute(&pool).await?;
        assert_eq!(registered, StatusCode::CREATED);
        assert!(
            failures.iter().all(|status| *status == StatusCode::UNAUTHORIZED),
            "every failure should be an identical 401: {failures:?}"
        );
        assert_eq!(locked_out, StatusCode::UNAUTHORIZED);
        assert!(locked, "the account should be locked after {threshold} failures");
        Ok(())
    }

    #[tokio::test]
    async fn lockout_expires() -> TestResult {
        let pool = connect().await?;
        let random = random_id();
        let email = format!("test_{random}@example.com").to_lowercase();
        let login = format!("test_{random}").to_lowercase();
        register_request(&pool, "Test", &login, &email, "a-long-test-password").await?;
        for _ in 0..lockout_threshold() {
            login_from(&pool, &email, "the-wrong-password", &random_ip()).await?;
        }
        let locked = login_from(&pool, &email, "a-long-test-password", &random_ip()).await?;
        sqlx
            ::query(
                "UPDATE login_failures SET locked_until = now() - interval '1 second' WHERE email = $1"
            )
            .bind(&email)
            .execute(&pool).await?;
        let after_expiry = login_from(&pool, &email, "a-long-test-password", &random_ip()).await?;
        sqlx::query("DELETE FROM users WHERE email= $1").bind(&email).execute(&pool).await?;
        assert_eq!(locked, StatusCode::UNAUTHORIZED);
        assert_eq!(after_expiry, StatusCode::OK);
        Ok(())
    }

    #[tokio::test]
    async fn expired_lockout_escalates_after_the_failure_window() -> TestResult {
        let pool = connect().await?;
        let (email, _) = fresh_user(&pool).await?;
        let threshold = lockout_threshold();
        // Model a first lockout whose observation window and lock both expired.
        sqlx::query(
            "INSERT INTO login_failures (email, failed_count, first_failed_at, locked_until)
             VALUES ($1, $2, now() - make_interval(secs => $3::double precision) - interval '1 second', now() - interval '1 second')"
        )
        .bind(&email).bind(threshold as i32).bind(lockout_window_seconds())
        .execute(&pool).await?;
        let failed = login_request(&pool, &email, "the-wrong-password").await?;
        let row = sqlx::query(
            "SELECT failed_count, extract(epoch from (locked_until - now()))::bigint AS remaining
             FROM login_failures WHERE email = $1"
        ).bind(&email).fetch_one(&pool).await?;
        let count: i32 = row.try_get("failed_count")?;
        let remaining: i64 = row.try_get("remaining")?;
        sqlx::query("UPDATE login_failures SET locked_until = now() - interval '1 second' WHERE email = $1")
            .bind(&email).execute(&pool).await?;
        let success = login_request(&pool, &email, "a-long-test-password").await?;
        let cleared: i64 = sqlx::query_scalar("SELECT count(*) FROM login_failures WHERE email = $1")
            .bind(&email).fetch_one(&pool).await?;
        delete_user(&pool, &email).await?;
        assert_eq!(failed, StatusCode::UNAUTHORIZED);
        assert_eq!(count as i64, threshold + 1);
        let expected = lockout_seconds(threshold + 1, threshold, lockout_base_seconds(), lockout_max_seconds());
        assert!((expected - 5..=expected).contains(&remaining), "remaining: {remaining}");
        assert_eq!(success, StatusCode::OK);
        assert_eq!(cleared, 0);
        Ok(())
    }

    #[tokio::test]
    async fn failures_before_first_lockout_reset_after_window() -> TestResult {
        let pool = connect().await?;
        let (email, _) = fresh_user(&pool).await?;
        sqlx::query(
            "INSERT INTO login_failures (email, failed_count, first_failed_at)
             VALUES ($1, $2, now() - make_interval(secs => $3::double precision) - interval '1 second')"
        ).bind(&email).bind((lockout_threshold() - 1) as i32).bind(lockout_window_seconds())
            .execute(&pool).await?;
        record_login_failure(&pool, &email).await?;
        let count: i32 = sqlx::query_scalar("SELECT failed_count FROM login_failures WHERE email = $1")
            .bind(&email).fetch_one(&pool).await?;
        delete_user(&pool, &email).await?;
        assert_eq!(count, 1);
        Ok(())
    }

    #[tokio::test]
    async fn successful_login_clears_failures() -> TestResult {
        let pool = connect().await?;
        let random = random_id();
        let email = format!("test_{random}@example.com").to_lowercase();
        let login = format!("test_{random}").to_lowercase();
        register_request(&pool, "Test", &login, &email, "a-long-test-password").await?;
        for _ in 0..(lockout_threshold() - 1) {
            login_from(&pool, &email, "the-wrong-password", &random_ip()).await?;
        }
        let success = login_from(&pool, &email, "a-long-test-password", &random_ip()).await?;
        let remaining: i64 = sqlx
            ::query_scalar("SELECT count(*) FROM login_failures WHERE email = $1")
            .bind(&email)
            .fetch_one(&pool).await?;
        sqlx::query("DELETE FROM users WHERE email= $1").bind(&email).execute(&pool).await?;
        assert_eq!(success, StatusCode::OK);
        assert_eq!(remaining, 0);
        Ok(())
    }

    // Failures for unknown emails must not be recorded, or an attacker could grow
    // the table without bound.
    #[tokio::test]
    async fn unknown_email_is_not_tracked() -> TestResult {
        let pool = connect().await?;
        let random = random_id();
        let email = format!("missing_{random}@example.com").to_lowercase();
        let status = login_from(&pool, &email, "a-long-test-password", &random_ip()).await?;
        let tracked: i64 = sqlx
            ::query_scalar("SELECT count(*) FROM login_failures WHERE email = $1")
            .bind(&email)
            .fetch_one(&pool).await?;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(tracked, 0);
        Ok(())
    }

    // --- Account linking ----------------------------------------------------

    #[test]
    fn link_code_shape_is_typable() {
        for _ in 0..200 {
            let code = new_link_code().expect("a code");
            assert_eq!(code.len(), LINK_CODE_LENGTH);
            assert!(
                code.bytes().all(|byte| LINK_CODE_ALPHABET.contains(&byte)),
                "unexpected character in {code}"
            );
        }
    }

    #[test]
    fn uuid_and_username_validation() {
        assert!(is_uuid(&test_uuid("abc")));
        assert!(!is_uuid("not-a-uuid"));
        assert!(!is_uuid("abcdefabcdefabcdefabcdefabcdefabcd"));
        assert!(is_minecraft_username("Notch"));
        assert!(is_minecraft_username("a_b_1"));
        assert!(!is_minecraft_username("ab"));
        assert!(!is_minecraft_username("thisnameiswaytoolong"));
        assert!(!is_minecraft_username("bad name"));
    }

    #[test]
    fn constant_time_eq_matches_normal_equality() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }

    #[tokio::test]
    async fn link_endpoints_require_a_session() -> TestResult {
        let pool = connect().await?;
        let start = send(&pool, "POST", "/api/link/start", None, None).await?.status();
        let list = get_with_cookie(&pool, "/api/link", None).await?.status();
        let unlink = send(
            &pool,
            "DELETE",
            &format!("/api/link/{}", test_uuid("x")),
            None,
            None
        ).await?.status();
        assert_eq!(start, StatusCode::UNAUTHORIZED);
        assert_eq!(list, StatusCode::UNAUTHORIZED);
        assert_eq!(unlink, StatusCode::UNAUTHORIZED);
        Ok(())
    }

    #[tokio::test]
    async fn link_start_returns_a_short_lived_code() -> TestResult {
        let pool = connect().await?;
        let (email, cookie) = fresh_user(&pool).await?;
        let response = send(&pool, "POST", "/api/link/start", Some(&cookie), None).await?;
        let status = response.status();
        let body = body_json(response).await?;
        delete_user(&pool, &email).await?;
        assert_eq!(status, StatusCode::OK);
        let code = body["code"].as_str().unwrap_or_default();
        assert_eq!(code.len(), LINK_CODE_LENGTH);
        assert!(code.bytes().all(|byte| LINK_CODE_ALPHABET.contains(&byte)));
        let expires_in = body["expires_in"].as_i64().unwrap_or_default();
        assert!(expires_in > 0 && expires_in <= link_code_ttl_seconds());
        Ok(())
    }

    #[tokio::test]
    async fn link_claim_requires_the_service_token() -> TestResult {
        let pool = connect().await?;
        let (email, cookie) = fresh_user(&pool).await?;
        let code = start_code(&pool, &cookie).await?;
        let uuid = test_uuid(&email);
        let body = serde_json::json!({ "code": code, "uuid": uuid, "username": "Notch" });
        let missing = post_internal(
            &pool,
            "/internal/link/claim",
            None,
            body.clone(),
            &random_ip()
        ).await?.status();
        let wrong = post_internal(
            &pool,
            "/internal/link/claim",
            Some("not-the-token"),
            body,
            &random_ip()
        ).await?.status();
        let correct = claim(&pool, &code, &uuid, "Notch").await?;
        delete_user(&pool, &email).await?;
        assert_eq!(missing, StatusCode::UNAUTHORIZED);
        assert_eq!(wrong, StatusCode::UNAUTHORIZED);
        assert_eq!(correct, StatusCode::OK);
        Ok(())
    }

    #[tokio::test]
    async fn link_claim_links_the_account() -> TestResult {
        let pool = connect().await?;
        let (email, cookie) = fresh_user(&pool).await?;
        let code = start_code(&pool, &cookie).await?;
        let uuid = test_uuid(&email);
        let claimed = claim(&pool, &code, &uuid, "Notch").await?;
        let list_response = get_with_cookie(&pool, "/api/link", Some(&cookie)).await?;
        let list_status = list_response.status();
        let body = body_json(list_response).await?;
        delete_user(&pool, &email).await?;
        assert_eq!(claimed, StatusCode::OK);
        assert_eq!(list_status, StatusCode::OK);
        let accounts = body["accounts"].as_array().cloned().unwrap_or_default();
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0]["uuid"], uuid);
        assert_eq!(accounts[0]["username"], "Notch");
        assert!(accounts[0]["linked_at"].as_str().is_some());
        Ok(())
    }

    #[tokio::test]
    async fn link_claim_is_single_use() -> TestResult {
        let pool = connect().await?;
        let (email, cookie) = fresh_user(&pool).await?;
        let code = start_code(&pool, &cookie).await?;
        let first = claim(&pool, &code, &test_uuid(&email), "Notch").await?;
        let second = claim(&pool, &code, &test_uuid("other"), "Other").await?;
        delete_user(&pool, &email).await?;
        assert_eq!(first, StatusCode::OK);
        assert_eq!(second, StatusCode::NOT_FOUND);
        Ok(())
    }

    #[tokio::test]
    async fn link_claim_rejects_unknown_expired_and_malformed() -> TestResult {
        let pool = connect().await?;
        let (email, cookie) = fresh_user(&pool).await?;
        let unknown_code = test_uuid("nope")[..8].to_uppercase();
        let unknown = claim(&pool, &unknown_code, &test_uuid(&email), "Notch").await?;
        let code = start_code(&pool, &cookie).await?;
        sqlx
            ::query(
                "UPDATE link_codes SET expires_at = now() - interval '1 second' WHERE user_id = (SELECT id FROM users WHERE email = $1)"
            )
            .bind(&email)
            .execute(&pool).await?;
        let expired = claim(&pool, &code, &test_uuid(&email), "Notch").await?;
        let code = start_code(&pool, &cookie).await?;
        let bad_uuid = claim(&pool, &code, "not-a-uuid", "Notch").await?;
        let bad_username = claim(&pool, &code, &test_uuid(&email), "ab").await?;
        delete_user(&pool, &email).await?;
        assert_eq!(unknown, StatusCode::NOT_FOUND);
        assert_eq!(expired, StatusCode::NOT_FOUND);
        assert_eq!(bad_uuid, StatusCode::BAD_REQUEST);
        assert_eq!(bad_username, StatusCode::BAD_REQUEST);
        Ok(())
    }

    #[tokio::test]
    async fn concurrent_link_issuance_leaves_only_one_redeemable_code() -> TestResult {
        let pool = connect().await?;
        let (email, cookie) = fresh_user(&pool).await?;
        // Hold the user lock so all issuers arrive before any can insert a code.
        let mut gate = pool.begin().await?;
        sqlx::query("SELECT id FROM users WHERE email = $1 FOR UPDATE")
            .bind(&email).fetch_one(&mut *gate).await?;
        let starts = async {
            tokio::join!(
                send(&pool, "POST", "/api/link/start", Some(&cookie), None),
                send(&pool, "POST", "/api/link/start", Some(&cookie), None),
                send(&pool, "POST", "/api/link/start", Some(&cookie), None)
            )
        };
        let release = async {
            // Release only once the other transactions have reached the database.
            for _ in 0..100 {
                let waiting: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()
                     AND wait_event_type = 'Lock' AND query LIKE 'SELECT id FROM users WHERE id = $1 FOR UPDATE%'"
                ).fetch_one(&pool).await?;
                if waiting >= 3 { break; }
                // No timer feature is needed; this yields through the DB between checks.
            }
            gate.commit().await
        };
        let ((first, second, third), released) = tokio::join!(starts, release);
        released?;
        let mut statuses = Vec::new();
        let mut claims = Vec::new();
        for response in [first?, second?, third?] {
            statuses.push(response.status());
            if response.status() == StatusCode::OK {
                let body = body_json(response).await?;
                claims.push(claim(&pool, body["code"].as_str().unwrap_or_default(), &test_uuid(&email), "Notch").await?);
            }
        }
        delete_user(&pool, &email).await?;
        assert!(statuses.iter().all(|status| *status == StatusCode::OK));
        assert_eq!(claims.iter().filter(|status| **status == StatusCode::OK).count(), 1);
        assert_eq!(claims.iter().filter(|status| **status == StatusCode::NOT_FOUND).count(), 2);
        Ok(())
    }

    #[tokio::test]
    async fn link_start_invalidates_the_previous_code() -> TestResult {
        let pool = connect().await?;
        let (email, cookie) = fresh_user(&pool).await?;
        let first = start_code(&pool, &cookie).await?;
        let second = start_code(&pool, &cookie).await?;
        let old = claim(&pool, &first, &test_uuid(&email), "Notch").await?;
        let new = claim(&pool, &second, &test_uuid(&email), "Notch").await?;
        delete_user(&pool, &email).await?;
        assert_ne!(first, second);
        assert_eq!(old, StatusCode::NOT_FOUND);
        assert_eq!(new, StatusCode::OK);
        Ok(())
    }

    #[tokio::test]
    async fn link_claim_conflicts_on_an_already_linked_uuid() -> TestResult {
        let pool = connect().await?;
        let (email_a, cookie_a) = fresh_user(&pool).await?;
        let (email_b, cookie_b) = fresh_user(&pool).await?;
        let uuid = test_uuid(&email_a);
        let code_a = start_code(&pool, &cookie_a).await?;
        let first = claim(&pool, &code_a, &uuid, "Notch").await?;
        let code_b = start_code(&pool, &cookie_b).await?;
        let conflict = claim(&pool, &code_b, &uuid, "Notch").await?;
        // The failed claim rolled back, so the code is still usable.
        let retry = claim(&pool, &code_b, &test_uuid("other"), "Other").await?;
        delete_user(&pool, &email_a).await?;
        delete_user(&pool, &email_b).await?;
        assert_eq!(first, StatusCode::OK);
        assert_eq!(conflict, StatusCode::CONFLICT);
        assert_eq!(retry, StatusCode::OK);
        Ok(())
    }

    #[test]
    fn email_hints_hide_the_local_part_and_reject_chat_formatting() {
        assert_eq!(masked_email("daniel@example.com"), "d***@example.com");
        assert_eq!(masked_email("a@example.com"), "***@example.com");
        assert_eq!(masked_email("éclair@example.com"), "***@example.com");
        assert_eq!(masked_email("person@bad\n§domain"), "p***@hidden");
        assert_eq!(masked_email("invalid"), "***");
    }

    #[tokio::test]
    async fn link_email_requires_service_auth_and_valid_uuid() -> TestResult {
        let pool = connect().await?;
        let body = serde_json::json!({ "uuid": test_uuid(&random_id()) });
        let missing = post_internal(&pool, "/internal/link/email", None, body.clone(), &random_ip()).await?.status();
        let wrong = post_internal(&pool, "/internal/link/email", Some("wrong"), body, &random_ip()).await?.status();
        let malformed = post_internal(&pool, "/internal/link/email", Some(&test_service_token()),
            serde_json::json!({ "uuid": "not-a-uuid" }), &random_ip()).await?.status();
        assert_eq!(missing, StatusCode::UNAUTHORIZED);
        assert_eq!(wrong, StatusCode::UNAUTHORIZED);
        assert_eq!(malformed, StatusCode::BAD_REQUEST);
        Ok(())
    }

    #[tokio::test]
    async fn link_email_returns_only_masked_linked_email_and_disappears_on_unlink() -> TestResult {
        let pool = connect().await?;
        let (email, cookie) = fresh_user(&pool).await?;
        let uuid = test_uuid(&email);
        let code = start_code(&pool, &cookie).await?;
        let linked = claim(&pool, &code, &uuid, "EmailHint").await?;
        let response = post_internal(&pool, "/internal/link/email", Some(&test_service_token()),
            serde_json::json!({ "uuid": uuid.to_uppercase() }), &random_ip()).await?;
        let status = response.status();
        let no_store = response.headers().get(header::CACHE_CONTROL).cloned();
        let body = axum::body::to_bytes(response.into_body(), 1024).await?;
        let stranger = post_internal(&pool, "/internal/link/email", Some(&test_service_token()),
            serde_json::json!({ "uuid": test_uuid(&random_id()) }), &random_ip()).await?.status();
        sqlx::query("DELETE FROM minecraft_accounts WHERE uuid = $1").bind(&uuid).execute(&pool).await?;
        let unlinked = post_internal(&pool, "/internal/link/email", Some(&test_service_token()),
            serde_json::json!({ "uuid": uuid }), &random_ip()).await?.status();
        delete_user(&pool, &email).await?;
        assert_eq!(linked, StatusCode::OK);
        assert_eq!(status, StatusCode::OK);
        assert_eq!(no_store.and_then(|value| value.to_str().ok().map(str::to_owned)).as_deref(), Some("no-store"));
        assert_eq!(body.as_ref(), b"t***@example.com");
        assert_eq!(stranger, StatusCode::NOT_FOUND);
        assert_eq!(unlinked, StatusCode::NOT_FOUND);
        Ok(())
    }

    // The in-game plugin asks this right after a player authenticates, so the answer
    // has to be one bit — linked or not — and never which account is behind it.

    #[tokio::test]
    async fn security_endpoints_require_a_session() -> TestResult {
        let pool = connect().await?;
        for (method, path, body) in [
            ("GET", "/api/security", None),
            ("POST", "/api/security/password", Some(serde_json::json!({"current_password":"x","new_password":"a-new-long-password"}))),
            ("POST", "/api/security/email", Some(serde_json::json!({"current_password":"x","new_email":"new@example.com"}))),
        ] {
            assert_eq!(send(&pool, method, path, None, body).await?.status(), StatusCode::UNAUTHORIZED);
        }
        Ok(())
    }

    #[tokio::test]
    async fn password_change_checks_password_and_revokes_all_credentials() -> TestResult {
        let pool = connect().await?;
        let (email, cookie) = fresh_user(&pool).await?;
        let second_cookie = login_cookie(&pool, &email, "a-long-test-password").await?;
        let code = start_code(&pool, &cookie).await?;
        let wrong = send(&pool, "POST", "/api/security/password", Some(&cookie),
            Some(serde_json::json!({"current_password":"wrong","new_password":"a-new-long-password"}))).await?.status();
        let short = send(&pool, "POST", "/api/security/password", Some(&cookie),
            Some(serde_json::json!({"current_password":"a-long-test-password","new_password":"short"}))).await?.status();
        let unchanged = get_with_cookie(&pool, "/api/me", Some(&cookie)).await?.status();
        let changed = send(&pool, "POST", "/api/security/password", Some(&cookie),
            Some(serde_json::json!({"current_password":"a-long-test-password","new_password":"a-new-long-password"}))).await?;
        let changed_status = changed.status();
        let cleared = changed.headers().get(header::SET_COOKIE).and_then(|v| v.to_str().ok()).unwrap_or("").contains("Max-Age=0");
        let first_revoked = get_with_cookie(&pool, "/api/me", Some(&cookie)).await?.status();
        let second_revoked = get_with_cookie(&pool, "/api/me", Some(&second_cookie)).await?.status();
        let old_login = login_request(&pool, &email, "a-long-test-password").await?;
        let new_login = login_request(&pool, &email, "a-new-long-password").await?;
        let old_code = claim(&pool, &code, &test_uuid(&email), "SecurityTest").await?;
        delete_user(&pool, &email).await?;
        assert_eq!(wrong, StatusCode::FORBIDDEN);
        assert_eq!(short, StatusCode::BAD_REQUEST);
        assert_eq!(unchanged, StatusCode::OK);
        assert_eq!(changed_status, StatusCode::NO_CONTENT);
        assert!(cleared);
        assert_eq!(first_revoked, StatusCode::UNAUTHORIZED);
        assert_eq!(second_revoked, StatusCode::UNAUTHORIZED);
        assert_eq!(old_login, StatusCode::UNAUTHORIZED);
        assert_eq!(new_login, StatusCode::OK);
        assert_eq!(old_code, StatusCode::NOT_FOUND);
        Ok(())
    }

    #[tokio::test]
    async fn email_change_is_pending_until_single_use_confirmation() -> TestResult {
        let pool = connect().await?;
        let (email, cookie) = fresh_user(&pool).await?;
        let target = format!("new_{}@example.com", random_id()).to_lowercase();
        let wrong = send(&pool, "POST", "/api/security/email", Some(&cookie),
            Some(serde_json::json!({"current_password":"wrong","new_email":target}))).await?.status();
        let requested = send(&pool, "POST", "/api/security/email", Some(&cookie),
            Some(serde_json::json!({"current_password":"a-long-test-password","new_email":target.to_uppercase()}))).await?.status();
        let profile = body_json(get_with_cookie(&pool, "/api/me", Some(&cookie)).await?).await?;
        let row = sqlx::query("SELECT token_hash, target_email, user_id FROM account_email_tokens
            WHERE user_id = (SELECT id FROM users WHERE email = $1)")
            .bind(&email).fetch_one(&pool).await?;
        let stored_hash: String = row.try_get("token_hash")?;
        let stored_target: String = row.try_get("target_email")?;
        let user_id: i64 = row.try_get("user_id")?;
        let token = new_session_token().map_err(|_| "randomness failed")?;
        // Tokens are never returned by the API. Install a known test token to
        // exercise confirmation independently of the external mailbox client.
        sqlx::query("UPDATE account_email_tokens SET token_hash = $1 WHERE user_id = $2")
            .bind(hash_token(&token)).bind(user_id).execute(&pool).await?;
        let confirmed = send(&pool, "POST", "/api/security/email/confirm", None,
            Some(serde_json::json!({"token":token}))).await?.status();
        let reused = send(&pool, "POST", "/api/security/email/confirm", None,
            Some(serde_json::json!({"token":token}))).await?.status();
        let revoked = get_with_cookie(&pool, "/api/me", Some(&cookie)).await?.status();
        let verified: bool = sqlx::query_scalar("SELECT email_verified_at IS NOT NULL FROM users WHERE id = $1")
            .bind(user_id).fetch_one(&pool).await?;
        let new_login = login_request(&pool, &target, "a-long-test-password").await?;
        delete_user(&pool, &email).await?;
        delete_user(&pool, &target).await?;
        assert_eq!(wrong, StatusCode::FORBIDDEN);
        assert_eq!(requested, StatusCode::ACCEPTED);
        assert_eq!(profile["email"], email);
        assert_eq!(stored_hash.len(), 64);
        assert_eq!(stored_target, target);
        assert_eq!(confirmed, StatusCode::NO_CONTENT);
        assert_eq!(reused, StatusCode::BAD_REQUEST);
        assert_eq!(revoked, StatusCode::UNAUTHORIZED);
        assert!(verified);
        assert_eq!(new_login, StatusCode::OK);
        Ok(())
    }

    #[tokio::test]
    async fn expired_email_token_cannot_change_email() -> TestResult {
        let pool = connect().await?;
        let (email, cookie) = fresh_user(&pool).await?;
        let token = new_session_token().map_err(|_| "randomness failed")?;
        sqlx::query("INSERT INTO account_email_tokens (user_id, token_hash, current_email, target_email, expires_at)
            SELECT id, $2, email, 'expired@example.com', now() - interval '1 second' FROM users WHERE email = $1")
            .bind(&email).bind(hash_token(&token)).execute(&pool).await?;
        let expired = send(&pool, "POST", "/api/security/email/confirm", None,
            Some(serde_json::json!({"token":token}))).await?.status();
        let profile = body_json(get_with_cookie(&pool, "/api/me", Some(&cookie)).await?).await?;
        delete_user(&pool, &email).await?;
        assert_eq!(expired, StatusCode::BAD_REQUEST);
        assert_eq!(profile["email"], email);
        Ok(())
    }

    async fn link_status_of(
        pool: &sqlx::PgPool,
        uuid: &str
    ) -> Result<StatusCode, Box<dyn std::error::Error>> {
        let response = post_internal(
            pool,
            "/internal/link/status",
            Some(&test_service_token()),
            serde_json::json!({ "uuid": uuid }),
            &random_ip()
        ).await?;
        Ok(response.status())
    }

    #[tokio::test]
    async fn link_status_requires_the_service_token() -> TestResult {
        let pool = connect().await?;
        let uuid = test_uuid("status-token");
        let body = serde_json::json!({ "uuid": uuid });
        let missing = post_internal(
            &pool,
            "/internal/link/status",
            None,
            body.clone(),
            &random_ip()
        ).await?.status();
        let wrong = post_internal(
            &pool,
            "/internal/link/status",
            Some("not-the-token"),
            body,
            &random_ip()
        ).await?.status();
        let correct = link_status_of(&pool, &uuid).await?;
        assert_eq!(missing, StatusCode::UNAUTHORIZED);
        assert_eq!(wrong, StatusCode::UNAUTHORIZED);
        assert_eq!(correct, StatusCode::NOT_FOUND);
        Ok(())
    }

    #[tokio::test]
    async fn link_status_follows_the_link() -> TestResult {
        let pool = connect().await?;
        let (email, cookie) = fresh_user(&pool).await?;
        let uuid = test_uuid(&email);
        let before = link_status_of(&pool, &uuid).await?;
        let code = start_code(&pool, &cookie).await?;
        claim(&pool, &code, &uuid, "Notch").await?;
        let after = link_status_of(&pool, &uuid).await?;
        // A UUID nobody linked stays unlinked, so the answer really is about the UUID
        // and not merely about the request having succeeded.
        let stranger = link_status_of(&pool, &test_uuid("stranger")).await?;
        delete_user(&pool, &email).await?;
        assert_eq!(before, StatusCode::NOT_FOUND);
        assert_eq!(after, StatusCode::OK);
        assert_eq!(stranger, StatusCode::NOT_FOUND);
        Ok(())
    }

    #[tokio::test]
    async fn link_status_rejects_a_malformed_uuid() -> TestResult {
        let pool = connect().await?;
        let response = post_internal(
            &pool,
            "/internal/link/status",
            Some(&test_service_token()),
            serde_json::json!({ "uuid": "not-a-uuid" }),
            &random_ip()
        ).await?;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        Ok(())
    }

    // Building the router is where overlapping routes panic, and this touches no
    // database, so a conflict in the catch-all routes fails fast rather than in the
    // middle of the suite. It also pins the behaviour those routes exist for: a wrong
    // API path must not fall through to the SPA shell.
    #[tokio::test]
    async fn unmatched_api_paths_are_404() -> TestResult {
        let pool = sqlx::PgPool::connect_lazy("postgresql://postgres@127.0.0.1/none")?;
        let router = app(pool);
        let api = router
            .clone()
            .oneshot(Request::builder().uri("/api/nope").body(Body::empty())?).await?
            .status();
        let internal = router
            .oneshot(Request::builder().uri("/internal/nope").body(Body::empty())?).await?
            .status();
        assert_eq!(api, StatusCode::NOT_FOUND);
        assert_eq!(internal, StatusCode::NOT_FOUND);
        Ok(())
    }

    // The shell is only served to paths that name a route. This is the one piece of
    // that decision worth pinning: a missing asset has to stay a 404, or a stale shell
    // gets HTML with a 200 where the module loader expected JavaScript. The rest of
    // the fallback needs a built `frontend/dist`, which the test container does not
    // have, so it is covered by hand against the running stack instead.
    #[test]
    fn only_extensionless_paths_ask_for_the_shell() {
        assert!(!asks_for_a_file("/"));
        assert!(!asks_for_a_file("/cabinet"));
        assert!(!asks_for_a_file("/cabinet/"));
        assert!(!asks_for_a_file("/some/deep/route"));
        assert!(asks_for_a_file("/assets/index-DMpDOvKb.js"));
        assert!(asks_for_a_file("/favicon.svg"));
        assert!(asks_for_a_file("/cabinet.json"));
    }

    #[tokio::test]
    async fn unlink_removes_the_account() -> TestResult {
        let pool = connect().await?;
        let (email, cookie) = fresh_user(&pool).await?;
        let code = start_code(&pool, &cookie).await?;
        let uuid = test_uuid(&email);
        claim(&pool, &code, &uuid, "Notch").await?;
        let deleted = send(
            &pool,
            "DELETE",
            &format!("/api/link/{uuid}"),
            Some(&cookie),
            None
        ).await?.status();
        let list_response = get_with_cookie(&pool, "/api/link", Some(&cookie)).await?;
        let body = body_json(list_response).await?;
        delete_user(&pool, &email).await?;
        assert_eq!(deleted, StatusCode::NO_CONTENT);
        assert_eq!(body["accounts"].as_array().map(Vec::len), Some(0));
        Ok(())
    }

    #[tokio::test]
    async fn unlink_cannot_touch_another_users_account() -> TestResult {
        let pool = connect().await?;
        let (email_a, cookie_a) = fresh_user(&pool).await?;
        let (email_b, cookie_b) = fresh_user(&pool).await?;
        let uuid = test_uuid(&email_a);
        let code = start_code(&pool, &cookie_a).await?;
        claim(&pool, &code, &uuid, "Notch").await?;
        let deleted = send(
            &pool,
            "DELETE",
            &format!("/api/link/{uuid}"),
            Some(&cookie_b),
            None
        ).await?.status();
        let list_response = get_with_cookie(&pool, "/api/link", Some(&cookie_a)).await?;
        let body = body_json(list_response).await?;
        delete_user(&pool, &email_a).await?;
        delete_user(&pool, &email_b).await?;
        assert_eq!(deleted, StatusCode::NOT_FOUND);
        assert_eq!(body["accounts"].as_array().map(Vec::len), Some(1));
        Ok(())
    }

    #[tokio::test]
    async fn link_claim_is_rate_limited_per_ip() -> TestResult {
        let pool = connect().await?;
        let ip = random_ip();
        prune_rate_limits(&pool).await?;
        clear_rate_limits(&pool, &ip).await?;
        let mut response = None;
        for _ in 0..(link_claim_ip_limit() + 1) {
            response = Some(
                post_internal(
                    &pool,
                    "/internal/link/claim",
                    Some(&test_service_token()),
                    serde_json::json!({
                        "code": "ZZZZZZZZ",
                        "uuid": test_uuid("rate"),
                        "username": "Notch",
                    }),
                    &ip
                ).await?
            );
        }
        let response = response.expect("at least one request");
        clear_rate_limits(&pool, &ip).await?;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        Ok(())
    }

    // --- Player statistics -----------------------------------------------------

    fn stats_player(
        uuid: &str,
        username: &str,
        play_seconds: i64,
        blocks_placed: i64,
        blocks_broken: i64
    ) -> serde_json::Value {
        serde_json::json!({
            "uuid": uuid,
            "username": username,
            "play_seconds": play_seconds,
            "blocks_placed": blocks_placed,
            "blocks_broken": blocks_broken,
        })
    }

    async fn report_stats(
        pool: &sqlx::PgPool,
        token: Option<&str>,
        players: Vec<serde_json::Value>
    ) -> Result<StatusCode, Box<dyn std::error::Error>> {
        Ok(post_internal(
            pool,
            "/internal/stats/report",
            token,
            serde_json::json!({ "players": players }),
            &random_ip()
        ).await?.status())
    }

    async fn stats_view(
        pool: &sqlx::PgPool,
        cookie: &str
    ) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
        let response = get_with_cookie(pool, "/api/stats", Some(cookie)).await?;
        let status = response.status();
        let body = body_json(response).await?;
        assert_eq!(status, StatusCode::OK, "GET /api/stats should answer 200");
        Ok(body)
    }

    // `delete_user` cannot reach this table: player_stats has no foreign key to
    // the user, on purpose, so tests remove their own rows by UUID.
    async fn delete_player_stats(
        pool: &sqlx::PgPool,
        uuid: &str
    ) -> Result<(), Box<dyn std::error::Error>> {
        sqlx::query("DELETE FROM player_stats WHERE uuid = $1")
            .bind(uuid)
            .execute(pool).await?;
        Ok(())
    }

    #[tokio::test]
    async fn stats_report_requires_the_service_token() -> TestResult {
        let pool = connect().await?;
        let uuid = test_uuid("stats-token");
        let player = stats_player(&uuid, "Notch", 60, 1, 1);
        let missing = report_stats(&pool, None, vec![player.clone()]).await?;
        let wrong = report_stats(&pool, Some("not-the-token"), vec![player.clone()]).await?;
        let correct = report_stats(&pool, Some(&test_service_token()), vec![player]).await?;
        delete_player_stats(&pool, &uuid).await?;
        assert_eq!(missing, StatusCode::UNAUTHORIZED);
        assert_eq!(wrong, StatusCode::UNAUTHORIZED);
        assert_eq!(correct, StatusCode::OK);
        Ok(())
    }

    #[tokio::test]
    async fn stats_report_adds_deltas_and_the_view_shows_them() -> TestResult {
        let pool = connect().await?;
        let (email, cookie) = fresh_user(&pool).await?;
        let uuid = test_uuid(&email);
        let code = start_code(&pool, &cookie).await?;
        claim(&pool, &code, &uuid, "Notch").await?;
        let first = report_stats(
            &pool,
            Some(&test_service_token()),
            vec![stats_player(&uuid, "Notch", 3600, 10, 5)]
        ).await?;
        let second = report_stats(
            &pool,
            Some(&test_service_token()),
            vec![stats_player(&uuid, "Notch", 1800, 2, 1)]
        ).await?;
        let body = stats_view(&pool, &cookie).await?;
        delete_user(&pool, &email).await?;
        delete_player_stats(&pool, &uuid).await?;
        assert_eq!(first, StatusCode::OK);
        assert_eq!(second, StatusCode::OK);
        let accounts = body["accounts"].as_array().cloned().unwrap_or_default();
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0]["uuid"], uuid);
        assert_eq!(accounts[0]["username"], "Notch");
        assert_eq!(accounts[0]["stats"]["play_seconds"], 5400);
        assert_eq!(accounts[0]["stats"]["blocks_placed"], 12);
        assert_eq!(accounts[0]["stats"]["blocks_broken"], 6);
        assert!(accounts[0]["stats"]["first_seen_at"].as_str().is_some());
        assert!(accounts[0]["stats"]["last_seen_at"].as_str().is_some());
        assert_eq!(body["summary"]["accounts"], 1);
        assert_eq!(body["summary"]["accounts_with_stats"], 1);
        assert_eq!(body["summary"]["play_seconds"], 5400);
        assert_eq!(body["summary"]["blocks_placed"], 12);
        assert_eq!(body["summary"]["blocks_broken"], 6);
        Ok(())
    }

    #[tokio::test]
    async fn stats_report_rejects_malformed_players_without_storing() -> TestResult {
        let pool = connect().await?;
        let (email, cookie) = fresh_user(&pool).await?;
        let uuid = test_uuid(&email);
        let code = start_code(&pool, &cookie).await?;
        claim(&pool, &code, &uuid, "Notch").await?;
        let service_token = test_service_token();
        let token: Option<&str> = Some(service_token.as_str());
        let bad_uuid = report_stats(
            &pool, token, vec![stats_player("not-a-uuid", "Notch", 1, 0, 0)]
        ).await?;
        let bad_username = report_stats(
            &pool, token, vec![stats_player(&uuid, "ab", 1, 0, 0)]
        ).await?;
        let negative = report_stats(
            &pool, token, vec![stats_player(&uuid, "Notch", -1, 0, 0)]
        ).await?;
        let oversized = report_stats(
            &pool, token, vec![stats_player(&uuid, "Notch", STATS_REPORT_MAX_COUNTER + 1, 0, 0)]
        ).await?;
        let empty = report_stats(&pool, token, vec![]).await?;
        let body = stats_view(&pool, &cookie).await?;
        delete_user(&pool, &email).await?;
        assert_eq!(bad_uuid, StatusCode::BAD_REQUEST);
        assert_eq!(bad_username, StatusCode::BAD_REQUEST);
        assert_eq!(negative, StatusCode::BAD_REQUEST);
        assert_eq!(oversized, StatusCode::BAD_REQUEST);
        assert_eq!(empty, StatusCode::BAD_REQUEST);
        let accounts = body["accounts"].as_array().cloned().unwrap_or_default();
        // Linked, but nothing was stored: the stats stay null.
        assert_eq!(accounts.len(), 1);
        assert!(accounts[0]["stats"].is_null());
        assert_eq!(body["summary"]["accounts"], 1);
        assert_eq!(body["summary"]["accounts_with_stats"], 0);
        assert_eq!(body["summary"]["play_seconds"], 0);
        Ok(())
    }

    #[tokio::test]
    async fn stats_summary_covers_all_linked_accounts() -> TestResult {
        let pool = connect().await?;
        let (email, cookie) = fresh_user(&pool).await?;
        let uuid_a = test_uuid(&format!("{email}-a"));
        let uuid_b = test_uuid(&format!("{email}-b"));
        let code = start_code(&pool, &cookie).await?;
        claim(&pool, &code, &uuid_a, "PlayerA").await?;
        let code = start_code(&pool, &cookie).await?;
        claim(&pool, &code, &uuid_b, "PlayerB").await?;
        // One batched report for both players, which is how the plugin sends it.
        let reported = report_stats(
            &pool,
            Some(&test_service_token()),
            vec![
                stats_player(&uuid_a, "PlayerA", 100, 1, 2),
                stats_player(&uuid_b, "PlayerB", 300, 5, 7),
            ]
        ).await?;
        let body = stats_view(&pool, &cookie).await?;
        delete_user(&pool, &email).await?;
        delete_player_stats(&pool, &uuid_a).await?;
        delete_player_stats(&pool, &uuid_b).await?;
        assert_eq!(reported, StatusCode::OK);
        let accounts = body["accounts"].as_array().cloned().unwrap_or_default();
        assert_eq!(accounts.len(), 2);
        let stats = body["summary"].clone();
        assert_eq!(stats["accounts"], 2);
        assert_eq!(stats["accounts_with_stats"], 2);
        assert_eq!(stats["play_seconds"], 400);
        assert_eq!(stats["blocks_placed"], 6);
        assert_eq!(stats["blocks_broken"], 9);
        Ok(())
    }

    #[tokio::test]
    async fn stats_of_unlinked_players_are_invisible() -> TestResult {
        let pool = connect().await?;
        let (email, cookie) = fresh_user(&pool).await?;
        let (email_b, cookie_b) = fresh_user(&pool).await?;
        let stranger = test_uuid(&format!("stats-stranger-{email}"));
        let reported = report_stats(
            &pool,
            Some(&test_service_token()),
            vec![stats_player(&stranger, "Stranger", 9999, 99, 99)]
        ).await?;
        // The user who has linked nothing sees nothing.
        let body = stats_view(&pool, &cookie).await?;
        // A user with their own linked account sees only their own player.
        let uuid_b = test_uuid(&email_b);
        let code = start_code(&pool, &cookie_b).await?;
        claim(&pool, &code, &uuid_b, "Other").await?;
        report_stats(
            &pool,
            Some(&test_service_token()),
            vec![stats_player(&uuid_b, "Other", 5, 0, 0)]
        ).await?;
        let body_b = stats_view(&pool, &cookie_b).await?;
        delete_user(&pool, &email).await?;
        delete_user(&pool, &email_b).await?;
        delete_player_stats(&pool, &stranger).await?;
        delete_player_stats(&pool, &uuid_b).await?;
        assert_eq!(reported, StatusCode::OK);
        assert!(body["accounts"].as_array().cloned().unwrap_or_default().is_empty());
        assert_eq!(body["summary"]["accounts"], 0);
        assert_eq!(body["summary"]["play_seconds"], 0);
        assert_eq!(body_b["summary"]["accounts"], 1);
        assert_eq!(body_b["summary"]["play_seconds"], 5);
        assert_eq!(body_b["accounts"][0]["uuid"], uuid_b);
        Ok(())
    }

    #[tokio::test]
    async fn stats_endpoint_requires_a_session() -> TestResult {
        let pool = connect().await?;
        let missing = get_with_cookie(&pool, "/api/stats", None).await?.status();
        let invalid = get_with_cookie(&pool, "/api/stats", Some("session=deadbeef")).await?.status();
        assert_eq!(missing, StatusCode::UNAUTHORIZED);
        assert_eq!(invalid, StatusCode::UNAUTHORIZED);
        Ok(())
    }

    #[tokio::test]
    async fn unlink_keeps_stats_and_relink_restores_them() -> TestResult {
        let pool = connect().await?;
        let (email, cookie) = fresh_user(&pool).await?;
        let uuid = test_uuid(&email);
        let code = start_code(&pool, &cookie).await?;
        claim(&pool, &code, &uuid, "Notch").await?;
        report_stats(
            &pool,
            Some(&test_service_token()),
            vec![stats_player(&uuid, "Notch", 600, 3, 3)]
        ).await?;
        let before = stats_view(&pool, &cookie).await?;
        let deleted = send(
            &pool,
            "DELETE",
            &format!("/api/link/{uuid}"),
            Some(&cookie),
            None
        ).await?.status();
        let after = stats_view(&pool, &cookie).await?;
        // Re-link the same in-game identity.
        let code = start_code(&pool, &cookie).await?;
        claim(&pool, &code, &uuid, "Notch").await?;
        let restored = stats_view(&pool, &cookie).await?;
        delete_user(&pool, &email).await?;
        delete_player_stats(&pool, &uuid).await?;
        assert_eq!(deleted, StatusCode::NO_CONTENT);
        assert_eq!(before["accounts"][0]["stats"]["play_seconds"], 600);
        assert!(after["accounts"].as_array().cloned().unwrap_or_default().is_empty());
        assert_eq!(restored["accounts"].as_array().map(Vec::len), Some(1));
        assert_eq!(restored["accounts"][0]["stats"]["play_seconds"], 600);
        Ok(())
    }
}
