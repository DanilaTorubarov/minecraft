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
    name: String,
    surname: String,
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
        .route("/api/link", get(list_links))
        .route("/api/link/start", post(start_link))
        .route("/api/link/{uuid}", delete(unlink_account))
        .route("/internal/link/claim", claim)
        .route("/internal/link/status", post(link_status))
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
    let row = sqlx
        ::query(
            "INSERT INTO login_failures (email, failed_count, first_failed_at)
             VALUES ($1, 1, now())
             ON CONFLICT (email) DO UPDATE SET
               failed_count = CASE WHEN login_failures.first_failed_at < now() - make_interval(secs => $2::double precision)
                                   THEN 1 ELSE login_failures.failed_count + 1 END,
               first_failed_at = CASE WHEN login_failures.first_failed_at < now() - make_interval(secs => $2::double precision)
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
    let missing_text = [&input.email, &input.name, &input.surname, &input.login]
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
            "INSERT INTO users (name,surname,login,login_displayed,email,password_hash) VALUES ($1,$2,$3,$4,$5,$6)"
        )
        .bind(&input.name)
        .bind(&input.surname)
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
    sqlx
        ::query(
            "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))"
        )
        .bind(user_id)
        .bind(hash_token(&token))
        .bind(SESSION_TTL_HOURS)
        .execute(&pool).await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
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
    name: String,
    surname: String,
    email: String,
    login_displayed: String,
}

async fn current_user(
    State(pool): State<sqlx::PgPool>,
    SessionUser { user_id }: SessionUser
) -> Result<Json<Me>, StatusCode> {
    let row = sqlx
        ::query("SELECT id, name, surname, email, login_displayed FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&pool).await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::UNAUTHORIZED)?;
    Ok(
        Json(Me {
            id: row.try_get("id").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
            name: row.try_get("name").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
            surname: row.try_get("surname").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
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
        name: &str,
        surname: &str,
        login: &str,
        email: &str,
        password: &str
    ) -> Result<StatusCode, Box<dyn std::error::Error>> {
        post_json(
            pool,
            "/api/register",
            serde_json::json!({
                "name": name,
                "surname": surname,
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
        register_request(pool, "Test", "User", &login, &email, "a-long-test-password").await?;
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
        let registered = register_request(
            &pool,
            "Test",
            "User@",
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
        let empty_name = register_request(
            &pool,
            "",
            "User",
            &login,
            &email,
            "a-long-test-password"
        ).await?;
        let empty_surname = register_request(
            &pool,
            "Test",
            "",
            &login,
            &email,
            "a-long-test-password"
        ).await?;
        let empty_login = register_request(
            &pool,
            "Test",
            "User",
            "",
            &email,
            "a-long-test-password"
        ).await?;
        let empty_email = register_request(
            &pool,
            "Test",
            "User",
            &login,
            "",
            "a-long-test-password"
        ).await?;
        let empty_password = register_request(&pool, "Test", "User", &login, &email, "").await?;
        sqlx::query("DELETE FROM users WHERE email= $1").bind(&email).execute(&pool).await?;
        assert_eq!(empty_name, StatusCode::BAD_REQUEST);
        assert_eq!(empty_surname, StatusCode::BAD_REQUEST);
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
        let space = register_request(
            &pool,
            "Test",
            "User",
            "Test Test",
            &email,
            "a-long-test-password"
        ).await?;
        let dot = register_request(
            &pool,
            "Test",
            "User",
            "Test.Test",
            &email,
            "a-long-test-password"
        ).await?;
        let comma = register_request(
            &pool,
            "Test",
            "User",
            "Test,Test",
            &email,
            "a-long-test-password"
        ).await?;
        let valid = register_request(
            &pool,
            "Test",
            "User",
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
        let result = register_request(
            &pool,
            "Test",
            "User",
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
        let fifteen = register_request(
            &pool,
            "Test",
            "User",
            &login,
            &email,
            "15fifteencharac"
        ).await?;
        let fourteen = register_request(
            &pool,
            "Test",
            "User",
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
        let first = register_request(
            &pool,
            "Test",
            "User",
            &first_login,
            &email,
            "a-long-test-password"
        ).await?;
        let second = register_request(
            &pool,
            "Test",
            "User",
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
        let first = register_request(
            &pool,
            "Test",
            "User",
            &login,
            &first_email,
            "a-long-test-password"
        ).await?;
        let second = register_request(
            &pool,
            "Test",
            "User",
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
        let first = register_request(
            &pool,
            "Test",
            "User",
            &first_login,
            &mixed_email,
            "a-long-test-password"
        ).await?;
        let second = register_request(
            &pool,
            "Test",
            "User",
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
        let registered = register_request(
            &pool,
            "Test",
            "User",
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
        let registered = register_request(
            &pool,
            "Test",
            "User",
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
        let registered = register_request(
            &pool,
            "Test",
            "User",
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
        register_request(&pool, "Test", "User", &login, &email, "a-long-test-password").await?;
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
        register_request(&pool, "Test", "User", &login, &email, "a-long-test-password").await?;
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
        let blank_name = register_request(
            &pool,
            "   ",
            "User",
            &login,
            &email,
            "a-long-test-password"
        ).await?;
        let blank_surname = register_request(
            &pool,
            "Test",
            "\t",
            &login,
            &email,
            "a-long-test-password"
        ).await?;
        let blank_login = register_request(
            &pool,
            "Test",
            "User",
            "   ",
            &email,
            "a-long-test-password"
        ).await?;
        sqlx::query("DELETE FROM users WHERE email= $1").bind(&email).execute(&pool).await?;
        assert_eq!(blank_name, StatusCode::BAD_REQUEST);
        assert_eq!(blank_surname, StatusCode::BAD_REQUEST);
        assert_eq!(blank_login, StatusCode::BAD_REQUEST);
        Ok(())
    }

    #[tokio::test]
    async fn register_non_ascii_login_is_rejected() -> TestResult {
        let pool = connect().await?;
        let random = random_id();
        let email = format!("test_{random}@example.com").to_lowercase();
        let result = register_request(
            &pool,
            "Test",
            "User",
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
                "name": "Test",
                "surname": "User",
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
        let registered = register_request(
            &pool,
            "Test",
            "User",
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
        register_request(&pool, "Test", "User", &login, &email, "a-long-test-password").await?;
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
        register_request(&pool, "Test", "User", &login, &email, "a-long-test-password").await?;
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
        register_request(&pool, "Test", "User", &login, &email, "a-long-test-password").await?;
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
        register_request(&pool, "Test", "User", &login, &email, "a-long-test-password").await?;
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
        register_request(
            &pool,
            "Ada",
            "Lovelace",
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
        assert_eq!(me["name"], "Ada");
        assert_eq!(me["surname"], "Lovelace");
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
        register_request(&pool, "Test", "User", &login, &email, "a-long-test-password").await?;
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
                            "name": "Test",
                            "surname": "User",
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
        let registered = register_request(
            &pool,
            "Test",
            "User",
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
        register_request(&pool, "Test", "User", &login, &email, "a-long-test-password").await?;
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
    async fn successful_login_clears_failures() -> TestResult {
        let pool = connect().await?;
        let random = random_id();
        let email = format!("test_{random}@example.com").to_lowercase();
        let login = format!("test_{random}").to_lowercase();
        register_request(&pool, "Test", "User", &login, &email, "a-long-test-password").await?;
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

    // The in-game plugin asks this right after a player authenticates, so the answer
    // has to be one bit — linked or not — and never which account is behind it.
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
}
