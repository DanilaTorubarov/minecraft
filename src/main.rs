use tokio::net::TcpListener;
use tower_http::services::ServeDir;
use axum::{
    Json, Router,
    extract::{ FromRequestParts, Path, Query, Request, State },
    http::{ HeaderMap, StatusCode, Uri, header, request::Parts },
    middleware::{ self, Next },
    response::{ IntoResponse, Response },
    routing::{ any, delete, get, post }
};
use argon2::{ Argon2, password_hash::{ PasswordHasher, PasswordVerifier, phc::PasswordHash } };
use sha2::{ Digest, Sha256 };
use sqlx::Row;

const SESSION_TTL_HOURS: i32 = 24;
const MAX_LINKED_ACCOUNTS: i64 = 4;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::dotenv().ok();
    let listener = TcpListener::bind("0.0.0.0:8080").await?;
    let pool = connect().await?;
    tokio::spawn(skin_signing_worker(pool.clone()));
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
    #[serde(alias = "email")]
    identifier: String,
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
        .route("/api/register/confirm", post(confirm_registration).layer(
            middleware::from_fn_with_state(pool.clone(), rate_limit_security_ip)))
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
        .route("/api/minigames/config", get(minigame_config))
        .route("/api/minigames/state", get(minigame_state))
        .route("/api/minigames/chest/spin", post(spin_lucky_chest))
        .route("/api/minigames/mines/start", post(start_mines))
        .route("/api/minigames/mines/reveal", post(reveal_mines))
        .route("/api/minigames/mines/cashout", post(cash_out_mines))
        .route("/api/players/{uuid}/skin", get(player_skin).post(upload_player_skin)
            .layer(axum::extract::DefaultBodyLimit::max(300 * 1024)))
        .route("/api/players/{uuid}/inventory", get(player_inventory))
        .route("/internal/skins/sync", post(sync_player_skins))
        .route("/internal/skins/report", post(report_player_skin))
        .route("/internal/inventory/report", post(report_inventory))
        .route("/api/players/{uuid}/inventory/marketplace", post(create_market_listing))
        .route("/api/marketplace", get(marketplace))
        .route("/api/marketplace/{id}/buy", post(buy_market_listing))
        .route("/api/marketplace/{id}/cancel", post(cancel_market_listing))
        .route("/internal/marketplace/sync", post(sync_market_tasks))
        .route("/internal/marketplace/report", post(complete_market_task).layer(axum::extract::DefaultBodyLimit::max(2 * 1024 * 1024)))
        .route("/internal/inventory/deletions", post(sync_inventory_deletions))
        .route("/internal/inventory/deletions/report", post(complete_inventory_deletion))
        .route("/internal/items/icons", post(report_item_icons)
            .layer(axum::extract::DefaultBodyLimit::max(700 * 1024)))
        .route("/internal/link/claim", claim)
        .route("/internal/link/status", post(link_status))
        .route("/internal/link/email", post(link_email))
        .route("/internal/stats/report", post(report_stats))
        .route("/internal/balance", post(balance_for_player))
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
) -> Result<impl IntoResponse, StatusCode> {
    let email = input.email.to_lowercase();
    let login = input.login.to_lowercase();
    let missing_text = [&input.email, &input.displayed_nickname, &input.login]
        .iter()
        .any(|value| value.trim().is_empty());
    if
        !login.chars().all(|ch| { ch.is_ascii_alphanumeric() || matches!(ch, '_' | '!' | '@') }) ||
        !email_address::EmailAddress::is_valid(&email) ||
        missing_text ||
        input.password.chars().count() < 6
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
    let challenge = new_session_token()?;
    // Bind the short code to an unguessable browser challenge. Neither the
    // challenge nor the code is stored in plaintext or written to logs.
    let code = registration_code()?;
    let mut tx = pool.begin().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    sqlx::query("DELETE FROM pending_registrations WHERE expires_at <= now()")
        .execute(&mut *tx).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let updated = sqlx::query("INSERT INTO pending_registrations
        (email, challenge_hash, code_hash, displayed_nickname, login, login_displayed, password_hash, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '15 minutes')
        ON CONFLICT (email) DO UPDATE SET challenge_hash = EXCLUDED.challenge_hash,
        code_hash = EXCLUDED.code_hash, displayed_nickname = EXCLUDED.displayed_nickname,
        login = EXCLUDED.login, login_displayed = EXCLUDED.login_displayed,
        password_hash = EXCLUDED.password_hash, created_at = now(),
        expires_at = EXCLUDED.expires_at, failed_attempts = 0
        WHERE pending_registrations.created_at <= now() - interval '60 seconds'")
        .bind(&email).bind(hash_token(&challenge)).bind(hash_token(&format!("{challenge}:{code}")))
        .bind(input.displayed_nickname.trim()).bind(&login).bind(&input.login).bind(password_hash)
        .execute(&mut *tx).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if updated.rows_affected() == 0 { return Err(StatusCode::TOO_MANY_REQUESTS); }
    // A persistent mailbox budget also applies across changing client IPs.
    if ip_limit_exceeded(&pool, "register_email", 5, 3600, &hash_token(&email)).await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?.is_some() {
        return Err(StatusCode::TOO_MANY_REQUESTS);
    }
    send_account_mail(&email, "Confirm your registration",
        format!("Your website registration code is:\n\n{code}\n\nEnter this six-digit code in the registration window. It expires in 15 minutes and works once. Only the newest code is valid. If you did not request this, ignore this email.")).await?;
    let expires_in: i64 = sqlx::query_scalar("SELECT greatest(0, floor(extract(epoch FROM expires_at - clock_timestamp())))::bigint FROM pending_registrations WHERE email = $1")
        .bind(&email).fetch_one(&mut *tx).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    tx.commit().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok((StatusCode::ACCEPTED, [(header::CACHE_CONTROL, "no-store")], Json(RegistrationChallenge {
        challenge, expires_in: expires_in.min(900) as u32, email_delivery: smtp_mode(),
    })))
}

#[derive(serde::Serialize)]
struct RegistrationChallenge {
    challenge: String,
    expires_in: u32,
    email_delivery: &'static str,
}

fn registration_code() -> Result<String, StatusCode> {
    loop {
        let mut bytes = [0u8; 4];
        getrandom::fill(&mut bytes).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let value = u32::from_le_bytes(bytes);
        // Rejection sampling keeps all six-digit codes equally likely.
        if value < 4_294_000_000 { return Ok(format!("{:06}", value % 1_000_000)); }
    }
}

#[derive(serde::Deserialize)]
struct RegistrationConfirmation { challenge: String, code: String }

async fn confirm_registration(
    State(pool): State<sqlx::PgPool>,
    Json(input): Json<RegistrationConfirmation>,
) -> Result<StatusCode, StatusCode> {
    if input.challenge.len() != 64 || !input.challenge.bytes().all(|b| b.is_ascii_hexdigit())
        || input.code.len() != 6 || !input.code.bytes().all(|b| b.is_ascii_digit()) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut tx = pool.begin().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let row = sqlx::query("SELECT email, code_hash, displayed_nickname, login, login_displayed, password_hash
        FROM pending_registrations WHERE challenge_hash = $1 AND expires_at > now()
        AND failed_attempts < 5 FOR UPDATE")
        .bind(hash_token(&input.challenge)).fetch_optional(&mut *tx).await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?.ok_or(StatusCode::BAD_REQUEST)?;
    let stored: String = row.try_get("code_hash").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let supplied = hash_token(&format!("{}:{}", input.challenge, input.code));
    if !constant_time_eq(stored.as_bytes(), supplied.as_bytes()) {
        sqlx::query("UPDATE pending_registrations SET failed_attempts = failed_attempts + 1 WHERE challenge_hash = $1")
            .bind(hash_token(&input.challenge)).execute(&mut *tx).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        tx.commit().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        return Err(StatusCode::BAD_REQUEST);
    }
    let email: String = row.try_get("email").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let login: String = row.try_get("login").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    // The early check improves feedback; the unique constraints arbitrate races.
    if sqlx::query("SELECT 1 FROM users WHERE email = $1 OR login = $2")
        .bind(&email).bind(&login).fetch_optional(&mut *tx).await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?.is_some() {
        return Err(StatusCode::CONFLICT);
    }
    sqlx::query("INSERT INTO users (displayed_nickname, login, login_displayed, email, password_hash, email_verified_at)
        VALUES ($1, $2, $3, $4, $5, now())")
        .bind(row.try_get::<String, _>("displayed_nickname").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?)
        .bind(&login)
        .bind(row.try_get::<String, _>("login_displayed").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?)
        .bind(&email)
        .bind(row.try_get::<String, _>("password_hash").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?)
        .execute(&mut *tx).await.map_err(|error| match error {
            sqlx::Error::Database(db) if db.is_unique_violation() => StatusCode::CONFLICT,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        })?;
    sqlx::query("DELETE FROM pending_registrations WHERE email = $1").bind(email)
        .execute(&mut *tx).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    tx.commit().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::CREATED)
}

async fn login_user(
    State(pool): State<sqlx::PgPool>,
    Json(input): Json<Login>
) -> Result<impl IntoResponse, StatusCode> {
    let identifier = input.identifier.trim().to_lowercase();
    // Email wins a cross-field collision; never try another account's password.
    let row = sqlx
        ::query("SELECT id, email, password_hash FROM users WHERE email = $1 OR login = $1 ORDER BY (email = $1) DESC LIMIT 1")
        .bind(&identifier)
        .fetch_optional(&pool).await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let Some(row) = row else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    // Both identifiers share the same canonical account lockout and failure log.
    let email: String = row.try_get("email").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if account_is_locked(&pool, &email).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)? {
        return Err(StatusCode::UNAUTHORIZED);
    }
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
    if input.new_password.chars().count() < 6 || input.new_password == input.current_password {
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
    let linked: i64 = sqlx::query_scalar("SELECT count(*) FROM minecraft_accounts WHERE user_id=$1")
        .bind(user_id).fetch_one(&mut *transaction).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if linked >= MAX_LINKED_ACCOUNTS { return Err(StatusCode::UNPROCESSABLE_ENTITY); }
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
    // Match start_link's user -> code lock order, so issuance and claims never
    // deadlock. The user lock serializes distinct claims for the fourth slot.
    let candidate: Option<i64> = sqlx::query_scalar("SELECT user_id FROM link_codes WHERE code_hash=$1 AND used_at IS NULL AND expires_at>now()")
        .bind(hash_token(&code)).fetch_optional(&mut *transaction).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let candidate = candidate.ok_or(StatusCode::NOT_FOUND)?;
    let exists = sqlx::query("SELECT id FROM users WHERE id=$1 FOR UPDATE")
        .bind(candidate).fetch_optional(&mut *transaction).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if exists.is_none() { return Err(StatusCode::NOT_FOUND); }
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
    let linked: i64 = sqlx::query_scalar("SELECT count(*) FROM minecraft_accounts WHERE user_id=$1")
        .bind(user_id).fetch_one(&mut *transaction).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if linked >= MAX_LINKED_ACCOUNTS { return Err(StatusCode::UNPROCESSABLE_ENTITY); }
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
    let mut tx = pool.begin().await.map_err(market_db)?;
    sqlx::query("SELECT uuid FROM minecraft_accounts WHERE uuid=$1 AND user_id=$2 FOR UPDATE")
        .bind(&uuid).bind(user_id).fetch_optional(&mut *tx).await.map_err(market_db)?.ok_or(StatusCode::NOT_FOUND)?;
    let busy: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM market_listings WHERE uuid=$1 AND status IN ('pending','active')) OR EXISTS(SELECT 1 FROM market_tasks WHERE uuid=$1 AND status='pending')")
        .bind(&uuid).fetch_one(&mut *tx).await.map_err(market_db)?;
    if busy { return Err(StatusCode::CONFLICT); }
    sqlx::query("DELETE FROM minecraft_accounts WHERE uuid=$1 AND user_id=$2")
        .bind(&uuid).bind(user_id).execute(&mut *tx).await.map_err(market_db)?;
    tx.commit().await.map_err(market_db)?;
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
// Immutable report IDs make retries safe: statistics and coin awards commit
// together with a receipt, including when the response is lost.
// A single report covers the players active since the last flush, so one server
// fit into a request; anything larger is a bug in the plugin, not a player base.
const STATS_REPORT_MAX_PLAYERS: usize = 1000;
// About 136 years of play, or four billion blocks, in one report. Larger values
// are broken counters, and one broken field must not poison a whole flush.
const STATS_REPORT_MAX_COUNTER: i64 = 4_294_967_295;

#[derive(serde::Deserialize, serde::Serialize)]
struct StatsReport {
    report_id: String,
    players: Vec<StatsPlayer>,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct StatsPlayer {
    uuid: String,
    username: String,
    play_seconds: i64,
    blocks_placed: i64,
    blocks_broken: i64,
    // Added with the wider activity set (migration 0008). `serde(default)` keeps
    // a plugin built before them working: a missing counter means "nothing was
    // measured", not a rejected batch. A plugin still sitting on an old jar must
    // never stop the panel from banking play time and coins.
    #[serde(default)] mobs_killed: i64,
    #[serde(default)] deaths: i64,
    #[serde(default)] distance_cm: i64,
    #[serde(default)] items_crafted: i64,
    #[serde(default)] fish_caught: i64,
    #[serde(default)] damage_dealt: i64,
    #[serde(default)] damage_taken: i64,
    #[serde(default)] logins: i64,
    #[serde(default)] items_picked_up: i64,
    #[serde(default)] items_enchanted: i64,
    #[serde(default)] tools_broken: i64,
    #[serde(default)] animals_bred: i64,
    #[serde(default)] times_slept: i64,
    #[serde(default)] advancements: i64,
}

fn valid_counter(value: i64) -> bool {
    (0..=STATS_REPORT_MAX_COUNTER).contains(&value)
}

fn valid_stats_report(report: &StatsReport) -> bool {
    is_uuid(&report.report_id)
        && (1..=STATS_REPORT_MAX_PLAYERS).contains(&report.players.len())
        && report.players.iter().all(|player| {
            is_uuid(&player.uuid)
                && is_minecraft_username(&player.username)
                && valid_counter(player.play_seconds)
                && valid_counter(player.blocks_placed)
                && valid_counter(player.blocks_broken)
                && valid_counter(player.mobs_killed)
                && valid_counter(player.deaths)
                && valid_counter(player.distance_cm)
                && valid_counter(player.items_crafted)
                && valid_counter(player.fish_caught)
                && valid_counter(player.damage_dealt)
                && valid_counter(player.damage_taken)
                && valid_counter(player.logins)
                && valid_counter(player.items_picked_up)
                && valid_counter(player.items_enchanted)
                && valid_counter(player.tools_broken)
                && valid_counter(player.animals_bred)
                && valid_counter(player.times_slept)
                && valid_counter(player.advancements)
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
    report.report_id = report.report_id.trim().to_lowercase();
    for player in report.players.iter_mut() {
        player.uuid = player.uuid.trim().to_lowercase();
        player.username = player.username.trim().to_owned();
    }
    if !valid_stats_report(&report) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut transaction = pool.begin().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let payload_hash = hash_token(&serde_json::to_string(&report).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?);
    let inserted = sqlx::query("INSERT INTO stats_reports (report_id, payload_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(&report.report_id).bind(&payload_hash)
        .execute(&mut *transaction).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if inserted.rows_affected() == 0 {
        let existing: String = sqlx::query_scalar("SELECT payload_hash FROM stats_reports WHERE report_id = $1")
            .bind(&report.report_id).fetch_one(&mut *transaction).await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        return if existing == payload_hash { Ok(StatusCode::OK) } else { Err(StatusCode::CONFLICT) };
    }
    for player in &report.players {
        sqlx
            ::query(
                "INSERT INTO player_stats (
                   uuid, username, play_seconds, blocks_placed, blocks_broken,
                   mobs_killed, deaths, distance_cm, items_crafted, fish_caught,
                   damage_dealt, damage_taken, logins, items_picked_up, items_enchanted,
                   tools_broken, animals_bred, times_slept, advancements, coins)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                         $16, $17, $18, $19, $5)
                 ON CONFLICT (uuid) DO UPDATE SET
                   username = EXCLUDED.username,
                   play_seconds = player_stats.play_seconds + EXCLUDED.play_seconds,
                   blocks_placed = player_stats.blocks_placed + EXCLUDED.blocks_placed,
                   blocks_broken = player_stats.blocks_broken + EXCLUDED.blocks_broken,
                   mobs_killed = player_stats.mobs_killed + EXCLUDED.mobs_killed,
                   deaths = player_stats.deaths + EXCLUDED.deaths,
                   distance_cm = player_stats.distance_cm + EXCLUDED.distance_cm,
                   items_crafted = player_stats.items_crafted + EXCLUDED.items_crafted,
                   fish_caught = player_stats.fish_caught + EXCLUDED.fish_caught,
                   damage_dealt = player_stats.damage_dealt + EXCLUDED.damage_dealt,
                   damage_taken = player_stats.damage_taken + EXCLUDED.damage_taken,
                   logins = player_stats.logins + EXCLUDED.logins,
                   items_picked_up = player_stats.items_picked_up + EXCLUDED.items_picked_up,
                   items_enchanted = player_stats.items_enchanted + EXCLUDED.items_enchanted,
                   tools_broken = player_stats.tools_broken + EXCLUDED.tools_broken,
                   animals_bred = player_stats.animals_bred + EXCLUDED.animals_bred,
                   times_slept = player_stats.times_slept + EXCLUDED.times_slept,
                   advancements = player_stats.advancements + EXCLUDED.advancements,
                   coins = player_stats.coins + EXCLUDED.coins,
                   last_seen_at = now()"
            )
            .bind(&player.uuid)
            .bind(&player.username)
            .bind(player.play_seconds)
            .bind(player.blocks_placed)
            .bind(player.blocks_broken)
            .bind(player.mobs_killed)
            .bind(player.deaths)
            .bind(player.distance_cm)
            .bind(player.items_crafted)
            .bind(player.fish_caught)
            .bind(player.damage_dealt)
            .bind(player.damage_taken)
            .bind(player.logins)
            .bind(player.items_picked_up)
            .bind(player.items_enchanted)
            .bind(player.tools_broken)
            .bind(player.animals_bred)
            .bind(player.times_slept)
            .bind(player.advancements)
            .execute(&mut *transaction).await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    transaction.commit().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::OK)
}

// Same source of truth as the website; even unlinked Minecraft accounts earn.
async fn balance_for_player(
    State(pool): State<sqlx::PgPool>,
    headers: HeaderMap,
    Json(input): Json<LinkStatusRequest>
) -> Result<impl IntoResponse, StatusCode> {
    require_service_token(&headers)?;
    let uuid = input.uuid.trim().to_lowercase();
    if !is_uuid(&uuid) { return Err(StatusCode::BAD_REQUEST); }
    let coins: Option<i64> = sqlx::query_scalar("SELECT coins FROM player_stats WHERE uuid = $1")
        .bind(uuid).fetch_optional(&pool).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(([(header::CACHE_CONTROL, "no-store")], coins.unwrap_or(0).to_string()))
}

// --- Player inventory ------------------------------------------------------

// The player inventory exactly as the game holds it: hotbar 0-8, main 9-35,
// armor (helmet, chest, legs, boots) 36-39 and the off hand at 40. The plugin
// reports all 41 slots, so the panel draws the layout without guessing where
// anything sits. A null entry is an empty slot.
const INVENTORY_SLOT_COUNT: usize = 41;
const INVENTORY_MAX_KEY: usize = 128;
const INVENTORY_MAX_NAME: usize = 128;
const INVENTORY_MAX_DAMAGE: i64 = 10_000;
const INVENTORY_MAX_AMOUNT: i64 = 230;
const INVENTORY_MAX_ENCHANTMENTS: usize = 32;

#[derive(serde::Deserialize, serde::Serialize)]
struct InventorySlotReport {
    #[serde(default)] fingerprint: Option<String>,
    key: String,
    amount: i64,
    #[serde(default)] damage: Option<i64>,
    #[serde(default)] max_damage: Option<i64>,
    #[serde(default)] display_name: Option<String>,
    #[serde(default)] enchantments: std::collections::BTreeMap<String, i64>,
}

#[derive(serde::Deserialize)]
struct InventoryReport {
    uuid: String,
    username: String,
    // Null entries are empty slots; the plugin reports all 41 so the layout
    // survives the trip without guessing.
    slots: Vec<Option<InventorySlotReport>>,
}

#[derive(serde::Serialize)]
struct InventorySlotView {
    fingerprint: Option<String>,
    key: String,
    amount: i64,
    damage: Option<i64>,
    max_damage: Option<i64>,
    display_name: Option<String>,
    enchantments: std::collections::BTreeMap<String, i64>,
    icon: Option<String>,
}

#[derive(serde::Serialize)]
struct InventoryView {
    marketplace: Option<serde_json::Value>,
    deletion: Option<InventoryDeletion>,
    username: Option<String>,
    updated_at: Option<String>,
    slots: Option<Vec<Option<InventorySlotView>>>,
}

/// A namespaced registry key such as `minecraft:diamond_sword`.
/// A registry key as the game writes it: one namespace, one colon, one path
/// (`minecraft:stone_sword`). Both halves are non-empty, lowercase, and drawn
/// from the character set keys actually use; a bare word is not a key.
fn is_item_key(key: &str) -> bool {
    if key.is_empty() || key.len() > INVENTORY_MAX_KEY {
        return false;
    }
    let mut parts = key.split(':');
    let (Some(namespace), Some(path)) = (parts.next(), parts.next()) else {
        return false;
    };
    parts.next().is_none()
        && !namespace.is_empty()
        && !path.is_empty()
        && key.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b':' | b'-' | b'.'))
}

fn valid_inventory_slot(slot: &InventorySlotReport) -> bool {
    // Durability only travels as a pair; half of it is a broken report, and the
    // website can only draw a wear bar from both numbers together.
    let durability = match (slot.damage, slot.max_damage) {
        (None, None) => true,
        (Some(damage), Some(max)) => {
            (0..=INVENTORY_MAX_DAMAGE).contains(&damage)
                && (1..=INVENTORY_MAX_DAMAGE).contains(&max)
                && damage <= max
        }
        _ => false,
    };
    slot.fingerprint.as_deref().is_none_or(valid_item_fingerprint)
        && is_item_key(&slot.key)
        && (1..=INVENTORY_MAX_AMOUNT).contains(&slot.amount)
        && durability
        && match &slot.display_name {
            None => true,
            Some(name) => !name.trim().is_empty() && name.chars().count() <= INVENTORY_MAX_NAME,
        }
        && slot.enchantments.len() <= INVENTORY_MAX_ENCHANTMENTS
        && slot.enchantments.iter().all(|(key, level)| is_item_key(key) && (1..=32_767).contains(level))
}

fn valid_inventory_report(report: &InventoryReport) -> bool {
    is_uuid(&report.uuid)
        && is_minecraft_username(&report.username)
        && report.slots.len() == INVENTORY_SLOT_COUNT
        && report.slots.iter().all(|slot| match slot {
            None => true,
            Some(slot) => valid_inventory_slot(slot),
        })
}

// Deliberately not rate limited, like the statistics reports: snapshots come
// from the game server's single container address, at most one per inventory
// change plus one periodic refresh per player, behind the proxy block and the
// service token.
async fn report_inventory(
    State(pool): State<sqlx::PgPool>,
    headers: HeaderMap,
    Json(mut report): Json<InventoryReport>
) -> Result<StatusCode, StatusCode> {
    require_service_token(&headers)?;
    report.uuid = report.uuid.trim().to_lowercase();
    report.username = report.username.trim().to_owned();
    for slot in report.slots.iter_mut().flatten() {
        slot.key = slot.key.trim().to_lowercase();
        slot.display_name = slot.display_name.as_deref().map(str::trim).filter(|name| !name.is_empty()).map(str::to_owned);
        slot.enchantments = slot.enchantments.iter()
            .map(|(key, level)| (key.trim().to_lowercase(), *level))
            .collect();
    }
    if !valid_inventory_report(&report) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let slots = serde_json::to_string(&report.slots).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    sqlx::query("INSERT INTO player_inventory (uuid, username, slots) VALUES ($1, $2, $3::jsonb)
                 ON CONFLICT (uuid) DO UPDATE SET
                   username = EXCLUDED.username,
                   slots = EXCLUDED.slots,
                   updated_at = now()")
        .bind(&report.uuid)
        .bind(&report.username)
        .bind(slots)
        .execute(&pool).await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::OK)
}

// The session cookie decides what is visible: only the inventory of accounts
// this user has linked. A snapshot about a UUID the user does not link is
// stored, but no request can make it visible. `slots` is null until the game
// server has reported one, like `stats` on `/api/stats`.
async fn player_inventory(
    State(pool): State<sqlx::PgPool>,
    SessionUser { user_id }: SessionUser,
    Path(uuid): Path<String>,
) -> Result<impl IntoResponse, StatusCode> {
    let uuid = uuid.to_lowercase();
    owns_player(&pool, user_id, &uuid).await?;
    let row = sqlx::query("SELECT username, updated_at::text AS updated_at, slots::text AS slots
                           FROM player_inventory WHERE uuid = $1")
        .bind(&uuid)
        .fetch_optional(&pool).await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let Some(row) = row else {
        return Ok((
            [(header::CACHE_CONTROL, "no-store")],
            Json(InventoryView { marketplace: None, deletion: None, username: None, updated_at: None, slots: None }),
        ));
    };
    let slots_json: String = row.get("slots");
    let raw: Vec<Option<InventorySlotReport>> =
        serde_json::from_str(&slots_json).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    // Every item key in the snapshot, resolved to its stored texture in one
    // indexed lookup. Keys without a stored icon answer null; the website then
    // shows its fallback artwork and the item name.
    let mut icon_keys: Vec<String> = raw.iter().flatten().map(|slot| slot.key.clone()).collect();
    icon_keys.sort();
    icon_keys.dedup();
    let mut icons: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if !icon_keys.is_empty() {
        let icon_rows = sqlx::query("SELECT key, data_url FROM item_icons WHERE key = ANY($1::text[])")
            .bind(&icon_keys)
            .fetch_all(&pool).await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        for icon in icon_rows {
            let key: String = icon.get("key");
            let data_url: String = icon.get("data_url");
            icons.insert(key, data_url);
        }
    }
    let slots: Vec<Option<InventorySlotView>> = raw
        .into_iter()
        .map(|slot| {
            slot.map(|slot| InventorySlotView {
                icon: icons.get(&slot.key).cloned(),
                fingerprint: slot.fingerprint,
                key: slot.key,
                amount: slot.amount,
                damage: slot.damage,
                max_damage: slot.max_damage,
                display_name: slot.display_name,
                enchantments: slot.enchantments,
            })
        })
        .collect();
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(InventoryView {
            marketplace: sqlx::query("SELECT id,status FROM market_listings WHERE uuid=$1 ORDER BY created_at DESC LIMIT 1")
                .bind(&uuid).fetch_optional(&pool).await.map_err(market_db)?
                .map(|r| serde_json::json!({"id":r.get::<String,_>("id"),"status":r.get::<String,_>("status")})),
            deletion: inventory_deletion(&pool, &uuid).await?,
            username: Some(row.get("username")),
            updated_at: Some(row.get("updated_at")),
            slots: Some(slots),
        }),
    ))
}

// A fingerprint covers the complete item NBT, including components that the
// read-only slot description does not expose (e.g. shulker-box contents).
fn valid_item_fingerprint(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(serde::Serialize)]
struct InventoryDeletion { request_id: String, slot: i32, status: String }

async fn inventory_deletion(pool: &sqlx::PgPool, uuid: &str) -> Result<Option<InventoryDeletion>, StatusCode> {
    let row = sqlx::query("SELECT request_id, slot, status FROM inventory_deletions WHERE uuid=$1")
        .bind(uuid).fetch_optional(pool).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(row.map(|r| InventoryDeletion { request_id: r.get("request_id"), slot: r.get("slot"), status: r.get("status") }))
}

async fn sync_inventory_deletions(State(pool): State<sqlx::PgPool>, headers: HeaderMap)
    -> Result<Json<Vec<serde_json::Value>>, StatusCode> {
    require_service_token(&headers)?;
    let mut tx = pool.begin().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let rows = sqlx::query("SELECT a.uuid,a.username,d.request_id,d.slot,d.fingerprint FROM minecraft_accounts a
        LEFT JOIN inventory_deletions d ON d.uuid=a.uuid AND d.status='pending'
        WHERE d.request_id IS NOT NULL OR a.inventory_checked_at < now()-interval '30 seconds'
        ORDER BY a.inventory_checked_at LIMIT 25 FOR UPDATE OF a SKIP LOCKED")
        .fetch_all(&mut *tx).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let uuids: Vec<String> = rows.iter().map(|r| r.get("uuid")).collect();
    sqlx::query("UPDATE minecraft_accounts SET inventory_checked_at=now() WHERE uuid=ANY($1::text[])")
        .bind(&uuids).execute(&mut *tx).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    tx.commit().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(rows.into_iter().map(|r| serde_json::json!({
        "uuid": r.get::<String,_>("uuid"), "username": r.get::<String,_>("username"),
        "request_id": r.get::<Option<String>,_>("request_id"), "slot": r.get::<Option<i32>,_>("slot"), "fingerprint": r.get::<Option<String>,_>("fingerprint")
    })).collect()))
}

#[derive(serde::Deserialize)]
struct InventoryDeletionResult { uuid: String, request_id: String, status: String, slots: Vec<Option<InventorySlotReport>> }

async fn complete_inventory_deletion(State(pool): State<sqlx::PgPool>, headers: HeaderMap, Json(body): Json<InventoryDeletionResult>)
    -> Result<StatusCode, StatusCode> {
    require_service_token(&headers)?;
    if !matches!(body.status.as_str(), "deleted" | "conflict") || body.slots.len() != INVENTORY_SLOT_COUNT
        || !body.slots.iter().flatten().all(valid_inventory_slot) { return Err(StatusCode::BAD_REQUEST); }
    let mut tx = pool.begin().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let row = sqlx::query("UPDATE inventory_deletions SET status=$3 WHERE uuid=$1 AND request_id=$2 AND status='pending' RETURNING uuid")
        .bind(&body.uuid).bind(&body.request_id).bind(&body.status).fetch_optional(&mut *tx).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if row.is_none() { return Err(StatusCode::CONFLICT); }
    sqlx::query("UPDATE player_inventory SET slots=$2,updated_at=now() WHERE uuid=$1")
        .bind(&body.uuid).bind(serde_json::to_value(body.slots).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?)
        .execute(&mut *tx).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    tx.commit().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::OK)
}

// --- Marketplace: confirmed item escrow and atomic coin trades --------------

fn market_db(_: sqlx::Error) -> StatusCode {
    StatusCode::INTERNAL_SERVER_ERROR
}
fn market_header(headers: &HeaderMap) -> Result<(), StatusCode> {
    if headers.get("x-marketplace").and_then(|v| v.to_str().ok()) != Some("trade") {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(())
}
fn market_lot_price(price: i64, remaining: i32, quantity: i32) -> i64 {
    (price * i64::from(remaining) + i64::from(quantity) - 1) / i64::from(quantity)
}

#[derive(serde::Deserialize)]
struct MarketListingInput {
    slot: usize,
    fingerprint: String,
    quantity: i32,
    unit_price: Option<i64>,
    lot_price: Option<i64>,
}
async fn create_market_listing(
    State(pool): State<sqlx::PgPool>,
    SessionUser { user_id }: SessionUser,
    Path(uuid): Path<String>,
    headers: HeaderMap,
    Json(body): Json<MarketListingInput>,
) -> Result<StatusCode, StatusCode> {
    market_header(&headers)?;
    let uuid = uuid.to_lowercase();
    if body.slot >= INVENTORY_SLOT_COUNT
        || !valid_item_fingerprint(&body.fingerprint)
        || !(1..=230).contains(&body.quantity)
        || (body.unit_price.is_none() && body.lot_price.is_none())
        || [body.unit_price, body.lot_price]
            .into_iter()
            .flatten()
            .any(|v| !(1..=1_000_000_000).contains(&v))
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut tx = pool.begin().await.map_err(market_db)?;
    let username: Option<String> = sqlx::query_scalar(
        "SELECT username FROM minecraft_accounts WHERE uuid=$1 AND user_id=$2 FOR UPDATE",
    )
    .bind(&uuid)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(market_db)?;
    let username = username.ok_or(StatusCode::NOT_FOUND)?;
    let busy: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM market_tasks WHERE uuid=$1 AND status='pending') OR EXISTS(SELECT 1 FROM inventory_deletions WHERE uuid=$1 AND status='pending')")
        .bind(&uuid).fetch_one(&mut *tx).await.map_err(market_db)?;
    if busy {
        return Err(StatusCode::CONFLICT);
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM market_listings WHERE uuid=$1 AND status IN ('pending','active')",
    )
    .bind(&uuid)
    .fetch_one(&mut *tx)
    .await
    .map_err(market_db)?;
    if count >= 100 {
        return Err(StatusCode::TOO_MANY_REQUESTS);
    }
    let item: Option<serde_json::Value> = sqlx::query_scalar(
        "SELECT slots->($2::int) FROM player_inventory WHERE uuid=$1 FOR UPDATE",
    )
    .bind(&uuid)
    .bind(body.slot as i32)
    .fetch_optional(&mut *tx)
    .await
    .map_err(market_db)?;
    let mut item = item.ok_or(StatusCode::CONFLICT)?;
    if item["fingerprint"].as_str() != Some(&body.fingerprint)
        || item["amount"].as_i64().unwrap_or(0) < i64::from(body.quantity)
    {
        return Err(StatusCode::CONFLICT);
    }
    item["amount"] = serde_json::json!(body.quantity);
    let id = new_session_token()?;
    sqlx::query("INSERT INTO market_listings(id,user_id,uuid,username,item,quantity,remaining,unit_price,lot_price,status) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,'pending')")
        .bind(&id).bind(user_id).bind(&uuid).bind(&username).bind(item).bind(body.quantity)
        .bind(body.unit_price).bind(body.lot_price).execute(&mut *tx).await.map_err(market_db)?;
    sqlx::query("INSERT INTO market_tasks(id,listing_id,uuid,username,kind,quantity,slot,fingerprint) VALUES($1,$2,$3,$4,'withdraw',$5,$6,$7)")
        .bind(new_session_token()?).bind(id).bind(uuid).bind(username).bind(body.quantity).bind(body.slot as i32).bind(body.fingerprint)
        .execute(&mut *tx).await.map_err(market_db)?;
    tx.commit().await.map_err(market_db)?;
    Ok(StatusCode::ACCEPTED)
}

#[derive(serde::Deserialize, Default)]
struct MarketQuery {
    #[serde(default)]
    mine: bool,
    #[serde(default)]
    q: String,
    cursor: Option<String>,
}
async fn marketplace(
    State(pool): State<sqlx::PgPool>,
    SessionUser { user_id }: SessionUser,
    Query(query): Query<MarketQuery>,
) -> Result<impl IntoResponse, StatusCode> {
    // No raw NBT, private inventory, UUID, or website identity is shared with buyers.
    if query.q.len() > 128 {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut rows = sqlx::query("SELECT l.id,l.user_id,l.username,l.item,l.quantity,l.remaining,l.unit_price,l.lot_price,l.status,i.data_url AS icon FROM market_listings l LEFT JOIN item_icons i ON i.key=l.item->>'key'
        WHERE (CASE WHEN $2 THEN l.user_id=$1 ELSE l.status='active' AND l.remaining>0 END)
        AND position(lower($3) in lower(coalesce(l.item->>'display_name','') || ' ' || replace(l.item->>'key','_',' ') || ' ' || (l.item->>'key') || ' ' || l.username))>0
        AND ($4::text IS NULL OR (l.created_at,l.id)<(SELECT created_at,id FROM market_listings WHERE id=$4))
        ORDER BY l.created_at DESC,l.id DESC LIMIT 51")
        .bind(user_id).bind(query.mine).bind(query.q.trim()).bind(query.cursor).fetch_all(&pool).await.map_err(market_db)?;
    let more = rows.len() > 50;
    rows.truncate(50);
    let next_cursor = if more {
        rows.last().map(|r| r.get::<String, _>("id"))
    } else {
        None
    };
    let listings: Vec<serde_json::Value> = rows.into_iter().map(|r| {
        let remaining: i32 = r.get("remaining");
        let quantity: i32 = r.get("quantity");
        let lot: Option<i64> = r.get("lot_price");
        let mut item: serde_json::Value = r.get("item");
        item["icon"] = serde_json::json!(r.get::<Option<String>,_>("icon"));
        item["amount"] = serde_json::json!(remaining);
        item["fingerprint"] = serde_json::Value::Null;
        serde_json::json!({"id":r.get::<String,_>("id"),"seller":r.get::<String,_>("username"),
            "mine":r.get::<i64,_>("user_id")==user_id,"item":item,"quantity":quantity,"remaining":remaining,
            "unit_price":r.get::<Option<i64>,_>("unit_price"),"lot_price":lot.map(|p| market_lot_price(p,remaining,quantity)),
            "status":r.get::<String,_>("status")})
    }).collect();
    let deliveries = sqlx::query("SELECT t.id,t.username,t.quantity,t.status,l.item FROM market_tasks t JOIN market_listings l ON l.id=t.listing_id
        JOIN minecraft_accounts a ON a.uuid=t.uuid WHERE a.user_id=$1 AND t.kind='deliver' ORDER BY t.sequence DESC LIMIT 100")
        .bind(user_id).fetch_all(&pool).await.map_err(market_db)?;
    let deliveries: Vec<serde_json::Value> = deliveries.into_iter().map(|r| serde_json::json!({
        "id":r.get::<String,_>("id"),"username":r.get::<String,_>("username"),"quantity":r.get::<i32,_>("quantity"),
        "status":r.get::<String,_>("status"),"item":r.get::<serde_json::Value,_>("item")
    })).collect();
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(
            serde_json::json!({"listings":listings,"deliveries":deliveries,"next_cursor":next_cursor}),
        ),
    ))
}

#[derive(serde::Deserialize, serde::Serialize)]
struct MarketPurchase {
    request_id: String,
    buyer_uuid: String,
    quantity: i32,
    pricing: String,
    expected_total: i64,
    expected_remaining: i32,
}
async fn buy_market_listing(
    State(pool): State<sqlx::PgPool>,
    SessionUser { user_id }: SessionUser,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<MarketPurchase>,
) -> Result<StatusCode, StatusCode> {
    market_header(&headers)?;
    if !is_uuid(&body.buyer_uuid)
        || !is_uuid(&body.request_id)
        || !(1..=230).contains(&body.quantity)
        || !matches!(body.pricing.as_str(), "unit" | "lot")
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let hash = hash_token(&format!(
        "{id}:{}",
        serde_json::to_string(&body).map_err(|_| StatusCode::BAD_REQUEST)?
    ));
    let mut tx = pool.begin().await.map_err(market_db)?;
    // Lock ownership before escrow and balances. The sorted wallet locks also
    // serialize opposing trades without a buyer/seller deadlock.
    let username: Option<String> = sqlx::query_scalar(
        "SELECT username FROM minecraft_accounts WHERE uuid=$1 AND user_id=$2 FOR UPDATE",
    )
    .bind(&body.buyer_uuid)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(market_db)?;
    let username = username.ok_or(StatusCode::NOT_FOUND)?;
    let prior = sqlx::query("SELECT user_id,payload_hash FROM market_orders WHERE id=$1")
        .bind(&body.request_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(market_db)?;
    if let Some(prior) = prior {
        return if prior.get::<i64, _>("user_id") == user_id
            && prior.get::<String, _>("payload_hash") == hash
        {
            Ok(StatusCode::ACCEPTED)
        } else {
            Err(StatusCode::CONFLICT)
        };
    }
    let listing = sqlx::query("SELECT * FROM market_listings WHERE id=$1 FOR UPDATE")
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(market_db)?
        .ok_or(StatusCode::NOT_FOUND)?;
    if listing.get::<i64, _>("user_id") == user_id || listing.get::<String, _>("status") != "active"
    {
        return Err(StatusCode::CONFLICT);
    }
    let remaining: i32 = listing.get("remaining");
    if remaining != body.expected_remaining || body.quantity > remaining {
        return Err(StatusCode::CONFLICT);
    }
    let price: Option<i64> = if body.pricing == "unit" {
        listing
            .get::<Option<i64>, _>("unit_price")
            .map(|p| p * i64::from(body.quantity))
    } else if body.quantity == remaining {
        listing
            .get::<Option<i64>, _>("lot_price")
            .map(|p| market_lot_price(p, remaining, listing.get("quantity")))
    } else {
        None
    };
    let total = price.ok_or(StatusCode::BAD_REQUEST)?;
    if total != body.expected_total {
        return Err(StatusCode::CONFLICT);
    }
    let seller: String = listing.get("uuid");
    // An active listing always has a saved lossless item. Delivery stays durable
    // even when the recipient is offline or has no empty storage slot.
    let bytes: String = listing
        .get::<Option<String>, _>("item_bytes")
        .ok_or(StatusCode::CONFLICT)?;
    sqlx::query("INSERT INTO player_stats(uuid,username) SELECT * FROM unnest($1::text[],$2::text[]) AS w(uuid,username) ORDER BY uuid ON CONFLICT(uuid) DO NOTHING")
        .bind(vec![&body.buyer_uuid,&seller]).bind(vec![username.clone(),listing.get::<String,_>("username")])
        .execute(&mut *tx).await.map_err(market_db)?;
    sqlx::query(
        "SELECT uuid FROM player_stats WHERE uuid=ANY($1::text[]) ORDER BY uuid FOR UPDATE",
    )
    .bind(vec![&body.buyer_uuid, &seller])
    .fetch_all(&mut *tx)
    .await
    .map_err(market_db)?;
    let charged =
        sqlx::query("UPDATE player_stats SET coins=coins-$2 WHERE uuid=$1 AND coins >= $2")
            .bind(&body.buyer_uuid)
            .bind(total)
            .execute(&mut *tx)
            .await
            .map_err(market_db)?
            .rows_affected();
    if charged == 0 {
        return Err(StatusCode::UNPROCESSABLE_ENTITY);
    }
    let paid = sqlx::query(
        "UPDATE player_stats SET coins=coins+$2 WHERE uuid=$1 AND coins <= 9223372036854775807-$2",
    )
    .bind(seller)
    .bind(total)
    .execute(&mut *tx)
    .await
    .map_err(market_db)?
    .rows_affected();
    if paid == 0 {
        return Err(StatusCode::CONFLICT);
    }
    sqlx::query("UPDATE market_listings SET remaining=remaining-$2,status=CASE WHEN remaining=$2 THEN 'closed' ELSE 'active' END WHERE id=$1")
        .bind(&id).bind(body.quantity).execute(&mut *tx).await.map_err(market_db)?;
    sqlx::query("INSERT INTO market_orders(id,user_id,payload_hash,listing_id,buyer_uuid,quantity,total) VALUES($1,$2,$3,$4,$5,$6,$7)")
        .bind(&body.request_id).bind(user_id).bind(hash).bind(&id).bind(&body.buyer_uuid).bind(body.quantity).bind(total)
        .execute(&mut *tx).await.map_err(|e| if e.as_database_error().is_some_and(|db| db.is_unique_violation()) { StatusCode::CONFLICT } else { market_db(e) })?;
    sqlx::query("INSERT INTO market_tasks(id,listing_id,uuid,username,kind,quantity,item_bytes) VALUES($1,$2,$3,$4,'deliver',$5,$6)")
        .bind(new_session_token()?).bind(id).bind(body.buyer_uuid).bind(username).bind(body.quantity).bind(bytes)
        .execute(&mut *tx).await.map_err(market_db)?;
    tx.commit().await.map_err(market_db)?;
    Ok(StatusCode::ACCEPTED)
}

async fn cancel_market_listing(
    State(pool): State<sqlx::PgPool>,
    SessionUser { user_id }: SessionUser,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<StatusCode, StatusCode> {
    market_header(&headers)?;
    let mut tx = pool.begin().await.map_err(market_db)?;
    // Same lock order as posting and buying, and unlink must wait for this lock.
    let uuid: Option<String> =
        sqlx::query_scalar("SELECT uuid FROM market_listings WHERE id=$1 AND user_id=$2")
            .bind(&id)
            .bind(user_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(market_db)?;
    let uuid = uuid.ok_or(StatusCode::NOT_FOUND)?;
    sqlx::query("SELECT uuid FROM minecraft_accounts WHERE uuid=$1 AND user_id=$2 FOR UPDATE")
        .bind(&uuid)
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(market_db)?
        .ok_or(StatusCode::NOT_FOUND)?;
    let row = sqlx::query("SELECT item_bytes,username,remaining AS returning_quantity FROM market_listings WHERE id=$1 AND user_id=$2 AND status='active' FOR UPDATE")
        .bind(&id).bind(user_id).fetch_optional(&mut *tx).await.map_err(market_db)?.ok_or(StatusCode::CONFLICT)?;
    sqlx::query("UPDATE market_listings SET remaining=0,status='closed' WHERE id=$1")
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(market_db)?;
    sqlx::query("INSERT INTO market_tasks(id,listing_id,uuid,username,kind,quantity,item_bytes) VALUES($1,$2,$3,$4,'deliver',$5,$6)")
        .bind(new_session_token()?).bind(id).bind(uuid).bind(row.get::<String,_>("username"))
        .bind(row.get::<i32,_>("returning_quantity")).bind(row.get::<Option<String>,_>("item_bytes"))
        .execute(&mut *tx).await.map_err(market_db)?;
    tx.commit().await.map_err(market_db)?;
    Ok(StatusCode::ACCEPTED)
}

async fn sync_market_tasks(
    State(pool): State<sqlx::PgPool>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, StatusCode> {
    require_service_token(&headers)?;
    let rows = sqlx::query("SELECT * FROM (SELECT DISTINCT ON(uuid) * FROM market_tasks WHERE status='pending' ORDER BY uuid,sequence) t ORDER BY sequence LIMIT 25")
        .fetch_all(&pool).await.map_err(market_db)?;
    let tasks: Vec<serde_json::Value> = rows.into_iter().map(|r| serde_json::json!({
        "id":r.get::<String,_>("id"),"uuid":r.get::<String,_>("uuid"),"username":r.get::<String,_>("username"),
        "kind":r.get::<String,_>("kind"),"quantity":r.get::<i32,_>("quantity"),"slot":r.get::<Option<i32>,_>("slot"),
        "fingerprint":r.get::<Option<String>,_>("fingerprint"),"item_bytes":r.get::<Option<String>,_>("item_bytes")
    })).collect();
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(tasks)))
}
#[derive(serde::Deserialize)]
struct MarketTaskResult {
    id: String,
    uuid: String,
    status: String,
    item_bytes: Option<String>,
    slots: Vec<Option<InventorySlotReport>>,
}
async fn complete_market_task(
    State(pool): State<sqlx::PgPool>,
    headers: HeaderMap,
    Json(body): Json<MarketTaskResult>,
) -> Result<StatusCode, StatusCode> {
    require_service_token(&headers)?;
    if !is_uuid(&body.uuid)
        || !valid_item_fingerprint(&body.id)
        || !matches!(body.status.as_str(), "done" | "conflict")
        || body.slots.len() != 41
        || !body.slots.iter().flatten().all(valid_inventory_slot)
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut tx = pool.begin().await.map_err(market_db)?;
    let row = sqlx::query("SELECT * FROM market_tasks WHERE id=$1 AND uuid=$2 FOR UPDATE")
        .bind(&body.id)
        .bind(&body.uuid)
        .fetch_optional(&mut *tx)
        .await
        .map_err(market_db)?
        .ok_or(StatusCode::NOT_FOUND)?;
    if row.get::<String, _>("status") != "pending" {
        return Ok(StatusCode::OK);
    }
    // A server must never skip an unacknowledged receipt for the same player.
    let first: String = sqlx::query_scalar(
        "SELECT id FROM market_tasks WHERE uuid=$1 AND status='pending' ORDER BY sequence LIMIT 1",
    )
    .bind(&body.uuid)
    .fetch_one(&mut *tx)
    .await
    .map_err(market_db)?;
    if first != body.id {
        return Err(StatusCode::CONFLICT);
    }
    if row.get::<String, _>("kind") == "withdraw" {
        if body.status == "done" {
            use base64::Engine;
            let bytes = body.item_bytes.as_deref().ok_or(StatusCode::BAD_REQUEST)?;
            if bytes.len() > 1_400_000
                || base64::engine::general_purpose::STANDARD
                    .decode(bytes)
                    .is_err()
                || bytes.is_empty()
            {
                return Err(StatusCode::BAD_REQUEST);
            }
            sqlx::query("UPDATE market_listings SET status='active',item_bytes=$2 WHERE id=$1 AND status='pending'")
                .bind(row.get::<String,_>("listing_id")).bind(bytes).execute(&mut *tx).await.map_err(market_db)?;
        } else {
            sqlx::query("UPDATE market_listings SET status='conflict',remaining=0 WHERE id=$1 AND status='pending'")
                .bind(row.get::<String,_>("listing_id")).execute(&mut *tx).await.map_err(market_db)?;
        }
    } else if body.status != "done" {
        return Err(StatusCode::BAD_REQUEST);
    }
    sqlx::query("UPDATE market_tasks SET status=$2 WHERE id=$1")
        .bind(body.id)
        .bind(body.status)
        .execute(&mut *tx)
        .await
        .map_err(market_db)?;
    sqlx::query("UPDATE player_inventory SET slots=$2,updated_at=now() WHERE uuid=$1")
        .bind(body.uuid)
        .bind(serde_json::to_value(body.slots).map_err(|_| StatusCode::BAD_REQUEST)?)
        .execute(&mut *tx)
        .await
        .map_err(market_db)?;
    tx.commit().await.map_err(market_db)?;
    Ok(StatusCode::OK)
}

// --- Item icons ------------------------------------------------------------

const ICON_REPORT_MAX_ITEMS: usize = 100;
// Base64 of at most 48 KiB of PNG: one 16x16 texture is a few hundred bytes,
// so the cap is against a bug, not a skin-sized upload.
const ICON_MAX_DATA_LEN: usize = 64 * 1024;
const ICON_MAX_PNG_BYTES: usize = 48 * 1024;

#[derive(serde::Deserialize)]
struct IconReport {
    items: Vec<IconUpload>,
}

#[derive(serde::Deserialize)]
struct IconUpload {
    key: String,
    icon: String,
}

/// The PNG signature alone is forgeable, so the picture is fully decoded before
/// anything is stored: an icon the panel serves must be a real picture, not a
/// payload wearing a PNG header. The base64 and byte caps are the real guard;
/// this only proves the bytes decode.
fn decoded_png_bytes(data: &str) -> Option<Vec<u8>> {
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data).ok()?;
    if bytes.len() < 8 || bytes.len() > ICON_MAX_PNG_BYTES {
        return None;
    }
    let mut decoder = png::Decoder::new(std::io::Cursor::new(&bytes));
    // Well above any vanilla texture, small enough that a decompression bomb
    // cannot be pushed through this endpoint.
    decoder.set_limits(png::Limits { bytes: 4 * 1024 * 1024 });
    let mut reader = decoder.read_info().ok()?;
    let mut buffer = vec![0; reader.output_buffer_size()?];
    reader.next_frame(&mut buffer).ok()?;
    Some(bytes)
}

// The plugin sends the exact texture bytes from the running server jar, so an
// icon always matches the version its snapshot was measured on. The first
// upload for a key is kept: a texture does not change under a running server.
async fn report_item_icons(
    State(pool): State<sqlx::PgPool>,
    headers: HeaderMap,
    Json(mut report): Json<IconReport>
) -> Result<StatusCode, StatusCode> {
    require_service_token(&headers)?;
    for item in report.items.iter_mut() {
        item.key = item.key.trim().to_lowercase();
        item.icon = item.icon.trim().to_owned();
    }
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    if !(1..=ICON_REPORT_MAX_ITEMS).contains(&report.items.len()) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut decoded: Vec<(String, Vec<u8>)> = Vec::with_capacity(report.items.len());
    for item in &report.items {
        if !is_item_key(&item.key) || item.icon.len() > ICON_MAX_DATA_LEN || !seen.insert(item.key.clone()) {
            return Err(StatusCode::BAD_REQUEST);
        }
        let Some(bytes) = decoded_png_bytes(&item.icon) else {
            return Err(StatusCode::BAD_REQUEST);
        };
        decoded.push((item.key.clone(), bytes));
    }
    for (key, bytes) in decoded {
        // Re-encode so the stored data URL is canonical base64.
        let data_url = format!("data:image/png;base64,{}", base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes));
        sqlx::query("INSERT INTO item_icons (key, data_url) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING")
            .bind(&key)
            .bind(data_url)
            .execute(&pool).await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    Ok(StatusCode::OK)
}

#[derive(serde::Serialize)]
struct AccountStats {
    play_seconds: i64,
    blocks_placed: i64,
    blocks_broken: i64,
    mobs_killed: i64,
    deaths: i64,
    /// Hundredths of a block (1 block = 100), so `/api/stats` never rounds twice.
    distance_cm: i64,
    items_crafted: i64,
    fish_caught: i64,
    /// Hundredths of a heart (100 = 1 heart), the game's own damage points scaled.
    damage_dealt: i64,
    damage_taken: i64,
    logins: i64,
    items_picked_up: i64,
    items_enchanted: i64,
    tools_broken: i64,
    animals_bred: i64,
    times_slept: i64,
    advancements: i64,
    first_seen_at: String,
    last_seen_at: String,
}

#[derive(serde::Serialize)]
struct StatsAccount {
    coins: i64,
    uuid: String,
    username: String,
    linked_at: String,
    stats: Option<AccountStats>,
    skin_hash: Option<String>,
}

#[derive(serde::Serialize)]
struct StatsSummary {
    coins: i64,
    accounts: i64,
    accounts_with_stats: i64,
    play_seconds: i64,
    blocks_placed: i64,
    blocks_broken: i64,
    mobs_killed: i64,
    deaths: i64,
    distance_cm: i64,
    items_crafted: i64,
    fish_caught: i64,
    damage_dealt: i64,
    damage_taken: i64,
    logins: i64,
    items_picked_up: i64,
    items_enchanted: i64,
    tools_broken: i64,
    animals_bred: i64,
    times_slept: i64,
    advancements: i64,
}

impl StatsSummary {
    fn empty() -> Self {
        Self {
            coins: 0,
            accounts: 0,
            accounts_with_stats: 0,
            play_seconds: 0,
            blocks_placed: 0,
            blocks_broken: 0,
            mobs_killed: 0,
            deaths: 0,
            distance_cm: 0,
            items_crafted: 0,
            fish_caught: 0,
            damage_dealt: 0,
            damage_taken: 0,
            logins: 0,
            items_picked_up: 0,
            items_enchanted: 0,
            tools_broken: 0,
            animals_bred: 0,
            times_slept: 0,
            advancements: 0,
        }
    }

    /// One account's counters, added to the user's combined total. Only accounts
    /// that actually have a `player_stats` row contribute.
    fn add(&mut self, stats: &AccountStats) {
        self.accounts_with_stats += 1;
        self.play_seconds += stats.play_seconds;
        self.blocks_placed += stats.blocks_placed;
        self.blocks_broken += stats.blocks_broken;
        self.mobs_killed += stats.mobs_killed;
        self.deaths += stats.deaths;
        self.distance_cm += stats.distance_cm;
        self.items_crafted += stats.items_crafted;
        self.fish_caught += stats.fish_caught;
        self.damage_dealt += stats.damage_dealt;
        self.damage_taken += stats.damage_taken;
        self.logins += stats.logins;
        self.items_picked_up += stats.items_picked_up;
        self.items_enchanted += stats.items_enchanted;
        self.tools_broken += stats.tools_broken;
        self.animals_bred += stats.animals_bred;
        self.times_slept += stats.times_slept;
        self.advancements += stats.advancements;
    }
}

#[derive(serde::Serialize)]
struct StatsView {
    accounts: Vec<StatsAccount>,
    summary: StatsSummary,
}

/// Reads one non-null counter. Every column is `NOT NULL DEFAULT 0` from
/// migration 0005/0007/0008 on, so a missing value is a real server error.
fn stat_counter(row: &sqlx::postgres::PgRow, name: &str) -> Result<i64, StatusCode> {
    row.try_get(name).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
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
            "SELECT ma.uuid, ma.username, ma.linked_at::text AS linked_at, sk.texture_hash AS skin_hash,
                    COALESCE(ps.coins, 0) AS coins,
                    ps.play_seconds, ps.blocks_placed, ps.blocks_broken,
                    ps.mobs_killed, ps.deaths, ps.distance_cm, ps.items_crafted, ps.fish_caught,
                    ps.damage_dealt, ps.damage_taken, ps.logins, ps.items_picked_up,
                    ps.items_enchanted, ps.tools_broken, ps.animals_bred, ps.times_slept,
                    ps.advancements,
                    ps.first_seen_at::text AS first_seen_at,
                    ps.last_seen_at::text AS last_seen_at
             FROM minecraft_accounts ma
             LEFT JOIN player_stats ps ON ps.uuid = ma.uuid
             LEFT JOIN player_skins sk ON sk.uuid = ma.uuid
             WHERE ma.user_id = $1
             ORDER BY ma.linked_at"
        )
        .bind(user_id)
        .fetch_all(&pool).await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut accounts = Vec::with_capacity(rows.len());
    let mut summary = StatsSummary::empty();
    for row in &rows {
        let uuid: String = row.try_get("uuid").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let username: String = row.try_get("username").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let linked_at: String = row.try_get("linked_at").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        // The presence of the joined row is what "the server reported something"
        // means; `play_seconds` is only the cheapest way to ask.
        let stats = match row.try_get::<Option<i64>, &str>("play_seconds") {
            Ok(Some(play_seconds)) => {
                let found = AccountStats {
                    play_seconds,
                    blocks_placed: stat_counter(row, "blocks_placed")?,
                    blocks_broken: stat_counter(row, "blocks_broken")?,
                    mobs_killed: stat_counter(row, "mobs_killed")?,
                    deaths: stat_counter(row, "deaths")?,
                    distance_cm: stat_counter(row, "distance_cm")?,
                    items_crafted: stat_counter(row, "items_crafted")?,
                    fish_caught: stat_counter(row, "fish_caught")?,
                    damage_dealt: stat_counter(row, "damage_dealt")?,
                    damage_taken: stat_counter(row, "damage_taken")?,
                    logins: stat_counter(row, "logins")?,
                    items_picked_up: stat_counter(row, "items_picked_up")?,
                    items_enchanted: stat_counter(row, "items_enchanted")?,
                    tools_broken: stat_counter(row, "tools_broken")?,
                    animals_bred: stat_counter(row, "animals_bred")?,
                    times_slept: stat_counter(row, "times_slept")?,
                    advancements: stat_counter(row, "advancements")?,
                    first_seen_at: row.try_get("first_seen_at").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
                    last_seen_at: row.try_get("last_seen_at").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
                };
                summary.add(&found);
                Some(found)
            }
            // Linked, but the server has not reported anything about this UUID yet.
            Ok(None) => None,
            Err(_) => return Err(StatusCode::INTERNAL_SERVER_ERROR),
        };
        let coins: i64 = row.try_get("coins").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        summary.coins += coins;
        summary.accounts += 1;
        accounts.push(StatsAccount { coins, uuid, username, linked_at, stats, skin_hash: row.try_get("skin_hash").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)? });
    }
    Ok(Json(StatsView { accounts, summary }))
}

// --- Minigames -------------------------------------------------------------
//
// The browser never decides an outcome. A round is created, charged and — for
// Minesweeper — dealt on the server; the client only names the cell it wants to
// open or asks to cash out. Every coin change is one SQL statement against
// `player_stats.coins`, the same balance the game server reports into and `/bal`
// reads, so a minigame win or loss is visible in game immediately.
//
// The tables below are the whole economy. `chest_rtp_x10000` and
// `mines_rtp_x10000` are computed from them, so the return the window shows can
// never drift from the return that is actually paid.

const MINIGAME_MIN_BET: i64 = 10;
const MINIGAME_MAX_BET: i64 = 100_000;
/// An abandoned round forfeits its stake after this long. A reload restores the
/// round, so only a tab that is really gone ever reaches this.
const MINIGAME_ROUND_TTL_SECONDS: i64 = 900;
const MINES_CELLS: usize = 25;
const MINES_MIN_SAFE: i64 = 2;
const MINES_START_X100: i64 = 100;

/// Money is never a float: multipliers are hundredths of the stake.
struct ChestSymbol {
    id: &'static str,
    triple_x100: i64,
    pair_x100: i64,
    /// Share of three-of-a-kind rolls, out of 100.
    triple_weight: u64,
}

// 91.8% return. Reels are the marine treasures the window draws, and the paytable
// stays close to its shape: three of a kind is rare, a pair is the ordinary win.
const CHEST_SYMBOLS: [ChestSymbol; 8] = [
    ChestSymbol { id: "diamond", triple_x100: 4000, pair_x100: 400, triple_weight: 8 },
    ChestSymbol { id: "heart_of_the_sea", triple_x100: 2000, pair_x100: 250, triple_weight: 12 },
    ChestSymbol { id: "trident", triple_x100: 1200, pair_x100: 200, triple_weight: 14 },
    ChestSymbol { id: "nautilus_shell", triple_x100: 800, pair_x100: 160, triple_weight: 16 },
    ChestSymbol { id: "prismarine_crystals", triple_x100: 600, pair_x100: 140, triple_weight: 16 },
    ChestSymbol { id: "prismarine_shard", triple_x100: 400, pair_x100: 120, triple_weight: 14 },
    ChestSymbol { id: "pufferfish", triple_x100: 300, pair_x100: 110, triple_weight: 12 },
    ChestSymbol { id: "tropical_fish", triple_x100: 250, pair_x100: 100, triple_weight: 8 },
];

/// Out of 10 000 spins: 5% three of a kind, 16% a pair, 6% a lone diamond, 73% nothing.
const CHEST_ROLLS: u64 = 10_000;
const CHEST_TRIPLE_ROLLS: u64 = 500;
const CHEST_PAIR_ROLLS: u64 = 1_600;
const CHEST_SINGLE_DIAMOND_ROLLS: u64 = 600;
const CHEST_SINGLE_DIAMOND_X100: i64 = 150;

/// Expected return per coin staked, in ten-thousandths (9180 = 91.8%).
fn chest_rtp_x10000() -> i64 {
    // The weights sum to 100, so the weighted sum of `triple_x100` is already the
    // per-roll expectation scaled by 10 000.
    let triple_worth: i64 = CHEST_SYMBOLS
        .iter()
        .map(|symbol| symbol.triple_weight as i64 * symbol.triple_x100)
        .sum();
    let pair_worth: i64 = CHEST_SYMBOLS.iter().map(|symbol| symbol.pair_x100).sum();
    let total = CHEST_TRIPLE_ROLLS as i64 * triple_worth
        + CHEST_PAIR_ROLLS as i64 * (pair_worth * 100 / CHEST_SYMBOLS.len() as i64)
        + CHEST_SINGLE_DIAMOND_ROLLS as i64 * CHEST_SINGLE_DIAMOND_X100 * 100;
    total / CHEST_ROLLS as i64
}

struct MinesPreset {
    mines: usize,
    /// Reward for opening one cell of each ore, in hundredths of the stake.
    boost_iron: i64,
    boost_gold: i64,
    boost_diamond: i64,
}

// More TNT has to pay more per safe cell, or the harder presets would be a worse
// bet instead of a wilder one. Each preset returns 92.6-92.8% at its first
// cash-out; `minigame_house_margin` proves that no deeper cash-out beats it.
const MINES_PRESETS: [MinesPreset; 4] = [
    MinesPreset { mines: 8, boost_iron: 35, boost_gold: 75, boost_diamond: 210 },
    MinesPreset { mines: 10, boost_iron: 55, boost_gold: 110, boost_diamond: 300 },
    MinesPreset { mines: 13, boost_iron: 104, boost_gold: 208, boost_diamond: 575 },
    MinesPreset { mines: 16, boost_iron: 195, boost_gold: 390, boost_diamond: 1080 },
];

fn mines_preset(mines: i64) -> Option<&'static MinesPreset> {
    MINES_PRESETS.iter().find(|preset| preset.mines as i64 == mines)
}

fn mines_safe_cells(mines: usize) -> usize {
    MINES_CELLS - mines
}

/// How the safe cells are filled: one diamond, roughly 18% gold, the rest iron.
fn mines_ores(mines: usize) -> (usize, usize, usize) {
    let safe = mines_safe_cells(mines);
    let gold = std::cmp::max(2, (safe * 18 + 50) / 100);
    (safe - 1 - gold, gold, 1)
}

fn mines_boost(preset: &MinesPreset, content: &str) -> i64 {
    match content {
        "iron" => preset.boost_iron,
        "gold" => preset.boost_gold,
        "diamond" => preset.boost_diamond,
        _ => 0,
    }
}

/// Return of cashing out at the earliest allowed moment, in ten-thousandths.
/// That is the best a player can do: see `minigame_house_margin`.
fn mines_rtp_x10000(preset: &MinesPreset) -> i64 {
    let safe = mines_safe_cells(preset.mines) as i64;
    let (iron, gold, _diamond) = mines_ores(preset.mines);
    let boost_sum = iron as i64 * preset.boost_iron
        + gold as i64 * preset.boost_gold
        + preset.boost_diamond;
    // Surviving the two reveals: safe/25 then (safe-1)/24. The multiplier is
    // 100 + two average boosts, so multiplying by `safe` keeps it integral.
    let survive = safe * (safe - 1);
    let multiplier = MINES_START_X100 * safe + 2 * boost_sum;
    10_000 * survive * multiplier / (MINES_CELLS as i64 * 24 * 100 * safe)
}

/// 8 bytes of OS randomness. The browser must not be able to predict a reel.
fn random_u64() -> Result<u64, StatusCode> {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(u64::from_le_bytes(bytes))
}

/// Uniform in `0..bound`, by rejection: the accepted range is a whole number of
/// `bound`-sized spans, so no value is more likely than another.
fn random_below(bound: u64) -> Result<u64, StatusCode> {
    if bound == 0 {
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }
    let accepted = u64::MAX - (u64::MAX % bound);
    loop {
        let value = random_u64()?;
        if value < accepted {
            return Ok(value % bound);
        }
    }
}

/// A round id the browser can never choose for a spin it did not buy.
fn new_round_id() -> Result<String, StatusCode> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = hex::encode(bytes);
    Ok(format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32]))
}

struct ChestSpin {
    reels: [&'static str; 3],
    mult_x100: i64,
}

fn spin_chest() -> Result<ChestSpin, StatusCode> {
    let symbols = CHEST_SYMBOLS.len() as u64;
    let roll = random_below(CHEST_ROLLS)?;
    let triple_end = CHEST_TRIPLE_ROLLS;
    let pair_end = triple_end + CHEST_PAIR_ROLLS;
    let diamond_end = pair_end + CHEST_SINGLE_DIAMOND_ROLLS;
    if roll < triple_end {
        let mut pick = random_below(100)? as i64;
        let mut chosen = 0usize;
        for (index, symbol) in CHEST_SYMBOLS.iter().enumerate() {
            pick -= symbol.triple_weight as i64;
            if pick < 0 {
                chosen = index;
                break;
            }
        }
        let id = CHEST_SYMBOLS[chosen].id;
        return Ok(ChestSpin { reels: [id, id, id], mult_x100: CHEST_SYMBOLS[chosen].triple_x100 });
    }
    if roll < pair_end {
        let pair = random_below(symbols)? as usize;
        // The third reel must differ, or this would be three of a kind.
        let mut other = random_below(symbols - 1)? as usize;
        if other >= pair {
            other += 1;
        }
        let (pair_id, other_id) = (CHEST_SYMBOLS[pair].id, CHEST_SYMBOLS[other].id);
        let reels = match random_below(3)? {
            0 => [pair_id, pair_id, other_id],
            1 => [pair_id, other_id, pair_id],
            _ => [other_id, pair_id, pair_id],
        };
        return Ok(ChestSpin { reels, mult_x100: CHEST_SYMBOLS[pair].pair_x100 });
    }
    let non_diamond = |offset: u64| CHEST_SYMBOLS[1 + offset as usize].id;
    if roll < diamond_end {
        // One diamond beside two different treasures: a flat bonus.
        let first = random_below(symbols - 1)?;
        let mut second = random_below(symbols - 1)?;
        while second == first {
            second = random_below(symbols - 1)?;
        }
        let (a, b) = (non_diamond(first), non_diamond(second));
        let diamond = CHEST_SYMBOLS[0].id;
        let reels = match random_below(3)? {
            0 => [diamond, a, b],
            1 => [a, diamond, b],
            _ => [a, b, diamond],
        };
        return Ok(ChestSpin { reels, mult_x100: CHEST_SINGLE_DIAMOND_X100 });
    }
    // No win: three different treasures and no diamond.
    let first = random_below(symbols - 1)?;
    let mut second = random_below(symbols - 1)?;
    while second == first {
        second = random_below(symbols - 1)?;
    }
    let mut third = random_below(symbols - 1)?;
    while third == first || third == second {
        third = random_below(symbols - 1)?;
    }
    Ok(ChestSpin {
        reels: [non_diamond(first), non_diamond(second), non_diamond(third)],
        mult_x100: 0,
    })
}

/// The deal for one Minesweeper round. `board` is the secret: only revealed
/// cells and, once the round is over, the whole field ever leave this table.
#[derive(serde::Serialize, serde::Deserialize)]
struct MinesState {
    mines: i64,
    board: Vec<String>,
    revealed: Vec<usize>,
    mult_x100: i64,
}

fn new_mines_state(preset: &MinesPreset) -> Result<MinesState, StatusCode> {
    let (iron, gold, diamond) = mines_ores(preset.mines);
    let mut board = Vec::with_capacity(MINES_CELLS);
    board.extend(std::iter::repeat_n("tnt".to_owned(), preset.mines));
    board.extend(std::iter::repeat_n("iron".to_owned(), iron));
    board.extend(std::iter::repeat_n("gold".to_owned(), gold));
    board.extend(std::iter::repeat_n("diamond".to_owned(), diamond));
    // Fisher-Yates, or the layout would follow the order above.
    for index in (1..board.len()).rev() {
        let swap = random_below(index as u64 + 1)? as usize;
        board.swap(index, swap);
    }
    Ok(MinesState { mines: preset.mines as i64, board, revealed: Vec::new(), mult_x100: MINES_START_X100 })
}

#[derive(serde::Serialize)]
struct MinigameConfigView {
    min_bet: i64,
    max_bet: i64,
    chest: ChestRulesView,
    mines: MinesRulesView,
}

#[derive(serde::Serialize)]
struct ChestSymbolView {
    id: &'static str,
    triple_x100: i64,
    pair_x100: i64,
}

#[derive(serde::Serialize)]
struct ChestRulesView {
    symbols: Vec<ChestSymbolView>,
    single_diamond_x100: i64,
    triple_chance_x10000: i64,
    pair_chance_x10000: i64,
    single_diamond_chance_x10000: i64,
    rtp_x10000: i64,
}

#[derive(serde::Serialize)]
struct MinesPresetView {
    mines: i64,
    min_safe: i64,
    boost_iron: i64,
    boost_gold: i64,
    boost_diamond: i64,
    rtp_x10000: i64,
}

#[derive(serde::Serialize)]
struct MinesRulesView {
    cells: usize,
    min_safe: i64,
    starting_x100: i64,
    presets: Vec<MinesPresetView>,
}

/// Static rules, so the window renders the very numbers the server pays. Public:
/// it is a paytable, not anybody's data.
async fn minigame_config() -> Json<MinigameConfigView> {
    let chance = |rolls: u64| (rolls * 10_000 / CHEST_ROLLS) as i64;
    Json(MinigameConfigView {
        min_bet: MINIGAME_MIN_BET,
        max_bet: MINIGAME_MAX_BET,
        chest: ChestRulesView {
            symbols: CHEST_SYMBOLS
                .iter()
                .map(|symbol| ChestSymbolView {
                    id: symbol.id,
                    triple_x100: symbol.triple_x100,
                    pair_x100: symbol.pair_x100,
                })
                .collect(),
            single_diamond_x100: CHEST_SINGLE_DIAMOND_X100,
            triple_chance_x10000: chance(CHEST_TRIPLE_ROLLS),
            pair_chance_x10000: chance(CHEST_PAIR_ROLLS),
            single_diamond_chance_x10000: chance(CHEST_SINGLE_DIAMOND_ROLLS),
            rtp_x10000: chest_rtp_x10000(),
        },
        mines: MinesRulesView {
            cells: MINES_CELLS,
            min_safe: MINES_MIN_SAFE,
            starting_x100: MINES_START_X100,
            presets: MINES_PRESETS
                .iter()
                .map(|preset| MinesPresetView {
                    mines: preset.mines as i64,
                    min_safe: MINES_MIN_SAFE,
                    boost_iron: preset.boost_iron,
                    boost_gold: preset.boost_gold,
                    boost_diamond: preset.boost_diamond,
                    rtp_x10000: mines_rtp_x10000(preset),
                })
                .collect(),
        },
    })
}

#[derive(serde::Serialize)]
struct ChestSpinView {
    round_id: String,
    bet: i64,
    reels: Vec<String>,
    multiplier_x100: i64,
    payout: i64,
    balance: i64,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct ChestState {
    reels: Vec<String>,
    mult_x100: i64,
}

#[derive(serde::Serialize)]
struct MinesCellView {
    cell: i64,
    content: String,
}

#[derive(serde::Serialize)]
struct MinesRoundView {
    round_id: String,
    bet: i64,
    mines: i64,
    min_safe: i64,
    multiplier_x100: i64,
    cashout: i64,
    status: String,
    outcome: Option<String>,
    payout: i64,
    balance: i64,
    /// Only cells the player has already opened, plus the whole field once settled.
    revealed: Vec<MinesCellView>,
}

#[derive(serde::Serialize)]
struct MinigameStateView {
    active: Option<MinesRoundView>,
}

#[derive(serde::Deserialize)]
struct ChestSpinRequest {
    uuid: String,
    bet: i64,
    /// The browser's own id for this spin, reused when it retries. Never the round id.
    client_id: String,
}

#[derive(serde::Deserialize)]
struct MinesStartRequest {
    uuid: String,
    bet: i64,
    mines: i64,
}

#[derive(serde::Deserialize)]
struct MinesRevealRequest {
    round_id: String,
    cell: i64,
}

#[derive(serde::Deserialize)]
struct MinesCashoutRequest {
    round_id: String,
}

fn validate_bet(bet: i64) -> Result<i64, StatusCode> {
    if (MINIGAME_MIN_BET..=MINIGAME_MAX_BET).contains(&bet) {
        Ok(bet)
    } else {
        Err(StatusCode::BAD_REQUEST)
    }
}

/// Take a stake out of one player's balance. The `coins >=` guard and the
/// `CHECK (coins >= 0)` on the column mean a balance can never go negative, even
/// with two requests racing; `None` is "not enough coins", never "went negative".
async fn debit_coins(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    uuid: &str,
    amount: i64,
) -> Result<i64, StatusCode> {
    let balance: Option<i64> = sqlx::query_scalar(
        "UPDATE player_stats SET coins = coins - $1 WHERE uuid = $2 AND coins >= $1 RETURNING coins",
    )
    .bind(amount)
    .bind(uuid)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    balance.ok_or(StatusCode::CONFLICT)
}

async fn credit_coins(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    uuid: &str,
    amount: i64,
) -> Result<i64, StatusCode> {
    sqlx::query_scalar("UPDATE player_stats SET coins = coins + $1 WHERE uuid = $2 RETURNING coins")
        .bind(amount)
        .bind(uuid)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)
}

async fn payer_balance(pool: &sqlx::PgPool, uuid: &str) -> Result<i64, StatusCode> {
    let balance: Option<i64> = sqlx::query_scalar("SELECT coins FROM player_stats WHERE uuid = $1")
        .bind(uuid)
        .fetch_optional(pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(balance.unwrap_or(0))
}

/// The Minesweeper round this user already paid for, if any.
async fn active_mines_round(pool: &sqlx::PgPool, user_id: i64) -> Result<Option<StoredRound>, StatusCode> {
    let row = sqlx::query(
        "SELECT id::text AS id, uuid, bet, status, payout, outcome, state::text AS state
           FROM minigame_rounds
          WHERE user_id = $1 AND game = 'minesweeper' AND status = 'active'",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    match row {
        Some(row) => Ok(Some(stored_round(&row)?)),
        None => Ok(None),
    }
}

/// Rounds whose player walked away keep their stake; this settles them so the
/// player can start again. Run before anything that starts a round.
async fn expire_stale_rounds(pool: &sqlx::PgPool, user_id: i64) -> Result<(), StatusCode> {
    sqlx::query(
        "UPDATE minigame_rounds SET status = 'settled', outcome = 'expired', settled_at = now()
         WHERE user_id = $1 AND status = 'active'
           AND created_at < now() - make_interval(secs => $2)",
    )
    .bind(user_id)
    .bind(MINIGAME_ROUND_TTL_SECONDS as f64)
    .execute(pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(())
}

struct StoredRound {
    id: String,
    uuid: String,
    bet: i64,
    status: String,
    payout: i64,
    outcome: Option<String>,
    state: String,
}

impl StoredRound {
    fn mines_state(&self) -> Result<MinesState, StatusCode> {
        serde_json::from_str(&self.state).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
    }
}

fn stored_round(row: &sqlx::postgres::PgRow) -> Result<StoredRound, StatusCode> {
    Ok(StoredRound {
        id: row.try_get("id").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
        uuid: row.try_get("uuid").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
        bet: row.try_get("bet").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
        status: row.try_get("status").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
        payout: row.try_get("payout").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
        outcome: row.try_get("outcome").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
        state: row.try_get("state").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    })
}

fn mines_view(round: &StoredRound, state: &MinesState, balance: i64) -> MinesRoundView {
    // A finished round shows the whole field: there is no secret left to keep and
    // the player should see where the TNT was.
    let settled = round.status == "settled";
    let cells: Vec<usize> = if settled {
        (0..state.board.len()).collect()
    } else {
        state.revealed.clone()
    };
    let revealed = cells
        .into_iter()
        .filter_map(|cell| {
            state
                .board
                .get(cell)
                .map(|content| MinesCellView { cell: cell as i64, content: content.clone() })
        })
        .collect();
    MinesRoundView {
        round_id: round.id.clone(),
        bet: round.bet,
        mines: state.mines,
        min_safe: MINES_MIN_SAFE,
        multiplier_x100: state.mult_x100,
        cashout: round.bet * state.mult_x100 / 100,
        status: round.status.clone(),
        outcome: round.outcome.clone(),
        payout: round.payout,
        balance,
        revealed,
    }
}

/// Lock the caller's own round, or answer 404 for anything else — including a
/// round that belongs to another account, which this must not reveal.
async fn lock_mines_round(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: i64,
    round_id: &str,
) -> Result<StoredRound, StatusCode> {
    let row = sqlx::query(
        "SELECT id::text AS id, uuid, bet, status, payout, outcome, state::text AS state
           FROM minigame_rounds
          WHERE id = $1::uuid AND user_id = $2 AND game = 'minesweeper' FOR UPDATE",
    )
    .bind(round_id)
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .ok_or(StatusCode::NOT_FOUND)?;
    stored_round(&row)
}

async fn settle_round(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    round_id: &str,
    outcome: &str,
    payout: i64,
    state: &MinesState,
) -> Result<(), StatusCode> {
    let state = serde_json::to_string(state).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    sqlx::query(
        "UPDATE minigame_rounds
            SET status = 'settled', outcome = $2, payout = $3, settled_at = now(), state = $4::jsonb
          WHERE id = $1::uuid",
    )
    .bind(round_id)
    .bind(outcome)
    .bind(payout)
    .bind(&state)
    .execute(&mut **tx)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(())
}

async fn return_chest_spin(
    pool: &sqlx::PgPool,
    user_id: i64,
    client_id: &str,
) -> Result<Option<ChestSpinView>, StatusCode> {
    let row = sqlx::query(
        "SELECT r.id::text AS id, r.bet, r.payout, r.state::text AS state,
                COALESCE(ps.coins, 0) AS balance
           FROM minigame_rounds r
           LEFT JOIN player_stats ps ON ps.uuid = r.uuid
          WHERE r.user_id = $1 AND r.client_id = $2::uuid AND r.game = 'lucky_chest'",
    )
    .bind(user_id)
    .bind(client_id)
    .fetch_optional(pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let Some(row) = row else { return Ok(None) };
    let state: String = row.try_get("state").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let state: ChestState =
        serde_json::from_str(&state).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Some(ChestSpinView {
        round_id: row.try_get("id").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
        bet: row.try_get("bet").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
        reels: state.reels,
        multiplier_x100: state.mult_x100,
        payout: row.try_get("payout").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
        balance: row.try_get("balance").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    }))
}

/// One spin, one transaction: the stake leaves the balance, the result is rolled
/// from OS randomness and any win is credited before the client hears about it.
async fn spin_lucky_chest(
    State(pool): State<sqlx::PgPool>,
    SessionUser { user_id }: SessionUser,
    Json(input): Json<ChestSpinRequest>,
) -> Result<Json<ChestSpinView>, StatusCode> {
    let uuid = input.uuid.trim().to_lowercase();
    // 400 for a malformed UUID, 404 when it is not this user's linked account.
    owns_player(&pool, user_id, &uuid).await?;
    let bet = validate_bet(input.bet)?;
    let client_id = input.client_id.trim().to_lowercase();
    if !is_uuid(&client_id) {
        return Err(StatusCode::BAD_REQUEST);
    }
    // A retry after a lost response buys nothing: it returns the spin already paid for.
    if let Some(view) = return_chest_spin(&pool, user_id, &client_id).await? {
        return Ok(Json(view));
    }

    let spin = spin_chest()?;
    let payout = bet * spin.mult_x100 / 100;
    let round_id = new_round_id()?;
    let state = serde_json::to_string(&ChestState {
        reels: spin.reels.iter().map(|reel| (*reel).to_owned()).collect(),
        mult_x100: spin.mult_x100,
    })
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let mut tx = pool.begin().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut balance = debit_coins(&mut tx, &uuid, bet).await?;
    if payout > 0 {
        balance = credit_coins(&mut tx, &uuid, payout).await?;
    }
    let outcome = if payout > 0 { "paid" } else { "lost" };
    // `ON CONFLICT DO NOTHING` keeps a simultaneous duplicate from aborting the
    // transaction, so the rollback below is all that undoes its charge.
    let inserted = sqlx::query(
        "INSERT INTO minigame_rounds
            (id, client_id, user_id, uuid, game, bet, status, payout, outcome, state, settled_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'lucky_chest', $5, 'settled', $6, $7, $8::jsonb, now())
         ON CONFLICT (user_id, client_id) DO NOTHING
         RETURNING id",
    )
    .bind(&round_id)
    .bind(&client_id)
    .bind(user_id)
    .bind(&uuid)
    .bind(bet)
    .bind(payout)
    .bind(outcome)
    .bind(&state)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if inserted.is_none() {
        // The same spin is already being recorded by this user's other request.
        // Nothing was charged here, and `ON CONFLICT DO NOTHING` waited for that
        // request to commit, so the recorded spin is there to return: two tabs
        // pressing once each must not look like a missing balance.
        tx.rollback().await.ok();
        return return_chest_spin(&pool, user_id, &client_id)
            .await?
            .map(Json)
            .ok_or(StatusCode::CONFLICT);
    }
    tx.commit().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(ChestSpinView {
        round_id,
        bet,
        reels: spin.reels.iter().map(|reel| (*reel).to_owned()).collect(),
        multiplier_x100: spin.mult_x100,
        payout,
        balance,
    }))
}

/// Deals a field and takes the stake in one transaction. The board stays in the
/// database: the response says how many TNT there are, never where.
async fn start_mines(
    State(pool): State<sqlx::PgPool>,
    SessionUser { user_id }: SessionUser,
    Json(input): Json<MinesStartRequest>,
) -> Result<Json<MinesRoundView>, StatusCode> {
    let uuid = input.uuid.trim().to_lowercase();
    owns_player(&pool, user_id, &uuid).await?;
    let bet = validate_bet(input.bet)?;
    let preset = mines_preset(input.mines).ok_or(StatusCode::BAD_REQUEST)?;
    expire_stale_rounds(&pool, user_id).await?;
    // Starting twice is a resume, not a second stake: the field already paid for
    // is the one the player gets back.
    if let Some(round) = active_mines_round(&pool, user_id).await? {
        let state = round.mines_state()?;
        let balance = payer_balance(&pool, &round.uuid).await?;
        return Ok(Json(mines_view(&round, &state, balance)));
    }
    let state = new_mines_state(preset)?;
    let round_id = new_round_id()?;
    let stored = serde_json::to_string(&state).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let mut tx = pool.begin().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let balance = debit_coins(&mut tx, &uuid, bet).await?;
    // The partial unique index allows one live round per game, so a second tab
    // resolves to the same round instead of staking money twice.
    let inserted = sqlx::query(
        "INSERT INTO minigame_rounds (id, user_id, uuid, game, bet, state)
         VALUES ($1::uuid, $2, $3, 'minesweeper', $4, $5::jsonb)
         ON CONFLICT DO NOTHING
         RETURNING id",
    )
    .bind(&round_id)
    .bind(user_id)
    .bind(&uuid)
    .bind(bet)
    .bind(&stored)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if inserted.is_none() {
        tx.rollback().await.ok();
        let round = active_mines_round(&pool, user_id)
            .await?
            .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
        let state = round.mines_state()?;
        let balance = payer_balance(&pool, &round.uuid).await?;
        return Ok(Json(mines_view(&round, &state, balance)));
    }
    tx.commit().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let round = StoredRound {
        id: round_id,
        uuid,
        bet,
        status: "active".to_owned(),
        payout: 0,
        outcome: None,
        state: stored,
    };
    Ok(Json(mines_view(&round, &state, balance)))
}

/// Opens one cell. A TNT ends the round, clearing the field pays the whole
/// multiplier, and anything else just raises it.
async fn reveal_mines(
    State(pool): State<sqlx::PgPool>,
    SessionUser { user_id }: SessionUser,
    Json(input): Json<MinesRevealRequest>,
) -> Result<Json<MinesRoundView>, StatusCode> {
    let round_id = input.round_id.trim().to_lowercase();
    if !is_uuid(&round_id) {
        return Err(StatusCode::BAD_REQUEST);
    }
    if !(0..MINES_CELLS as i64).contains(&input.cell) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let cell = input.cell as usize;

    let mut tx = pool.begin().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut round = lock_mines_round(&mut tx, user_id, &round_id).await?;
    let mut state = round.mines_state()?;
    if round.status == "settled" || state.revealed.contains(&cell) {
        // A retried reveal is not a second reveal, and a settled round cannot change.
        tx.commit().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let balance = payer_balance(&pool, &round.uuid).await?;
        return Ok(Json(mines_view(&round, &state, balance)));
    }

    let content = state.board.get(cell).cloned().ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    state.revealed.push(cell);
    let balance = if content == "tnt" {
        round.status = "settled".to_owned();
        round.outcome = Some("lost".to_owned());
        round.payout = 0;
        // Nothing is credited: the stake was taken when the round started.
        settle_round(&mut tx, &round_id, "lost", 0, &state).await?;
        payer_balance(&pool, &round.uuid).await?
    } else {
        let preset = mines_preset(state.mines).ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
        state.mult_x100 += mines_boost(preset, &content);
        if state.revealed.len() >= mines_safe_cells(state.mines as usize) {
            // Nothing left to find: the round pays out rather than waiting for a click.
            let payout = round.bet * state.mult_x100 / 100;
            round.status = "settled".to_owned();
            round.outcome = Some("paid".to_owned());
            round.payout = payout;
            let balance = credit_coins(&mut tx, &round.uuid, payout).await?;
            settle_round(&mut tx, &round_id, "paid", payout, &state).await?;
            balance
        } else {
            let stored =
                serde_json::to_string(&state).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            sqlx::query("UPDATE minigame_rounds SET state = $2::jsonb WHERE id = $1::uuid")
                .bind(&round_id)
                .bind(&stored)
                .execute(&mut *tx)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            payer_balance(&pool, &round.uuid).await?
        }
    };
    tx.commit().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(mines_view(&round, &state, balance)))
}

/// Takes the accumulated multiplier. Repeating it after a success returns the
/// same settled round and never pays twice.
async fn cash_out_mines(
    State(pool): State<sqlx::PgPool>,
    SessionUser { user_id }: SessionUser,
    Json(input): Json<MinesCashoutRequest>,
) -> Result<Json<MinesRoundView>, StatusCode> {
    let round_id = input.round_id.trim().to_lowercase();
    if !is_uuid(&round_id) {
        return Err(StatusCode::BAD_REQUEST);
    }

    let mut tx = pool.begin().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut round = lock_mines_round(&mut tx, user_id, &round_id).await?;
    let state = round.mines_state()?;
    if round.status == "settled" {
        tx.commit().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let balance = payer_balance(&pool, &round.uuid).await?;
        return Ok(Json(mines_view(&round, &state, balance)));
    }
    if (state.revealed.len() as i64) < MINES_MIN_SAFE {
        return Err(StatusCode::BAD_REQUEST);
    }
    let payout = round.bet * state.mult_x100 / 100;
    round.status = "settled".to_owned();
    round.outcome = Some("paid".to_owned());
    round.payout = payout;
    let balance = credit_coins(&mut tx, &round.uuid, payout).await?;
    settle_round(&mut tx, &round_id, "paid", payout, &state).await?;
    tx.commit().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(mines_view(&round, &state, balance)))
}

/// The live round, so a reload resumes the field it was already charged for.
async fn minigame_state(
    State(pool): State<sqlx::PgPool>,
    SessionUser { user_id }: SessionUser,
) -> Result<Json<MinigameStateView>, StatusCode> {
    expire_stale_rounds(&pool, user_id).await?;
    let Some(round) = active_mines_round(&pool, user_id).await? else {
        return Ok(Json(MinigameStateView { active: None }));
    };
    let state = round.mines_state()?;
    let balance = payer_balance(&pool, &round.uuid).await?;
    Ok(Json(MinigameStateView { active: Some(mines_view(&round, &state, balance)) }))
}

// --- Player skins ----------------------------------------------------------

const MAX_SKIN_BYTES: usize = 256 * 1024;

async fn owns_player(pool: &sqlx::PgPool, user_id: i64, uuid: &str) -> Result<(), StatusCode> {
    if !is_uuid(uuid) { return Err(StatusCode::BAD_REQUEST); }
    let found: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM minecraft_accounts WHERE user_id=$1 AND uuid=$2)")
        .bind(user_id).bind(uuid).fetch_one(pool).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if found { Ok(()) } else { Err(StatusCode::NOT_FOUND) }
}

#[derive(serde::Serialize)]
struct SkinView {
    texture_hash: Option<String>,
    model: String,
    observed_at: Option<String>,
    upload: Option<SkinUploadView>,
}
#[derive(serde::Serialize)]
struct SkinUploadView { status: String, error: Option<String> }

async fn player_skin(
    State(pool): State<sqlx::PgPool>, SessionUser { user_id }: SessionUser, Path(uuid): Path<String>,
) -> Result<impl IntoResponse, StatusCode> {
    let uuid = uuid.to_lowercase();
    owns_player(&pool, user_id, &uuid).await?;
    let row = sqlx::query("SELECT s.texture_hash, COALESCE(s.model,'classic') AS model, s.observed_at::text AS observed_at, u.status, u.error
        FROM minecraft_accounts ma LEFT JOIN player_skins s ON s.uuid=ma.uuid LEFT JOIN skin_uploads u ON u.uuid=ma.uuid
        WHERE ma.user_id=$1 AND ma.uuid=$2")
        .bind(user_id).bind(&uuid).fetch_optional(&pool).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    let status: Option<String> = row.get("status");
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(SkinView {
        texture_hash: row.get("texture_hash"), model: row.get("model"), observed_at: row.get("observed_at"),
        upload: status.map(|status| SkinUploadView { status, error: row.get("error") }),
    })))
}

/// Decode the complete PNG under a strict pixel budget; strip metadata before
/// sending it to the signing service. A forged header alone is never sufficient.
fn clean_skin_png(bytes: &[u8]) -> Result<Vec<u8>, StatusCode> {
    if bytes.is_empty() || bytes.len() > MAX_SKIN_BYTES { return Err(StatusCode::BAD_REQUEST); }
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_limits(png::Limits { bytes: 128 * 1024 });
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|_| StatusCode::BAD_REQUEST)?;
    if reader.info().width != 64 || ![32,64].contains(&reader.info().height) || reader.info().animation_control.is_some() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut buffer = vec![0; reader.output_buffer_size().ok_or(StatusCode::BAD_REQUEST)?];
    let frame = reader.next_frame(&mut buffer).map_err(|_| StatusCode::BAD_REQUEST)?;
    let mut output = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut output, frame.width, frame.height);
        encoder.set_color(frame.color_type);
        encoder.set_depth(frame.bit_depth);
        let mut writer = encoder.write_header().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        writer.write_image_data(&buffer[..frame.buffer_size()]).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    Ok(output)
}

async fn upload_player_skin(
    State(pool): State<sqlx::PgPool>, SessionUser { user_id }: SessionUser, Path(uuid): Path<String>,
    headers: HeaderMap, mut multipart: axum::extract::Multipart,
) -> Result<impl IntoResponse, StatusCode> {
    // A same-origin browser request must carry this non-simple header. Cross-site
    // forms cannot set it, and the API deliberately provides no CORS permission.
    if headers.get("x-player-skin").and_then(|v| v.to_str().ok()) != Some("upload") { return Err(StatusCode::BAD_REQUEST); }
    let uuid = uuid.to_lowercase();
    owns_player(&pool, user_id, &uuid).await?;
    let mut image = None;
    let mut model = None;
    while let Some(field) = multipart.next_field().await.map_err(|_| StatusCode::BAD_REQUEST)? {
        match field.name() {
            Some("file") if image.is_none() => {
                let bytes = field.bytes().await.map_err(|_| StatusCode::BAD_REQUEST)?;
                image = Some(clean_skin_png(&bytes)?);
            }
            Some("model") if model.is_none() => { model = Some(field.text().await.map_err(|_| StatusCode::BAD_REQUEST)?); }
            _ => return Err(StatusCode::BAD_REQUEST),
        }
    }
    let image = image.ok_or(StatusCode::BAD_REQUEST)?;
    let model = model.filter(|v| matches!(v.as_str(), "classic" | "slim")).ok_or(StatusCode::BAD_REQUEST)?;
    let mut random = [0u8; 24];
    getrandom::fill(&mut random).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    // Serialize uploads/unlinking on the ownership row, then recheck ownership.
    let mut tx = pool.begin().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let owner = sqlx::query("SELECT uuid FROM minecraft_accounts WHERE user_id=$1 AND uuid=$2 FOR UPDATE")
        .bind(user_id).bind(&uuid).fetch_optional(&mut *tx).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if owner.is_none() { return Err(StatusCode::NOT_FOUND); }
    let previous = sqlx::query("SELECT status, created_at > NOW()-INTERVAL '30 seconds' AS recent FROM skin_uploads WHERE uuid=$1")
        .bind(&uuid).fetch_optional(&mut *tx).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if let Some(row) = previous {
        let status: String = row.get("status");
        if matches!(status.as_str(), "queued" | "signing" | "ready") { return Err(StatusCode::CONFLICT); }
        if row.get::<bool, _>("recent") { return Err(StatusCode::TOO_MANY_REQUESTS); }
    }
    sqlx::query("INSERT INTO skin_uploads(uuid,request_id,png,model,status) VALUES($1,$2,$3,$4,'queued')
        ON CONFLICT(uuid) DO UPDATE SET request_id=EXCLUDED.request_id,png=EXCLUDED.png,model=EXCLUDED.model,
        job_id=NULL,status='queued',value=NULL,signature=NULL,error=NULL,created_at=NOW(),updated_at=NOW()")
        .bind(uuid).bind(hex::encode(random)).bind(image).bind(model).execute(&mut *tx).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    tx.commit().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok((StatusCode::ACCEPTED, [(header::CACHE_CONTROL, "no-store")]))
}

fn valid_texture_hash(hash: &str) -> bool {
    (32..=64).contains(&hash.len()) && hash.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn texture_from_property(value: &str) -> Option<(String, String)> {
    use base64::Engine;
    if value.len() > 16384 { return None; }
    let decoded = base64::engine::general_purpose::STANDARD.decode(value).ok()?;
    let profile: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    let skin = &profile["textures"]["SKIN"];
    let url = skin["url"].as_str()?;
    let hash = url.strip_prefix("https://textures.minecraft.net/texture/")
        .or_else(|| url.strip_prefix("http://textures.minecraft.net/texture/"))?;
    if !valid_texture_hash(hash) { return None; }
    let model = if skin["metadata"]["model"].as_str() == Some("slim") { "slim" } else { "classic" };
    Some((hash.to_owned(), model.to_owned()))
}

async fn skin_signing_worker(pool: sqlx::PgPool) {
    let Ok(client) = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none()).user_agent("MinecraftPanel/1.0 (player skin upload)").build() else { return; };
    loop {
        if let Err(error) = process_skin_upload(&pool, &client).await { eprintln!("Skin upload worker: {error}"); }
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    }
}

async fn process_skin_upload(pool: &sqlx::PgPool, client: &reqwest::Client) -> Result<(), sqlx::Error> {
    // Requests survive an app restart. Only one worker owns the signing queue
    // across app replicas; a lost HTTP response can safely re-submit the PNG.
    let mut connection = pool.acquire().await?;
    let locked: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock(783491)").fetch_one(&mut *connection).await?;
    if !locked { return Ok(()); }
    let result = process_skin_upload_locked(pool, client).await;
    sqlx::query("SELECT pg_advisory_unlock(783491)").execute(&mut *connection).await?;
    result
}

/// A service error page must not turn into an unbounded in-memory JSON body.
async fn skin_provider_json(mut response: reqwest::Response) -> Option<serde_json::Value> {
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if bytes.len() + chunk.len() <= 128 * 1024 => bytes.extend_from_slice(&chunk),
            Ok(None) => break,
            _ => return None,
        }
    }
    serde_json::from_slice(&bytes).ok()
}

async fn process_skin_upload_locked(pool: &sqlx::PgPool, client: &reqwest::Client) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE skin_uploads SET status='failed',png=NULL,error='Skin signing timed out. Please upload again.',updated_at=NOW()
        WHERE status IN ('queued','signing') AND created_at < NOW()-INTERVAL '10 minutes'").execute(pool).await?;
    let Some(row) = sqlx::query("SELECT * FROM skin_uploads WHERE status IN ('queued','signing') AND updated_at <= NOW() ORDER BY updated_at LIMIT 1").fetch_optional(pool).await? else { return Ok(()); };
    let request_id: String = row.get("request_id");
    sqlx::query("UPDATE skin_uploads SET updated_at=NOW()+INTERVAL '15 seconds' WHERE request_id=$1")
        .bind(&request_id).execute(pool).await?;
    let job_id: Option<String> = row.get("job_id");
    let key = std::env::var("MINESKIN_API_KEY").unwrap_or_default();
    let request = if let Some(job_id) = job_id {
        if job_id.is_empty() || !job_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') { return Ok(()); }
        client.get(format!("https://api.mineskin.org/v2/queue/{job_id}"))
    } else {
        let png: Vec<u8> = row.get("png");
        let model: String = row.get("model");
        let part = reqwest::multipart::Part::bytes(png).file_name("skin.png").mime_str("image/png").expect("constant PNG type");
        client.post("https://api.mineskin.org/v2/queue").multipart(reqwest::multipart::Form::new()
            .part("file", part).text("variant", model).text("visibility", "unlisted"))
    };
    let request = if key.trim().is_empty() { request } else { request.bearer_auth(key.trim()) };
    let Ok(response) = request.send().await else { return Ok(()); };
    let status = response.status();
    if status.as_u16() == 429 {
        let delay = response.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<i32>().ok()).unwrap_or(60).clamp(15, 600);
        sqlx::query("UPDATE skin_uploads SET updated_at=NOW()+make_interval(secs => $2::double precision) WHERE request_id=$1")
            .bind(&request_id).bind(delay as f64).execute(pool).await?;
        return Ok(());
    }
    if status.is_server_error() { return Ok(()); }
    let Some(data) = skin_provider_json(response).await else { return Ok(()); };
    if !status.is_success() || data["success"] == false || data["job"]["status"] == "failed" {
        sqlx::query("UPDATE skin_uploads SET status='failed',png=NULL,error='The skin service could not process this image. Please try again.',updated_at=NOW() WHERE request_id=$1")
            .bind(&request_id).execute(pool).await?;
        return Ok(());
    }
    // Completed queue responses normally include the signed property. A result
    // ID without it is fetched from the skin endpoint on the next iteration.
    let mut data = data;
    if !data["skin"].is_object() && data["job"]["status"] == "completed" {
        if let Some(id) = data["job"]["result"].as_str().filter(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')) {
            let mut request = client.get(format!("https://api.mineskin.org/v2/skins/{id}"));
            if !key.trim().is_empty() { request = request.bearer_auth(key.trim()); }
            if let Ok(response) = request.send().await {
                if response.status().is_success() {
                    if let Some(result) = skin_provider_json(response).await { data = result; }
                }
            }
        }
    }
    let value = data["skin"]["texture"]["data"]["value"].as_str();
    let signature = data["skin"]["texture"]["data"]["signature"].as_str();
    if let (Some(value), Some(signature)) = (value, signature) {
        if texture_from_property(value).is_some() && !signature.is_empty() && signature.len() <= 8192 {
            sqlx::query("UPDATE skin_uploads SET status='ready',value=$2,signature=$3,png=NULL,error=NULL,updated_at=NOW() WHERE request_id=$1")
                .bind(&request_id).bind(value).bind(signature).execute(pool).await?;
            return Ok(());
        }
    }
    if let Some(id) = data["job"]["id"].as_str().filter(|id| !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')) {
        sqlx::query("UPDATE skin_uploads SET status='signing',job_id=$2,updated_at=NOW() WHERE request_id=$1")
            .bind(&request_id).bind(id).execute(pool).await?;
    }
    Ok(())
}

#[derive(serde::Serialize)]
struct SkinSyncTask { uuid: String, username: String, request_id: Option<String>, value: Option<String>, signature: Option<String> }

async fn sync_player_skins(State(pool): State<sqlx::PgPool>, headers: HeaderMap) -> Result<Json<Vec<SkinSyncTask>>, StatusCode> {
    require_service_token(&headers)?;
    let mut tx = pool.begin().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let rows = sqlx::query("SELECT ma.uuid,ma.username,u.request_id,u.value,u.signature FROM minecraft_accounts ma
        LEFT JOIN player_skins s ON s.uuid=ma.uuid LEFT JOIN skin_uploads u ON u.uuid=ma.uuid AND u.status='ready'
        ORDER BY s.checked_at NULLS FIRST, ma.uuid LIMIT 25 FOR UPDATE OF ma SKIP LOCKED")
        .fetch_all(&mut *tx).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut tasks = Vec::new();
    for row in rows {
        let uuid: String = row.get("uuid");
        sqlx::query("INSERT INTO player_skins(uuid,checked_at) VALUES($1,NOW()) ON CONFLICT(uuid) DO UPDATE SET checked_at=NOW()")
            .bind(&uuid).execute(&mut *tx).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        tasks.push(SkinSyncTask { uuid, username: row.get("username"), request_id: row.get("request_id"), value: row.get("value"), signature: row.get("signature") });
    }
    tx.commit().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(tasks))
}

#[derive(serde::Deserialize)]
struct SkinReport { uuid: String, value: Option<String>, request_id: Option<String> }

async fn report_player_skin(State(pool): State<sqlx::PgPool>, headers: HeaderMap, Json(report): Json<SkinReport>) -> Result<StatusCode, StatusCode> {
    require_service_token(&headers)?;
    let uuid = report.uuid.to_lowercase();
    if !is_uuid(&uuid) { return Err(StatusCode::BAD_REQUEST); }
    let texture = match report.value.as_deref() {
        Some(value) => Some(texture_from_property(value).ok_or(StatusCode::BAD_REQUEST)?),
        None => None,
    };
    let mut tx = pool.begin().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    // Do not let an old acknowledgement turn a newer upload into "saved".
    if let Some(request_id) = report.request_id {
        let updated = sqlx::query("UPDATE skin_uploads SET status='saved',updated_at=NOW() WHERE uuid=$1 AND request_id=$2 AND status IN ('ready','saved') AND value=$3")
            .bind(&uuid).bind(request_id).bind(&report.value).execute(&mut *tx).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if updated.rows_affected() == 0 { return Err(StatusCode::CONFLICT); }
    }
    sqlx::query("INSERT INTO player_skins(uuid,texture_hash,model,observed_at,checked_at) VALUES($1,$2,$3,NOW(),NOW())
        ON CONFLICT(uuid) DO UPDATE SET texture_hash=EXCLUDED.texture_hash,model=EXCLUDED.model,observed_at=NOW(),checked_at=NOW()")
        .bind(uuid).bind(texture.as_ref().map(|(hash,_)| hash)).bind(texture.map(|(_,model)| model).unwrap_or_else(|| "classic".to_owned()))
        .execute(&mut *tx).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    tx.commit().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
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
        let response = post_json_response(pool, "/api/register", serde_json::json!({
            "displayed_nickname": displayed_nickname, "login": login, "email": email, "password": password,
        })).await?;
        if response.status() != StatusCode::ACCEPTED { return Ok(response.status()); }
        let body = body_json(response).await?;
        let challenge = body["challenge"].as_str().ok_or("missing signup challenge")?;
        // Existing account tests need a confirmed fixture. Install a known code
        // only in this database fixture; production never exposes plaintext codes.
        sqlx::query("UPDATE pending_registrations SET code_hash = $1 WHERE challenge_hash = $2")
            .bind(hash_token(&format!("{challenge}:123456"))).bind(hash_token(challenge)).execute(pool).await?;
        let status = post_json(pool, "/api/register/confirm", serde_json::json!({"challenge": challenge, "code": "123456"})).await?;
        sqlx::query("DELETE FROM auth_rate_limits WHERE scope = 'register_email' AND subject = $1")
            .bind(hash_token(&email.to_lowercase())).execute(pool).await?;
        Ok(status)
    }

    async fn pending_signup(pool: &sqlx::PgPool, email: &str, login: &str) -> Result<String, Box<dyn std::error::Error>> {
        let response = post_json_response(pool, "/api/register", serde_json::json!({
            "displayed_nickname": "Test", "login": login, "email": email, "password": "signup-password",
        })).await?;
        if response.status() != StatusCode::ACCEPTED { return Err(format!("signup returned {}", response.status()).into()); }
        let body = body_json(response).await?;
        let challenge = body["challenge"].as_str().ok_or("missing signup challenge")?.to_owned();
        sqlx::query("UPDATE pending_registrations SET code_hash = $1 WHERE challenge_hash = $2")
            .bind(hash_token(&format!("{challenge}:123456"))).bind(hash_token(&challenge)).execute(pool).await?;
        Ok(challenge)
    }

    async fn clean_signup(pool: &sqlx::PgPool, email: &str) -> TestResult {
        sqlx::query("DELETE FROM pending_registrations WHERE email = $1").bind(email.to_lowercase()).execute(pool).await?;
        sqlx::query("DELETE FROM users WHERE email = $1").bind(email.to_lowercase()).execute(pool).await?;
        sqlx::query("DELETE FROM auth_rate_limits WHERE scope = 'register_email' AND subject = $1")
            .bind(hash_token(&email.to_lowercase())).execute(pool).await?;
        Ok(())
    }

    async fn confirm_signup(pool: &sqlx::PgPool, challenge: &str, code: &str) -> Result<StatusCode, Box<dyn std::error::Error>> {
        post_json(pool, "/api/register/confirm", serde_json::json!({"challenge": challenge, "code": code})).await
    }

    #[tokio::test]
    async fn registration_only_creates_a_verified_account_after_one_confirmation() -> TestResult {
        let pool = connect().await?;
        let id = random_id().to_lowercase();
        let email = format!("test_{id}@example.com");
        let result: Result<_, Box<dyn std::error::Error>> = async {
            let challenge = pending_signup(&pool, &email, &id).await?;
            let before = login_request(&pool, &email, "signup-password").await?;
            let ttl: bool = sqlx::query_scalar("SELECT expires_at - created_at = interval '15 minutes' FROM pending_registrations WHERE email = $1")
                .bind(&email).fetch_one(&pool).await?;
            let (a, b) = tokio::join!(confirm_signup(&pool, &challenge, "123456"), confirm_signup(&pool, &challenge, "123456"));
            let verified: bool = sqlx::query_scalar("SELECT email_verified_at IS NOT NULL FROM users WHERE email = $1")
                .bind(&email).fetch_one(&pool).await?;
            let after = login_request(&pool, &email, "signup-password").await?;
            let replay = confirm_signup(&pool, &challenge, "123456").await?;
            Ok((before, ttl, a?, b?, verified, after, replay))
        }.await;
        clean_signup(&pool, &email).await?;
        let (before, ttl, a, b, verified, after, replay) = result?;
        assert_eq!(before, StatusCode::UNAUTHORIZED);
        assert!(ttl && verified);
        assert!((a == StatusCode::CREATED && b == StatusCode::BAD_REQUEST) || (b == StatusCode::CREATED && a == StatusCode::BAD_REQUEST));
        assert_eq!(after, StatusCode::OK);
        assert_eq!(replay, StatusCode::BAD_REQUEST);
        Ok(())
    }

    #[tokio::test]
    async fn registration_codes_expire_and_lock_after_five_wrong_attempts() -> TestResult {
        let pool = connect().await?;
        let id = random_id().to_lowercase();
        let email = format!("test_{id}@example.com");
        let result: Result<_, Box<dyn std::error::Error>> = async {
            let challenge = pending_signup(&pool, &email, &id).await?;
            let mut statuses = Vec::new();
            for _ in 0..5 { statuses.push(confirm_signup(&pool, &challenge, "654321").await?); }
            let locked = confirm_signup(&pool, &challenge, "123456").await?;
            sqlx::query("UPDATE pending_registrations SET failed_attempts = 0, expires_at = now() - interval '1 second' WHERE email = $1")
                .bind(&email).execute(&pool).await?;
            let expired = confirm_signup(&pool, &challenge, "123456").await?;
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE email = $1").bind(&email).fetch_one(&pool).await?;
            Ok((statuses, locked, expired, count))
        }.await;
        clean_signup(&pool, &email).await?;
        let (statuses, locked, expired, count) = result?;
        assert!(statuses.iter().all(|s| *s == StatusCode::BAD_REQUEST));
        assert_eq!((locked, expired, count), (StatusCode::BAD_REQUEST, StatusCode::BAD_REQUEST, 0));
        Ok(())
    }

    #[tokio::test]
    async fn registration_resends_are_limited_and_invalidate_the_old_challenge() -> TestResult {
        let pool = connect().await?;
        let id = random_id().to_lowercase();
        let email = format!("test_{id}@example.com");
        let result: Result<_, Box<dyn std::error::Error>> = async {
            let old = pending_signup(&pool, &email, &id).await?;
            let early = post_json(&pool, "/api/register", serde_json::json!({"displayed_nickname":"Test", "login":id, "email":email, "password":"signup-password"})).await?;
            sqlx::query("UPDATE pending_registrations SET created_at = now() - interval '61 seconds' WHERE email = $1").bind(&email).execute(&pool).await?;
            let new = pending_signup(&pool, &email, &id).await?;
            let invalid = confirm_signup(&pool, &old, "123456").await?;
            let accepted = confirm_signup(&pool, &new, "123456").await?;
            Ok((early, old, new, invalid, accepted))
        }.await;
        clean_signup(&pool, &email).await?;
        let (early, old, new, invalid, accepted) = result?;
        assert_eq!(early, StatusCode::TOO_MANY_REQUESTS);
        assert_ne!(old, new);
        assert_eq!((invalid, accepted), (StatusCode::BAD_REQUEST, StatusCode::CREATED));
        Ok(())
    }

    #[tokio::test]
    async fn pending_signups_cannot_overwrite_a_confirmed_login() -> TestResult {
        let pool = connect().await?;
        let id = random_id().to_lowercase();
        let email = format!("test_{id}@example.com");
        let other = format!("test_other_{id}@example.com");
        let result: Result<_, Box<dyn std::error::Error>> = async {
            let a = pending_signup(&pool, &email, &id).await?;
            let b = pending_signup(&pool, &other, &id).await?;
            let first = confirm_signup(&pool, &a, "123456").await?;
            let second = confirm_signup(&pool, &b, "123456").await?;
            Ok((first, second))
        }.await;
        clean_signup(&pool, &email).await?;
        clean_signup(&pool, &other).await?;
        assert_eq!(result?, (StatusCode::CREATED, StatusCode::CONFLICT));
        Ok(())
    }

    #[tokio::test]
    async fn registration_mailbox_budget_rejects_without_leaving_a_pending_account() -> TestResult {
        let pool = connect().await?;
        let id = random_id().to_lowercase();
        let email = format!("test_{id}@example.com");
        let result: Result<_, Box<dyn std::error::Error>> = async {
            for _ in 0..5 { ip_limit_exceeded(&pool, "register_email", 5, 3600, &hash_token(&email)).await?; }
            let status = post_json(&pool, "/api/register", serde_json::json!({"displayed_nickname":"Test", "login":id, "email":email, "password":"signup-password"})).await?;
            let pending: i64 = sqlx::query_scalar("SELECT count(*) FROM pending_registrations WHERE email = $1").bind(&email).fetch_one(&pool).await?;
            Ok((status, pending))
        }.await;
        clean_signup(&pool, &email).await?;
        assert_eq!(result?, (StatusCode::TOO_MANY_REQUESTS, 0));
        Ok(())
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

    // A fixed rate-limit window can roll over in the middle of a burst: the
    // counter resets and the limiter looks asleep. Every burst test starts with
    // enough of the window left that its few requests cannot straddle a
    // boundary — otherwise the suite fails rarely and only under load.
    async fn wait_for_fresh_rate_window(window_seconds: i64) {
        const HEADROOM_SECONDS: i64 = 15;
        while window_seconds - (now_unix() % window_seconds) <= HEADROOM_SECONDS {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
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
        let six = register_request(&pool, "Test",
            &login,
            &email,
            "6chars"
        ).await?;
        let five = register_request(&pool, "Test",
            &login,
            &email,
            "5char"
        ).await?;
        sqlx::query("DELETE FROM users WHERE email= $1").bind(&email).execute(&pool).await?;
        assert_eq!(six, StatusCode::CREATED);
        assert_eq!(five, StatusCode::BAD_REQUEST);
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
    async fn login_name_is_normalized_and_creates_the_correct_session() -> TestResult {
        let pool = connect().await?;
        let id = random_id().to_lowercase();
        let email = format!("test_{id}@example.com");
        let login = format!("player_{id}@realm");
        let result: TestResult = async {
            let registered = register_request(&pool, "Test", &login, &email, "test-password").await?;
            let wrong = login_request(&pool, &login, "wrong-password").await?;
            let response = post_json_response(&pool, "/api/login", serde_json::json!({
                "identifier": format!("  {}  ", login.to_uppercase()), "password": "test-password"
            })).await?;
            let cookie = session_cookie_from(&response).unwrap_or_default();
            let me = send(&pool, "GET", "/api/me", Some(&cookie), None).await?;
            let body = body_json(me).await?;
            let failures: i64 = sqlx::query_scalar("SELECT count(*) FROM login_failures WHERE email = $1")
                .bind(&email).fetch_one(&pool).await?;
            delete_user(&pool, &email).await?;
            assert_eq!(registered, StatusCode::CREATED);
            assert_eq!(wrong, StatusCode::UNAUTHORIZED);
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(body["email"], email);
            assert_eq!(failures, 0);
            Ok(())
        }.await;
        delete_user(&pool, &email).await?;
        result
    }

    #[tokio::test]
    async fn login_and_email_share_account_lockout() -> TestResult {
        let pool = connect().await?;
        let id = random_id().to_lowercase();
        let email = format!("test_{id}@example.com");
        let login = format!("player_{id}");
        register_request(&pool, "Test", &login, &email, "test-password").await?;
        let result: TestResult = async {
            let mut statuses = Vec::new();
            for attempt in 0..lockout_threshold() {
                let identifier = if attempt % 2 == 0 { &email } else { &login };
                statuses.push(login_from(&pool, identifier, "wrong-password", &random_ip()).await?);
            }
            let by_email = login_from(&pool, &email, "test-password", &random_ip()).await?;
            let by_login = login_from(&pool, &login, "test-password", &random_ip()).await?;
            delete_user(&pool, &email).await?;
            assert!(statuses.iter().all(|status| *status == StatusCode::UNAUTHORIZED));
            assert_eq!(by_email, StatusCode::UNAUTHORIZED);
            assert_eq!(by_login, StatusCode::UNAUTHORIZED);
            Ok(())
        }.await;
        delete_user(&pool, &email).await?;
        result
    }

    #[tokio::test]
    async fn email_match_wins_over_another_accounts_login() -> TestResult {
        let pool = connect().await?;
        let id = random_id().to_lowercase();
        let email = format!("test_{id}@realm");
        let other_email = format!("other_{id}@example.com");
        let result: TestResult = async {
            register_request(&pool, "Test", &id, &email, "first-password").await?;
            register_request(&pool, "Other", &email, &other_email, "second-password").await?;
            let first = login_request(&pool, &email, "first-password").await?;
            let second = login_request(&pool, &email, "second-password").await?;
            let other = login_request(&pool, &other_email, "second-password").await?;
            delete_user(&pool, &email).await?;
            delete_user(&pool, &other_email).await?;
            assert_eq!(first, StatusCode::OK);
            assert_eq!(second, StatusCode::UNAUTHORIZED);
            assert_eq!(other, StatusCode::OK);
            Ok(())
        }.await;
        delete_user(&pool, &email).await?;
        delete_user(&pool, &other_email).await?;
        result
    }

    #[tokio::test]
    async fn login_rejects_malformed_or_ambiguous_payloads_without_a_cookie() -> TestResult {
        let pool = connect().await?;
        for payload in [
            serde_json::json!({}),
            serde_json::json!({"identifier": "player"}),
            serde_json::json!({"password": "secret"}),
            serde_json::json!({"identifier": null, "password": "secret"}),
            serde_json::json!({"identifier": 123, "password": "secret"}),
            serde_json::json!({"identifier": "player", "password": null}),
            serde_json::json!({"identifier": "player", "email": "other@example.com", "password": "secret"}),
        ] {
            let response = post_json_response(&pool, "/api/login", payload.clone()).await?;
            assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY, "{payload}");
            assert!(session_cookie_from(&response).is_none());
        }
        Ok(())
    }

    #[tokio::test]
    async fn login_unknown_or_blank_identifiers_create_no_credentials_or_failures() -> TestResult {
        let pool = connect().await?;
        let id = random_id().to_lowercase();
        for identifier in [String::new(), " \t\n ".to_owned(), format!("missing_{id}"), format!("missing_{id}@example.com")] {
            let response = post_json_response(&pool, "/api/login", serde_json::json!({
                "identifier": identifier, "password": "test-password"
            })).await?;
            let status = response.status();
            let cookie = session_cookie_from(&response);
            let body = axum::body::to_bytes(response.into_body(), 1024).await?;
            let tracked: i64 = sqlx::query_scalar("SELECT count(*) FROM login_failures WHERE email = $1")
                .bind(identifier.trim()).fetch_one(&pool).await?;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
            assert!(cookie.is_none());
            assert!(body.is_empty(), "unknown identifiers must not disclose account details");
            assert_eq!(tracked, 0);
        }
        Ok(())
    }

    #[tokio::test]
    async fn login_accepts_both_payload_names_without_normalizing_the_password() -> TestResult {
        let pool = connect().await?;
        let id = random_id().to_lowercase();
        let email = format!("test_{id}@example.com");
        let login = format!("player_!@{id}");
        let result: Result<_, Box<dyn std::error::Error>> = async {
            register_request(&pool, "Test", &login, &email, "  MixedCase-password  ").await?;
            let mut observations = Vec::new();
            for field in ["identifier", "email"] {
                for value in [&email, &login] {
                    let mut payload = serde_json::json!({"password": "  MixedCase-password  "});
                    payload[field] = serde_json::json!(format!(" \t{}\n ", value.to_uppercase()));
                    let response = post_json_response(&pool, "/api/login", payload).await?;
                    let cookie = session_cookie_from(&response);
                    let me = get_with_cookie(&pool, "/api/me", cookie.as_deref()).await?;
                    observations.push((response.status(), me.status(), body_json(me).await?));
                }
            }
            let trimmed = login_request(&pool, &login, "MixedCase-password").await?;
            let lowercased = login_request(&pool, &email, "  mixedcase-password  ").await?;
            Ok((observations, trimmed, lowercased))
        }.await;
        delete_user(&pool, &email).await?;
        let (observations, trimmed, lowercased) = result?;
        for (status, me_status, body) in observations {
            assert_eq!(status, StatusCode::OK);
            assert_eq!(me_status, StatusCode::OK);
            assert_eq!(body["email"], email);
            assert_eq!(body["login_displayed"], login);
        }
        assert_eq!(trimmed, StatusCode::UNAUTHORIZED);
        assert_eq!(lowercased, StatusCode::UNAUTHORIZED);
        Ok(())
    }

    #[tokio::test]
    async fn login_success_resets_failures_from_either_identifier() -> TestResult {
        let pool = connect().await?;
        let id = random_id().to_lowercase();
        let email = format!("test_{id}@example.com");
        let login = format!("player_{id}");
        let result: Result<_, Box<dyn std::error::Error>> = async {
            register_request(&pool, "Test", &login, &email, "test-password").await?;
            let mut observations = Vec::new();
            for (failed_identifier, successful_identifier) in [(&email, &login), (&login, &email)] {
                let failed = login_request(&pool, failed_identifier, "wrong-password").await?;
                let count: i32 = sqlx::query_scalar("SELECT failed_count FROM login_failures WHERE email = $1")
                    .bind(&email).fetch_one(&pool).await?;
                let success = login_request(&pool, successful_identifier, "test-password").await?;
                let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM login_failures WHERE email = $1 OR email = $2")
                    .bind(&email).bind(&login).fetch_one(&pool).await?;
                observations.push((failed, count, success, remaining));
            }
            Ok(observations)
        }.await;
        delete_user(&pool, &email).await?;
        for observation in result? {
            assert_eq!(observation, (StatusCode::UNAUTHORIZED, 1, StatusCode::OK, 0));
        }
        Ok(())
    }

    #[tokio::test]
    async fn login_collision_cannot_bypass_a_locked_email_owner() -> TestResult {
        let pool = connect().await?;
        let id = random_id().to_lowercase();
        let email = format!("test_{id}@realm");
        let other_email = format!("other_{id}@example.com");
        let result: Result<_, Box<dyn std::error::Error>> = async {
            register_request(&pool, "Test", &id, &email, "first-password").await?;
            register_request(&pool, "Other", &email, &other_email, "second-password").await?;
            sqlx::query("INSERT INTO login_failures (email, failed_count, first_failed_at, locked_until) VALUES ($1, 1, now(), now() + interval '1 hour')")
                .bind(&email).execute(&pool).await?;
            let mut responses = Vec::new();
            for password in ["first-password", "second-password"] {
                let response = post_json_response(&pool, "/api/login", serde_json::json!({"identifier": email.to_uppercase(), "password": password})).await?;
                responses.push((response.status(), session_cookie_from(&response)));
            }
            let other_failures: i64 = sqlx::query_scalar("SELECT count(*) FROM login_failures WHERE email = $1")
                .bind(&other_email).fetch_one(&pool).await?;
            let other = login_request(&pool, &other_email, "second-password").await?;
            Ok((responses, other_failures, other))
        }.await;
        delete_user(&pool, &email).await?;
        delete_user(&pool, &other_email).await?;
        let (responses, other_failures, other) = result?;
        for (status, cookie) in responses {
            assert_eq!(status, StatusCode::UNAUTHORIZED);
            assert!(cookie.is_none());
        }
        assert_eq!(other_failures, 0);
        assert_eq!(other, StatusCode::OK);
        Ok(())
    }

    #[tokio::test]
    async fn pending_signup_cannot_sign_in_by_login_until_confirmation() -> TestResult {
        let pool = connect().await?;
        let id = random_id().to_lowercase();
        let email = format!("test_{id}@example.com");
        let result: Result<_, Box<dyn std::error::Error>> = async {
            let challenge = pending_signup(&pool, &email, &id).await?;
            let before = login_request(&pool, &id, "signup-password").await?;
            let confirmed = confirm_signup(&pool, &challenge, "123456").await?;
            let after = login_request(&pool, &id, "signup-password").await?;
            Ok((before, confirmed, after))
        }.await;
        delete_user(&pool, &email).await?;
        clean_signup(&pool, &email).await?;
        assert_eq!(result?, (StatusCode::UNAUTHORIZED, StatusCode::CREATED, StatusCode::OK));
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
        wait_for_fresh_rate_window(login_ip_window_seconds()).await;
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
        wait_for_fresh_rate_window(register_ip_window_seconds()).await;
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
        wait_for_fresh_rate_window(login_ip_window_seconds()).await;
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

    #[tokio::test]
    async fn link_limit_allows_four_and_rejects_fifth_without_consuming_code() -> TestResult {
        let pool = connect().await?;
        let (email, cookie) = fresh_user(&pool).await?;
        let players: Vec<String> = (0..5).map(|_| test_uuid(&random_id())).collect();
        let outcome = async {
            let mut statuses = Vec::new();
            for uuid in &players[..4] {
                statuses.push(claim(&pool, &start_code(&pool, &cookie).await?, uuid, "LimitTest").await?);
            }
            let issuance = send(&pool, "POST", "/api/link/start", Some(&cookie), None).await?.status();
            // Model an outstanding valid code issued before the fourth claim.
            let code = new_link_code().map_err(|s| format!("{s}"))?;
            sqlx::query("INSERT INTO link_codes(user_id,code_hash,expires_at) SELECT id,$2,now()+interval '5 minutes' FROM users WHERE email=$1")
                .bind(&email).bind(hash_token(&code)).execute(&pool).await?;
            let rejected = claim(&pool, &code, &players[4], "LimitTest").await?;
            let unused: bool = sqlx::query_scalar("SELECT used_at IS NULL FROM link_codes WHERE code_hash=$1")
                .bind(hash_token(&code)).fetch_one(&pool).await?;
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM minecraft_accounts WHERE user_id=(SELECT id FROM users WHERE email=$1)")
                .bind(&email).fetch_one(&pool).await?;
            let unlink = send(&pool,"DELETE",&format!("/api/link/{}",players[0]),Some(&cookie),None).await?.status();
            let retry = claim(&pool,&code,&players[4],"LimitTest").await?;
            Ok::<_,Box<dyn std::error::Error>>((statuses,issuance,rejected,unused,count,unlink,retry))
        }.await;
        delete_user(&pool,&email).await?;
        for uuid in &players { sqlx::query("DELETE FROM player_skins WHERE uuid=$1").bind(uuid).execute(&pool).await?; }
        let (statuses,issuance,rejected,unused,count,unlink,retry) = outcome?;
        assert!(statuses.iter().all(|s| *s==StatusCode::OK));
        assert_eq!(issuance,StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(rejected,StatusCode::UNPROCESSABLE_ENTITY);
        assert!(unused);
        assert_eq!(count,4);
        assert_eq!(unlink,StatusCode::NO_CONTENT);
        assert_eq!(retry,StatusCode::OK);
        Ok(())
    }

    #[tokio::test]
    async fn concurrent_claims_cannot_exceed_four_linked_accounts() -> TestResult {
        let pool = connect().await?;
        let (email,cookie) = fresh_user(&pool).await?;
        let players: Vec<String> = (0..5).map(|_| test_uuid(&random_id())).collect();
        let outcome = async {
            for uuid in &players[..3] { claim(&pool,&start_code(&pool,&cookie).await?,uuid,"LimitTest").await?; }
            let codes = [new_link_code().map_err(|s| format!("{s}"))?,new_link_code().map_err(|s| format!("{s}"))?];
            for code in &codes {
                sqlx::query("INSERT INTO link_codes(user_id,code_hash,expires_at) SELECT id,$2,now()+interval '5 minutes' FROM users WHERE email=$1")
                    .bind(&email).bind(hash_token(code)).execute(&pool).await?;
            }
            let (one,two) = tokio::join!(claim(&pool,&codes[0],&players[3],"LimitTest"),claim(&pool,&codes[1],&players[4],"LimitTest"));
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM minecraft_accounts WHERE user_id=(SELECT id FROM users WHERE email=$1)")
                .bind(&email).fetch_one(&pool).await?;
            let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM link_codes WHERE user_id=(SELECT id FROM users WHERE email=$1) AND used_at IS NULL")
                .bind(&email).fetch_one(&pool).await?;
            Ok::<_,Box<dyn std::error::Error>>((one?,two?,count,remaining))
        }.await;
        delete_user(&pool,&email).await?;
        for uuid in &players { sqlx::query("DELETE FROM player_skins WHERE uuid=$1").bind(uuid).execute(&pool).await?; }
        let (one,two,count,remaining) = outcome?;
        assert!(matches!((one,two),(StatusCode::OK,StatusCode::UNPROCESSABLE_ENTITY)|(StatusCode::UNPROCESSABLE_ENTITY,StatusCode::OK)));
        assert_eq!(count,4);
        assert_eq!(remaining,1);
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
        wait_for_fresh_rate_window(link_claim_ip_window_seconds()).await;
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

    /// One player in a report. The three counters migration 0005 knows about are
    /// always present; `extra` carries any of the wider 0008 activity fields a
    /// test wants to set, so one test can spotlight a single number without
    /// listing the other thirteen.
    fn stats_player_with(
        uuid: &str,
        username: &str,
        play_seconds: i64,
        blocks_placed: i64,
        blocks_broken: i64,
        extra: serde_json::Value
    ) -> serde_json::Value {
        let mut player = serde_json::json!({
            "uuid": uuid,
            "username": username,
            "play_seconds": play_seconds,
            "blocks_placed": blocks_placed,
            "blocks_broken": blocks_broken,
        });
        if let Some(fields) = extra.as_object() {
            for (key, value) in fields {
                player[key.as_str()] = value.clone();
            }
        }
        player
    }

    fn stats_player(
        uuid: &str,
        username: &str,
        play_seconds: i64,
        blocks_placed: i64,
        blocks_broken: i64
    ) -> serde_json::Value {
        stats_player_with(
            uuid,
            username,
            play_seconds,
            blocks_placed,
            blocks_broken,
            serde_json::json!({})
        )
    }

    async fn report_stats(
        pool: &sqlx::PgPool,
        token: Option<&str>,
        players: Vec<serde_json::Value>
    ) -> Result<StatusCode, Box<dyn std::error::Error>> {
        let report_id = test_uuid(&random_ip());
        let result = post_internal(
            pool,
            "/internal/stats/report",
            token,
            serde_json::json!({ "report_id": report_id, "players": players }),
            &random_ip()
        ).await?.status();
        sqlx::query("DELETE FROM stats_reports WHERE report_id = $1").bind(report_id).execute(pool).await?;
        Ok(result)
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
    async fn coins_reports_are_idempotent_and_balances_are_private() -> TestResult {
        let pool = connect().await?;
        let uuid = test_uuid(&random_ip());
        let report_id = test_uuid(&random_ip());
        let token = test_service_token();
        let body = serde_json::json!({ "report_id": report_id,
            "players": [stats_player(&uuid, "Miner", 10, 0, 7)] });
        let ip = random_ip();
        let (first, retry) = tokio::join!(
            post_internal(&pool, "/internal/stats/report", Some(&token), body.clone(), &ip),
            post_internal(&pool, "/internal/stats/report", Some(&token), body.clone(), &ip)
        );
        let mut changed = body.clone();
        changed["players"][0]["blocks_broken"] = serde_json::json!(99);
        let conflict = post_internal(&pool, "/internal/stats/report", Some(&token), changed, &ip).await?;
        let input = serde_json::json!({ "uuid": uuid.to_uppercase() });
        let missing = post_internal(&pool, "/internal/balance", None, input.clone(), &ip).await?;
        let wrong = post_internal(&pool, "/internal/balance", Some("wrong"), input.clone(), &ip).await?;
        let balance = post_internal(&pool, "/internal/balance", Some(&token), input, &ip).await?;
        let cache = balance.headers().get(header::CACHE_CONTROL).cloned();
        let balance_status = balance.status();
        let bytes = axum::body::to_bytes(balance.into_body(), 1024).await?;
        let invalid = post_internal(&pool, "/internal/balance", Some(&token), serde_json::json!({"uuid":"bad"}), &ip).await?;
        let unknown = post_internal(&pool, "/internal/balance", Some(&token), serde_json::json!({"uuid":test_uuid(&random_ip())}), &ip).await?;
        let zero = axum::body::to_bytes(unknown.into_body(), 1024).await?;
        let stored: (i64, i64) = sqlx::query_as("SELECT coins, blocks_broken FROM player_stats WHERE uuid = $1")
            .bind(&uuid).fetch_one(&pool).await?;
        delete_player_stats(&pool, &uuid).await?;
        sqlx::query("DELETE FROM stats_reports WHERE report_id = $1").bind(&report_id).execute(&pool).await?;
        assert_eq!(first?.status(), StatusCode::OK);
        assert_eq!(retry?.status(), StatusCode::OK);
        assert_eq!(conflict.status(), StatusCode::CONFLICT);
        assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        assert_eq!(balance_status, StatusCode::OK);
        assert_eq!(cache.unwrap(), "no-store");
        assert_eq!(&bytes[..], b"7");
        assert_eq!(&zero[..], b"0");
        assert_eq!(stored, (7, 7));
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
            vec![stats_player_with(&uuid, "Notch", 3600, 10, 5, serde_json::json!({
                "mobs_killed": 3,
                "distance_cm": 12_345,
                "logins": 1,
                "damage_dealt": 250,
                "fish_caught": 2,
                "advancements": 1,
            }))]
        ).await?;
        let second = report_stats(
            &pool,
            Some(&test_service_token()),
            vec![stats_player_with(&uuid, "Notch", 1800, 2, 1, serde_json::json!({
                "mobs_killed": 2,
                "distance_cm": 7_655,
                "logins": 1,
                "damage_dealt": 150,
            }))]
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
        // The wider activity set adds up the same way: delta after delta.
        assert_eq!(accounts[0]["stats"]["mobs_killed"], 5);
        assert_eq!(accounts[0]["stats"]["distance_cm"], 20_000);
        assert_eq!(accounts[0]["stats"]["logins"], 2);
        assert_eq!(accounts[0]["stats"]["damage_dealt"], 400);
        assert_eq!(accounts[0]["stats"]["fish_caught"], 2);
        assert_eq!(accounts[0]["stats"]["advancements"], 1);
        // A counter nobody reported is a real zero, not an absent field.
        assert_eq!(accounts[0]["stats"]["deaths"], 0);
        assert_eq!(accounts[0]["stats"]["damage_taken"], 0);
        assert!(accounts[0]["stats"]["first_seen_at"].as_str().is_some());
        assert!(accounts[0]["stats"]["last_seen_at"].as_str().is_some());
        assert_eq!(body["summary"]["accounts"], 1);
        assert_eq!(body["summary"]["accounts_with_stats"], 1);
        assert_eq!(body["summary"]["play_seconds"], 5400);
        assert_eq!(body["summary"]["blocks_placed"], 12);
        assert_eq!(body["summary"]["blocks_broken"], 6);
        assert_eq!(body["summary"]["mobs_killed"], 5);
        assert_eq!(body["summary"]["distance_cm"], 20_000);
        assert_eq!(body["summary"]["logins"], 2);
        assert_eq!(body["summary"]["damage_dealt"], 400);
        assert_eq!(body["summary"]["coins"], 6);
        assert_eq!(accounts[0]["coins"], 6);
        Ok(())
    }

    // The panel is deployed independently of the game server: a plugin jar that
    // predates migration 0008 sends only the original three counters and must
    // keep working, because a rejected report is activity the player never sees.
    #[tokio::test]
    async fn stats_report_accepts_a_plugin_that_predates_the_wider_set() -> TestResult {
        let pool = connect().await?;
        let (email, cookie) = fresh_user(&pool).await?;
        let uuid = test_uuid(&email);
        let code = start_code(&pool, &cookie).await?;
        claim(&pool, &code, &uuid, "Notch").await?;
        let report_id = test_uuid(&random_ip());
        // Exactly the JSON an old jar writes, with no 0008 field at all.
        let body = serde_json::json!({
            "report_id": report_id,
            "players": [{
                "uuid": uuid,
                "username": "Notch",
                "play_seconds": 120,
                "blocks_placed": 4,
                "blocks_broken": 4,
            }],
        });
        let accepted = post_internal(
            &pool,
            "/internal/stats/report",
            Some(&test_service_token()),
            body,
            &random_ip()
        ).await?.status();
        let view = stats_view(&pool, &cookie).await?;
        let stored: (i64, i64) = sqlx::query_as(
            "SELECT coins, mobs_killed + distance_cm + logins + advancements FROM player_stats WHERE uuid = $1"
        ).bind(&uuid).fetch_one(&pool).await?;
        delete_user(&pool, &email).await?;
        delete_player_stats(&pool, &uuid).await?;
        sqlx::query("DELETE FROM stats_reports WHERE report_id = $1").bind(&report_id).execute(&pool).await?;
        assert_eq!(accepted, StatusCode::OK);
        assert_eq!(view["accounts"][0]["stats"]["play_seconds"], 120);
        assert_eq!(view["accounts"][0]["stats"]["mobs_killed"], 0);
        // Coins still accrue from the block breaks the old jar did report.
        assert_eq!(stored, (4, 0));
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
                stats_player_with(&uuid_a, "PlayerA", 100, 1, 2, serde_json::json!({
                    "mobs_killed": 4,
                    "distance_cm": 1_000,
                })),
                stats_player_with(&uuid_b, "PlayerB", 300, 5, 7, serde_json::json!({
                    "mobs_killed": 6,
                    "distance_cm": 2_500,
                })),
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
        assert_eq!(stats["mobs_killed"], 10);
        assert_eq!(stats["distance_cm"], 3_500);
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
        assert_eq!(body_b["summary"]["coins"], 0);
        assert_eq!(body["summary"]["coins"], 0);
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
        assert_eq!(before["accounts"][0]["coins"], 3);
        assert_eq!(after["summary"]["coins"], 0);
        assert_eq!(restored["accounts"][0]["coins"], 3);
        Ok(())
    }
    fn skin_test_png() -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, 64, 64);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.write_header().unwrap().write_image_data(&vec![255; 64 * 64 * 4]).unwrap();
        }
        bytes
    }

    fn skin_test_value(hash: &str) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(serde_json::json!({"textures":{"SKIN":{"url":format!("https://textures.minecraft.net/texture/{hash}")}}}).to_string())
    }

    #[test]
    fn skin_validation_decodes_pixels_and_restricts_texture_sources() {
        let png = skin_test_png();
        assert!(clean_skin_png(&png).is_ok());
        assert!(clean_skin_png(&png[..40]).is_err());
        assert!(clean_skin_png(b"not a skin").is_err());
        assert!(clean_skin_png(&vec![0; MAX_SKIN_BYTES + 1]).is_err());
        let hash = "a".repeat(64);
        assert_eq!(texture_from_property(&skin_test_value(&hash)), Some((hash, "classic".into())));
        assert!(texture_from_property(&skin_test_value("../private")).is_none());
        use base64::Engine;
        let other = base64::engine::general_purpose::STANDARD.encode(r#"{"textures":{"SKIN":{"url":"https://attacker.example/skin"}}}"#);
        assert!(texture_from_property(&other).is_none());
    }

    async fn skin_multipart(pool: &sqlx::PgPool, cookie: &str, uuid: &str, custom_header: bool, png: &[u8]) -> Result<StatusCode, Box<dyn std::error::Error>> {
        let boundary = "skin-test-boundary";
        let mut body = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nclassic\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"skin.png\"\r\nContent-Type: image/png\r\n\r\n").into_bytes();
        body.extend_from_slice(png);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let mut request = Request::builder().method("POST").uri(format!("/api/players/{uuid}/skin"))
            .header("cookie", cookie).header("content-type", format!("multipart/form-data; boundary={boundary}"));
        if custom_header { request = request.header("x-player-skin", "upload"); }
        Ok(app(pool.clone()).oneshot(request.body(Body::from(body))?).await?.status())
    }

    #[tokio::test]
    async fn player_skin_is_owned_and_saved_only_after_matching_game_ack() -> TestResult {
        let pool = connect().await?;
        let (email, cookie) = fresh_user(&pool).await?;
        let (other_email, other_cookie) = fresh_user(&pool).await?;
        let uuid = test_uuid(&random_ip());
        let outcome = async {
            let code = start_code(&pool, &cookie).await?;
            let linked = claim(&pool, &code, &uuid, "SkinTest").await?;
            let endpoint = format!("/api/players/{uuid}/skin");
            let anonymous = send(&pool, "GET", &endpoint, None, None).await?.status();
            let stranger = send(&pool, "GET", &endpoint, Some(&other_cookie), None).await?.status();
            let png = skin_test_png();
            let wrong_owner = skin_multipart(&pool, &other_cookie, &uuid, true, &png).await?;
            let no_csrf = skin_multipart(&pool, &cookie, &uuid, false, &png).await?;
            let invalid = skin_multipart(&pool, &cookie, &uuid, true, b"invalid").await?;
            let accepted = skin_multipart(&pool, &cookie, &uuid, true, &png).await?;
            let duplicate = skin_multipart(&pool, &cookie, &uuid, true, &png).await?;
            let request_id: String = sqlx::query_scalar("SELECT request_id FROM skin_uploads WHERE uuid=$1").bind(&uuid).fetch_one(&pool).await?;
            let hash = "a".repeat(64);
            let value = skin_test_value(&hash);
            sqlx::query("UPDATE skin_uploads SET status='ready',value=$2,signature='test-signature',png=NULL WHERE uuid=$1").bind(&uuid).bind(&value).execute(&pool).await?;
            let token = test_service_token();
            let unauth_sync = post_internal(&pool,"/internal/skins/sync",None,serde_json::json!({}),&random_ip()).await?.status();
            let stale_ack = post_internal(&pool,"/internal/skins/report",Some(&token),serde_json::json!({"uuid":uuid,"value":value,"request_id":"stale"}),&random_ip()).await?.status();
            let ack = post_internal(&pool,"/internal/skins/report",Some(&token),serde_json::json!({"uuid":uuid,"value":value,"request_id":request_id}),&random_ip()).await?.status();
            let found = body_json(send(&pool,"GET",&endpoint,Some(&cookie),None).await?).await?;
            let cooldown = skin_multipart(&pool, &cookie, &uuid, true, &png).await?;
            let unlinked = send(&pool,"DELETE",&format!("/api/link/{uuid}"),Some(&cookie),None).await?.status();
            let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM skin_uploads WHERE uuid=$1").bind(&uuid).fetch_one(&pool).await?;
            Ok::<_, Box<dyn std::error::Error>>((linked,anonymous,stranger,wrong_owner,no_csrf,invalid,accepted,duplicate,unauth_sync,stale_ack,ack,found,cooldown,unlinked,remaining))
        }.await;
        delete_user(&pool,&email).await?;
        delete_user(&pool,&other_email).await?;
        sqlx::query("DELETE FROM player_skins WHERE uuid=$1").bind(&uuid).execute(&pool).await?;
        let (linked,anonymous,stranger,wrong_owner,no_csrf,invalid,accepted,duplicate,unauth_sync,stale_ack,ack,found,cooldown,unlinked,remaining) = outcome?;
        assert_eq!(linked, StatusCode::OK);
        assert_eq!(anonymous, StatusCode::UNAUTHORIZED);
        assert_eq!(stranger, StatusCode::NOT_FOUND);
        assert_eq!(wrong_owner, StatusCode::NOT_FOUND);
        assert_eq!(no_csrf, StatusCode::BAD_REQUEST);
        assert_eq!(invalid, StatusCode::BAD_REQUEST);
        assert_eq!(accepted, StatusCode::ACCEPTED);
        assert_eq!(duplicate, StatusCode::CONFLICT);
        assert_eq!(unauth_sync, StatusCode::UNAUTHORIZED);
        assert_eq!(stale_ack, StatusCode::CONFLICT);
        assert_eq!(ack, StatusCode::NO_CONTENT);
        assert_eq!(found["upload"]["status"], "saved");
        assert_eq!(found["texture_hash"], "a".repeat(64));
        assert_eq!(cooldown, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(unlinked, StatusCode::NO_CONTENT);
        assert_eq!(remaining,0);
        Ok(())
    }

    // --- Inventory ---------------------------------------------------------

    // Two tiny, real 1x1 PNGs; the second exists only to prove the first upload wins.
    const INVENTORY_ICON_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const INVENTORY_ICON_PNG_OTHER: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

    // A 41-slot snapshot: an enchanted, worn sword in the first hotbar slot and
    // a helmet in the first armor slot, everything else empty.
    fn inventory_body(uuid: &str, username: &str) -> serde_json::Value {
        let mut slots = Vec::new();
        for _ in 0..INVENTORY_SLOT_COUNT {
            slots.push(serde_json::json!(null));
        }
        slots[0] = serde_json::json!({
            "key": "minecraft:stone_sword",
            "amount": 1,
            "damage": 5,
            "max_damage": 127,
            "display_name": "Sharp",
            "enchantments": { "minecraft:sharpness": 3 }
        });
        slots[36] = serde_json::json!({
            "key": "minecraft:leather_helmet",
            "amount": 1,
            "damage": 0,
            "max_damage": 165,
            "display_name": null,
            "enchantments": {}
        });
        serde_json::json!({ "uuid": uuid, "username": username, "slots": slots })
    }

    async fn post_inventory(
        pool: &sqlx::PgPool,
        token: Option<&str>,
        body: serde_json::Value
    ) -> Result<StatusCode, Box<dyn std::error::Error>> {
        Ok(post_internal(pool, "/internal/inventory/report", token, body, &random_ip()).await?.status())
    }

    async fn get_inventory(
        pool: &sqlx::PgPool,
        cookie: Option<&str>,
        uuid: &str
    ) -> Result<(StatusCode, axum::response::Response), Box<dyn std::error::Error>> {
        let response = send(pool, "GET", &format!("/api/players/{uuid}/inventory"), cookie, None).await?;
        Ok((response.status(), response))
    }

    // `delete_user` cannot reach these tables: both are keyed by in-game UUID
    // without a foreign key, so tests remove their own rows.
    async fn delete_player_inventory(
        pool: &sqlx::PgPool,
        uuid: &str
    ) -> Result<(), Box<dyn std::error::Error>> {
        sqlx::query("DELETE FROM player_inventory WHERE uuid = $1")
            .bind(uuid)
            .execute(pool).await?;
        Ok(())
    }

    async fn delete_item_icons(
        pool: &sqlx::PgPool,
        keys: &[String]
    ) -> Result<(), Box<dyn std::error::Error>> {
        sqlx::query("DELETE FROM item_icons WHERE key = ANY($1::text[])")
            .bind(keys)
            .execute(pool).await?;
        Ok(())
    }

    #[tokio::test]
    async fn inventory_report_requires_the_service_token() -> TestResult {
        let pool = connect().await?;
        let uuid = test_uuid(&random_ip());
        let body = inventory_body(&uuid, "InvTest");
        let missing = post_inventory(&pool, None, body.clone()).await?;
        let wrong = post_inventory(&pool, Some("not-the-token"), body.clone()).await?;
        let accepted = post_inventory(&pool, Some(&test_service_token()), body).await?;
        let stored: i64 = sqlx::query_scalar("SELECT count(*) FROM player_inventory WHERE uuid = $1")
            .bind(&uuid).fetch_one(&pool).await?;
        delete_player_inventory(&pool, &uuid).await?;
        assert_eq!(missing, StatusCode::UNAUTHORIZED);
        assert_eq!(wrong, StatusCode::UNAUTHORIZED);
        assert_eq!(accepted, StatusCode::OK);
        assert_eq!(stored, 1);
        Ok(())
    }

    #[tokio::test]
    async fn inventory_report_rejects_malformed_snapshots() -> TestResult {
        let pool = connect().await?;
        let uuid = test_uuid(&random_ip());
        let token = test_service_token();
        let bad_uuid = inventory_body("not-a-uuid", "InvTest");
        let mut wrong_count = inventory_body(&uuid, "InvTest");
        wrong_count["slots"].as_array_mut().expect("slots array").pop();
        let mut bad_amount = inventory_body(&uuid, "InvTest");
        bad_amount["slots"][0]["amount"] = serde_json::json!(9999);
        let mut bad_damage = inventory_body(&uuid, "InvTest");
        bad_damage["slots"][0]["damage"] = serde_json::json!(128);
        let mut lone_damage = inventory_body(&uuid, "InvTest");
        lone_damage["slots"][0]["max_damage"] = serde_json::json!(null);
        let mut bad_key = inventory_body(&uuid, "InvTest");
        bad_key["slots"][0]["key"] = serde_json::json!("minecraft:Stone Sword");
        // A bare word is not a registry key: the namespace and colon are required.
        let mut bare_key = inventory_body(&uuid, "InvTest");
        bare_key["slots"][0]["key"] = serde_json::json!("stone_sword");
        let (bad_uuid, wrong_count, bad_amount, bad_damage, lone_damage, bad_key, bare_key) = tokio::join!(
            post_inventory(&pool, Some(&token), bad_uuid),
            post_inventory(&pool, Some(&token), wrong_count),
            post_inventory(&pool, Some(&token), bad_amount),
            post_inventory(&pool, Some(&token), bad_damage),
            post_inventory(&pool, Some(&token), lone_damage),
            post_inventory(&pool, Some(&token), bad_key),
            post_inventory(&pool, Some(&token), bare_key),
        );
        let stored: i64 = sqlx::query_scalar("SELECT count(*) FROM player_inventory WHERE uuid = $1")
            .bind(&uuid).fetch_one(&pool).await?;
        assert_eq!(bad_uuid?, StatusCode::BAD_REQUEST);
        assert_eq!(wrong_count?, StatusCode::BAD_REQUEST);
        assert_eq!(bad_amount?, StatusCode::BAD_REQUEST);
        assert_eq!(bad_damage?, StatusCode::BAD_REQUEST);
        assert_eq!(lone_damage?, StatusCode::BAD_REQUEST);
        assert_eq!(bad_key?, StatusCode::BAD_REQUEST);
        assert_eq!(bare_key?, StatusCode::BAD_REQUEST);
        assert_eq!(stored, 0);
        Ok(())
    }

    #[tokio::test]
    async fn inventory_snapshot_is_replaced_and_owner_only() -> TestResult {
        let pool = connect().await?;
        let (email, cookie) = fresh_user(&pool).await?;
        let (other_email, other_cookie) = fresh_user(&pool).await?;
        let uuid = test_uuid(&random_ip());
        let endpoint = format!("/api/players/{uuid}/inventory");
        let outcome = async {
            let linked = claim(&pool, &start_code(&pool, &cookie).await?, &uuid, "InvTest").await?;
            let anonymous = send(&pool, "GET", &endpoint, None, None).await?.status();
            let stranger = send(&pool, "GET", &endpoint, Some(&other_cookie), None).await?.status();
            // No snapshot yet: 200 with null slots, never a made-up inventory.
            let (empty_status, empty) = get_inventory(&pool, Some(&cookie), &uuid).await?;
            let empty_cache = empty.headers().get(header::CACHE_CONTROL).cloned();
            let empty_body = body_json(empty).await?;
            let first = post_inventory(&pool, Some(&test_service_token()), inventory_body(&uuid, "InvTest")).await?;
            // A later snapshot replaces the earlier one: the sword is gone.
            let mut second = inventory_body(&uuid, "InvTest");
            second["slots"][0] = serde_json::json!(null);
            second["slots"][9] = serde_json::json!({ "key": "minecraft:cooked_beef", "amount": 14 });
            let second_status = post_inventory(&pool, Some(&test_service_token()), second).await?;
            let (found_status, found_response) = get_inventory(&pool, Some(&cookie), &uuid).await?;
            let found = body_json(found_response).await?;
            let unlinked = send(&pool, "DELETE", &format!("/api/link/{uuid}"), Some(&cookie), None).await?.status();
            // The snapshot outlives the link; once unlinked it is invisible again.
            let after_unlink = get_inventory(&pool, Some(&cookie), &uuid).await?.0;
            Ok::<_, Box<dyn std::error::Error>>((linked, anonymous, stranger, empty_status, empty_cache, empty_body, first, second_status, found_status, found, unlinked, after_unlink))
        }.await;
        delete_user(&pool, &email).await?;
        delete_user(&pool, &other_email).await?;
        delete_player_inventory(&pool, &uuid).await?;
        let (linked, anonymous, stranger, empty_status, empty_cache, empty_body, first, second_status, found_status, found, unlinked, after_unlink) = outcome?;
        assert_eq!(linked, StatusCode::OK);
        assert_eq!(anonymous, StatusCode::UNAUTHORIZED);
        assert_eq!(stranger, StatusCode::NOT_FOUND);
        assert_eq!(empty_status, StatusCode::OK);
        assert_eq!(empty_cache, Some(header::HeaderValue::from_static("no-store")));
        assert!(empty_body["slots"].is_null());
        assert_eq!(first, StatusCode::OK);
        assert_eq!(second_status, StatusCode::OK);
        assert_eq!(found_status, StatusCode::OK);
        assert_eq!(found["username"], "InvTest");
        assert!(found["updated_at"].is_string());
        assert!(found["slots"][0].is_null());
        assert_eq!(found["slots"][9]["key"], "minecraft:cooked_beef");
        assert_eq!(found["slots"][9]["amount"], 14);
        assert!(found["slots"][9]["icon"].is_null());
        assert_eq!(found["slots"][36]["key"], "minecraft:leather_helmet");
        assert_eq!(unlinked, StatusCode::NO_CONTENT);
        assert_eq!(after_unlink, StatusCode::NOT_FOUND);
        Ok(())
    }

    macro_rules! market_check {
        ($condition:expr) => {
            if !$condition {
                return Err(format!(
                    "market check failed: {} at line {}",
                    stringify!($condition),
                    line!()
                )
                .into());
            }
        };
    }
    macro_rules! market_eq {
        ($actual:expr, $expected:expr) => {{
            let actual = &$actual;
            let expected = &$expected;
            if actual != expected {
                return Err(format!(
                    "market check failed at line {}: {actual:?} != {expected:?}",
                    line!()
                )
                .into());
            }
        }};
    }
    async fn market_request(
        pool: &sqlx::PgPool,
        path: &str,
        cookie: Option<&str>,
        body: serde_json::Value,
        edit_header: bool,
    ) -> Result<StatusCode, Box<dyn std::error::Error>> {
        let mut builder = Request::builder()
            .method("POST")
            .uri(path)
            .header("content-type", "application/json");
        if let Some(cookie) = cookie {
            builder = builder.header("cookie", cookie);
        }
        if edit_header {
            builder = builder.header("x-marketplace", "trade");
        }
        Ok(app(pool.clone())
            .oneshot(builder.body(Body::from(body.to_string()))?)
            .await?
            .status())
    }
    async fn clear_market(pool: &sqlx::PgPool, uuids: &[String]) -> TestResult {
        sqlx::query("DELETE FROM market_tasks WHERE listing_id IN (SELECT id FROM market_listings WHERE uuid=ANY($1::text[])) OR uuid=ANY($1::text[])").bind(uuids).execute(pool).await?;
        sqlx::query("DELETE FROM market_orders WHERE listing_id IN (SELECT id FROM market_listings WHERE uuid=ANY($1::text[])) OR buyer_uuid=ANY($1::text[])").bind(uuids).execute(pool).await?;
        sqlx::query("DELETE FROM market_listings WHERE uuid=ANY($1::text[])")
            .bind(uuids)
            .execute(pool)
            .await?;
        sqlx::query("DELETE FROM player_stats WHERE uuid=ANY($1::text[])")
            .bind(uuids)
            .execute(pool)
            .await?;
        Ok(())
    }
    async fn market_ack(
        pool: &sqlx::PgPool,
        uuid: &str,
        status: &str,
        slots: serde_json::Value,
    ) -> Result<StatusCode, Box<dyn std::error::Error>> {
        let id: String = sqlx::query_scalar(
            "SELECT id FROM market_tasks WHERE uuid=$1 AND status='pending' ORDER BY sequence LIMIT 1",
        )
        .bind(uuid)
        .fetch_one(pool)
        .await?;
        Ok(post_internal(pool,"/internal/marketplace/report",Some(&test_service_token()),serde_json::json!({"uuid":uuid,"id":id,"status":status,"item_bytes":"c2F2ZWQtaXRlbQ==","slots":slots}),&random_ip()).await?.status())
    }
    async fn seed_market_inventory(
        pool: &sqlx::PgPool,
        uuid: &str,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
        let mut snapshot = inventory_body(uuid, "MarketTest");
        snapshot["slots"][0]["fingerprint"] = serde_json::json!("a".repeat(64));
        post_inventory(pool, Some(&test_service_token()), snapshot.clone()).await?;
        Ok(snapshot)
    }
    fn market_input(quantity: i32) -> serde_json::Value {
        serde_json::json!({"slot":0,"fingerprint":"a".repeat(64),"quantity":quantity,"unit_price":10,"lot_price":15})
    }
    #[tokio::test]
    async fn marketplace_escrow_requires_ownership_and_server_acknowledgement() -> TestResult {
        let pool = connect().await?;
        let (email, cookie) = fresh_user(&pool).await?;
        let (other_email, other_cookie) = fresh_user(&pool).await?;
        let uuid = test_uuid(&random_ip());
        let outcome=async {
            claim(&pool,&start_code(&pool,&cookie).await?,&uuid,"MarketTest").await?;
            let snapshot=seed_market_inventory(&pool,&uuid).await?;
            let path=format!("/api/players/{uuid}/inventory/marketplace");
            market_eq!(market_request(&pool,&path,None,market_input(1),true).await?,StatusCode::UNAUTHORIZED);
            market_eq!(market_request(&pool,&path,Some(&other_cookie),market_input(1),true).await?,StatusCode::NOT_FOUND);
            market_eq!(market_request(&pool,&path,Some(&cookie),market_input(1),false).await?,StatusCode::BAD_REQUEST);
            for patch in [serde_json::json!({"quantity":0}),serde_json::json!({"unit_price":-1}),serde_json::json!({"unit_price":null,"lot_price":null}),serde_json::json!({"slot":41})] {
                let mut input=market_input(1); for (k,v) in patch.as_object().unwrap() { input[k]=v.clone(); }
                market_eq!(market_request(&pool,&path,Some(&cookie),input,true).await?,StatusCode::BAD_REQUEST);
            }
            market_eq!(market_request(&pool,&path,Some(&cookie),market_input(230),true).await?,StatusCode::CONFLICT);
            let (one,two)=tokio::join!(market_request(&pool,&path,Some(&cookie),market_input(1),true),market_request(&pool,&path,Some(&cookie),market_input(1),true));
            market_check!(matches!((one?,two?),(StatusCode::ACCEPTED,StatusCode::CONFLICT)|(StatusCode::CONFLICT,StatusCode::ACCEPTED)));
            let found=body_json(get_with_cookie(&pool,"/api/marketplace",Some(&other_cookie)).await?).await?;
            market_check!(!found["listings"].as_array().unwrap().iter().any(|l| l["seller"]=="MarketTest" && l["status"]=="pending"));
            let before=body_json(get_inventory(&pool,Some(&cookie),&uuid).await?.1).await?;
            market_eq!(before["marketplace"]["status"],"pending");
            market_eq!(before["slots"][0]["amount"],snapshot["slots"][0]["amount"]);
            let no_token=post_internal(&pool,"/internal/marketplace/sync",None,serde_json::json!({}),&random_ip()).await?.status();
            market_eq!(no_token,StatusCode::UNAUTHORIZED);
            let stale=post_internal(&pool,"/internal/marketplace/report",Some(&test_service_token()),serde_json::json!({"uuid":uuid,"id":"b".repeat(64),"status":"done","item_bytes":"YQ==","slots":snapshot["slots"]}),&random_ip()).await?.status();
            market_eq!(stale,StatusCode::NOT_FOUND);
            market_eq!(market_ack(&pool,&uuid,"conflict",snapshot["slots"].clone()).await?,StatusCode::OK);
            let status: String=sqlx::query_scalar("SELECT status FROM market_listings WHERE uuid=$1").bind(&uuid).fetch_one(&pool).await?;
            market_eq!(status,"conflict");
            market_eq!(market_request(&pool,&path,Some(&cookie),market_input(1),true).await?,StatusCode::ACCEPTED);
            market_eq!(market_ack(&pool,&uuid,"done",snapshot["slots"].clone()).await?,StatusCode::OK);
            let listing=body_json(get_with_cookie(&pool,"/api/marketplace",Some(&other_cookie)).await?).await?;
            let own=body_json(get_with_cookie(&pool,"/api/marketplace?mine=true",Some(&cookie)).await?).await?;
            let id: String=sqlx::query_scalar("SELECT id FROM market_listings WHERE uuid=$1 AND status='active'").bind(&uuid).fetch_one(&pool).await?;
            let visible=listing["listings"].as_array().unwrap().iter().find(|v| v["id"]==id).unwrap();
            market_eq!(visible["mine"],false); market_check!(visible.get("item_bytes").is_none()); market_check!(visible.get("uuid").is_none());
            market_check!(own["listings"].as_array().unwrap().iter().any(|v| v["id"]==id && v["mine"]==true));
            market_eq!(send(&pool,"DELETE",&format!("/api/link/{uuid}"),Some(&cookie),None).await?.status(),StatusCode::CONFLICT);
            Ok::<_,Box<dyn std::error::Error>>(())
        }.await;
        clear_market(&pool, std::slice::from_ref(&uuid)).await?;
        delete_user(&pool, &email).await?;
        delete_user(&pool, &other_email).await?;
        delete_player_inventory(&pool, &uuid).await?;
        outcome
    }

    #[tokio::test]
    async fn marketplace_purchases_are_atomic_quoted_and_idempotent_with_returns() -> TestResult {
        let pool = connect().await?;
        let (email, cookie) = fresh_user(&pool).await?;
        let (buyer_email, buyer_cookie) = fresh_user(&pool).await?;
        let seller = test_uuid(&random_ip());
        let buyer = test_uuid(&random_ip());
        let outcome=async {
            claim(&pool,&start_code(&pool,&cookie).await?,&seller,"SellerTest").await?;
            claim(&pool,&start_code(&pool,&buyer_cookie).await?,&buyer,"BuyerTest").await?;
            let mut snapshot=seed_market_inventory(&pool,&seller).await?;
            snapshot["slots"][0]["amount"]=serde_json::json!(12);
            post_inventory(&pool,Some(&test_service_token()),snapshot.clone()).await?;
            market_eq!(market_request(&pool,&format!("/api/players/{seller}/inventory/marketplace"),Some(&cookie),market_input(12),true).await?,StatusCode::ACCEPTED);
            market_eq!(market_ack(&pool,&seller,"done",snapshot["slots"].clone()).await?,StatusCode::OK);
            let id: String=sqlx::query_scalar("SELECT id FROM market_listings WHERE uuid=$1").bind(&seller).fetch_one(&pool).await?;
            let path=format!("/api/marketplace/{id}/buy");
            let own_buy=serde_json::json!({"request_id":test_uuid(&random_ip()),"buyer_uuid":seller,"quantity":1,"pricing":"unit","expected_total":10,"expected_remaining":12});
            market_eq!(market_request(&pool,&path,Some(&cookie),own_buy.clone(),true).await?,StatusCode::CONFLICT);
            market_eq!(market_request(&pool,&path,Some(&buyer_cookie),own_buy,true).await?,StatusCode::NOT_FOUND);
            let mut buy=serde_json::json!({"request_id":test_uuid(&random_ip()),"buyer_uuid":buyer,"quantity":2,"pricing":"unit","expected_total":20,"expected_remaining":12});
            market_eq!(market_request(&pool,&path,Some(&buyer_cookie),buy.clone(),true).await?,StatusCode::UNPROCESSABLE_ENTITY);
            sqlx::query("INSERT INTO player_stats(uuid,username,coins) VALUES($1,'BuyerTest',100)").bind(&buyer).execute(&pool).await?;
            buy["expected_total"]=serde_json::json!(19);
            market_eq!(market_request(&pool,&path,Some(&buyer_cookie),buy.clone(),true).await?,StatusCode::CONFLICT);
            buy["expected_total"]=serde_json::json!(20);
            let (one,two)=tokio::join!(market_request(&pool,&path,Some(&buyer_cookie),buy.clone(),true),market_request(&pool,&path,Some(&buyer_cookie),buy.clone(),true));
            market_eq!(one?,StatusCode::ACCEPTED); market_eq!(two?,StatusCode::ACCEPTED);
            let balance: i64=sqlx::query_scalar("SELECT coins FROM player_stats WHERE uuid=$1").bind(&buyer).fetch_one(&pool).await?;
            market_eq!(balance,80);
            let balance: i64=sqlx::query_scalar("SELECT coins FROM player_stats WHERE uuid=$1").bind(&seller).fetch_one(&pool).await?;
            market_eq!(balance,20);
            let quantity: i64=sqlx::query_scalar("SELECT sum(quantity)::bigint FROM market_tasks WHERE uuid=$1 AND kind='deliver'").bind(&buyer).fetch_one(&pool).await?;
            market_eq!(quantity,2);
            buy["quantity"]=serde_json::json!(3);
            market_eq!(market_request(&pool,&path,Some(&buyer_cookie),buy.clone(),true).await?,StatusCode::CONFLICT);
            let view=body_json(get_with_cookie(&pool,"/api/marketplace",Some(&buyer_cookie)).await?).await?;
            let listing=view["listings"].as_array().unwrap().iter().find(|v| v["id"]==id).unwrap();
            market_eq!(listing["remaining"],10); market_eq!(listing["lot_price"],13); // ceil(15 * 10 / 12)
            market_eq!(market_request(&pool,&format!("/api/marketplace/{id}/cancel"),Some(&buyer_cookie),serde_json::json!({}),true).await?,StatusCode::NOT_FOUND);
            market_eq!(market_request(&pool,&format!("/api/marketplace/{id}/cancel"),Some(&cookie),serde_json::json!({}),true).await?,StatusCode::ACCEPTED);
            let returned: i32=sqlx::query_scalar("SELECT quantity FROM market_tasks WHERE uuid=$1 AND kind='deliver'").bind(&seller).fetch_one(&pool).await?;
            market_eq!(returned,10);
            market_eq!(send(&pool,"DELETE",&format!("/api/link/{seller}"),Some(&cookie),None).await?.status(),StatusCode::CONFLICT);
            market_eq!(market_ack(&pool,&seller,"done",snapshot["slots"].clone()).await?,StatusCode::OK);
            market_eq!(market_ack(&pool,&buyer,"done",snapshot["slots"].clone()).await?,StatusCode::OK);
            market_eq!(send(&pool,"DELETE",&format!("/api/link/{seller}"),Some(&cookie),None).await?.status(),StatusCode::NO_CONTENT);
            Ok::<_,Box<dyn std::error::Error>>(())
        }.await;
        clear_market(&pool, &[seller.clone(), buyer.clone()]).await?;
        delete_user(&pool, &email).await?;
        delete_user(&pool, &buyer_email).await?;
        delete_player_inventory(&pool, &seller).await?;
        delete_player_inventory(&pool, &buyer).await?;
        outcome
    }

    #[tokio::test]
    async fn marketplace_last_lot_has_one_winner_and_no_partial_charges() -> TestResult {
        let pool = connect().await?;
        let (email, cookie) = fresh_user(&pool).await?;
        let (buyer_email, buyer_cookie) = fresh_user(&pool).await?;
        let seller = test_uuid(&random_ip());
        let buyer = test_uuid(&random_ip());
        let outcome=async {
            claim(&pool,&start_code(&pool,&cookie).await?,&seller,"SellerTest").await?;
            claim(&pool,&start_code(&pool,&buyer_cookie).await?,&buyer,"BuyerTest").await?;
            let snapshot=seed_market_inventory(&pool,&seller).await?;
            market_request(&pool,&format!("/api/players/{seller}/inventory/marketplace"),Some(&cookie),market_input(1),true).await?;
            market_ack(&pool,&seller,"done",snapshot["slots"].clone()).await?;
            sqlx::query("INSERT INTO player_stats(uuid,username,coins) VALUES($1,'BuyerTest',100)").bind(&buyer).execute(&pool).await?;
            let id: String=sqlx::query_scalar("SELECT id FROM market_listings WHERE uuid=$1").bind(&seller).fetch_one(&pool).await?;
            let path=format!("/api/marketplace/{id}/buy");
            let buy=serde_json::json!({"request_id":test_uuid(&random_ip()),"buyer_uuid":buyer,"quantity":1,"pricing":"lot","expected_total":15,"expected_remaining":1});
            let mut second=buy.clone(); second["request_id"]=serde_json::json!(test_uuid(&random_ip()));
            let (one,two)=tokio::join!(market_request(&pool,&path,Some(&buyer_cookie),buy.clone(),true),market_request(&pool,&path,Some(&buyer_cookie),second,true));
            market_check!(matches!((one?,two?),(StatusCode::ACCEPTED,StatusCode::CONFLICT)|(StatusCode::CONFLICT,StatusCode::ACCEPTED)));
            let coins: i64=sqlx::query_scalar("SELECT coins FROM player_stats WHERE uuid=$1").bind(&buyer).fetch_one(&pool).await?;
            market_eq!(coins,85);
            let tasks: i64=sqlx::query_scalar("SELECT count(*) FROM market_tasks WHERE uuid=$1 AND kind='deliver'").bind(&buyer).fetch_one(&pool).await?;
            market_eq!(tasks,1);
            Ok::<_,Box<dyn std::error::Error>>(())
        }.await;
        clear_market(&pool, &[seller.clone(), buyer.clone()]).await?;
        delete_user(&pool, &email).await?;
        delete_user(&pool, &buyer_email).await?;
        delete_player_inventory(&pool, &seller).await?;
        delete_player_inventory(&pool, &buyer).await?;
        outcome
    }

    #[tokio::test]
    async fn marketplace_search_and_pagination_do_not_expose_pending_items() -> TestResult {
        let pool = connect().await?;
        let (email, cookie) = fresh_user(&pool).await?;
        let (other_email, other_cookie) = fresh_user(&pool).await?;
        let uuid = test_uuid(&random_ip());
        let marker = random_id().to_lowercase();
        let outcome=async {
            let user: i64=sqlx::query_scalar("SELECT id FROM users WHERE email=$1").bind(&email).fetch_one(&pool).await?;
            let item=serde_json::json!({"key":"minecraft:rotten_flesh","amount":1,"display_name":marker,"enchantments":{},"fingerprint":"a".repeat(64)});
            for i in 0..53 {
                sqlx::query("INSERT INTO market_listings(id,user_id,uuid,username,item,quantity,remaining,unit_price,status,created_at) VALUES($1,$2,$3,'PageFixture',$4,1,1,1,'active',now()-$5*interval '1 second')")
                    .bind(new_session_token().map_err(|s| format!("{s}"))?).bind(user).bind(&uuid).bind(&item).bind(i as f64).execute(&pool).await?;
            }
            sqlx::query("INSERT INTO market_listings(id,user_id,uuid,username,item,quantity,remaining,unit_price,status) VALUES($1,$2,$3,'PageFixture',$4,1,1,1,'pending')")
                .bind(new_session_token().map_err(|s| format!("{s}"))?).bind(user).bind(&uuid).bind(item).execute(&pool).await?;
            let path=format!("/api/marketplace?q={marker}");
            let first=body_json(get_with_cookie(&pool,&path,Some(&other_cookie)).await?).await?;
            market_eq!(first["listings"].as_array().unwrap().len(),50);
            market_check!(first["listings"].as_array().unwrap().iter().all(|v| v["status"]=="active" && v.get("item_bytes").is_none()));
            let cursor=first["next_cursor"].as_str().ok_or("Missing cursor")?;
            let second=body_json(get_with_cookie(&pool,&format!("{path}&cursor={cursor}"),Some(&other_cookie)).await?).await?;
            market_eq!(second["listings"].as_array().unwrap().len(),3);
            market_check!(second["next_cursor"].is_null());
            market_check!(second["listings"].as_array().unwrap().iter().all(|b| !first["listings"].as_array().unwrap().iter().any(|a| a["id"]==b["id"])));
            let own=body_json(get_with_cookie(&pool,&format!("{path}&mine=true"),Some(&cookie)).await?).await?;
            market_eq!(own["listings"][0]["status"],"pending");
            let stranger=body_json(get_with_cookie(&pool,&format!("{path}&mine=true"),Some(&other_cookie)).await?).await?;
            market_eq!(stranger["listings"].as_array().unwrap().len(),0);
            let readable=body_json(get_with_cookie(&pool,"/api/marketplace?q=rotten%20flesh",Some(&other_cookie)).await?).await?;
            market_check!(readable["listings"].as_array().unwrap().iter().any(|v| v["item"]["display_name"]==marker));
            Ok::<_,Box<dyn std::error::Error>>(())
        }.await;
        clear_market(&pool, std::slice::from_ref(&uuid)).await?;
        delete_user(&pool, &email).await?;
        delete_user(&pool, &other_email).await?;
        outcome
    }

    #[tokio::test]
    async fn item_icons_are_cached_once_and_served_with_inventory() -> TestResult {
        let pool = connect().await?;
        let (email, cookie) = fresh_user(&pool).await?;
        let uuid = test_uuid(&random_ip());
        let token = test_service_token();
        let first_key = format!("invtest-{}:a", random_id().to_lowercase());
        let second_key = format!("invtest-{}:b", random_id().to_lowercase());
        let outcome = async {
            let linked = claim(&pool, &start_code(&pool, &cookie).await?, &uuid, "InvTest").await?;
            let body = serde_json::json!({ "items": [
                { "key": first_key, "icon": INVENTORY_ICON_PNG },
                { "key": second_key, "icon": INVENTORY_ICON_PNG }
            ]});
            let missing = post_internal(&pool, "/internal/items/icons", None, body.clone(), &random_ip()).await?.status();
            let bad_key = post_internal(&pool, "/internal/items/icons", Some(&token), serde_json::json!({ "items": [{ "key": "Bad Key", "icon": INVENTORY_ICON_PNG }] }), &random_ip()).await?.status();
            let unqualified = post_internal(&pool, "/internal/items/icons", Some(&token), serde_json::json!({ "items": [{ "key": "stone_sword", "icon": INVENTORY_ICON_PNG }] }), &random_ip()).await?.status();
            let bad_png = post_internal(&pool, "/internal/items/icons", Some(&token), serde_json::json!({ "items": [{ "key": "invtest:notpng", "icon": "bm90LWEtcG5n" }] }), &random_ip()).await?.status();
            let duplicate = post_internal(&pool, "/internal/items/icons", Some(&token), serde_json::json!({ "items": [
                { "key": first_key, "icon": INVENTORY_ICON_PNG },
                { "key": first_key, "icon": INVENTORY_ICON_PNG }
            ]}), &random_ip()).await?.status();
            let accepted = post_internal(&pool, "/internal/items/icons", Some(&token), body, &random_ip()).await?.status();
            // A later, different upload for the same key must not overwrite it.
            let replacement = post_internal(&pool, "/internal/items/icons", Some(&token), serde_json::json!({ "items": [{ "key": first_key, "icon": INVENTORY_ICON_PNG_OTHER }] }), &random_ip()).await?.status();
            let stored: Option<String> = sqlx::query_scalar("SELECT data_url FROM item_icons WHERE key = $1").bind(&first_key).fetch_optional(&pool).await?;
            // The inventory report names the stored keys and the read answers icons.
            let mut snapshot = inventory_body(&uuid, "InvTest");
            snapshot["slots"][0]["key"] = serde_json::json!(first_key);
            snapshot["slots"][36]["key"] = serde_json::json!(second_key);
            let reported = post_inventory(&pool, Some(&token), snapshot).await?;
            let (status, response) = get_inventory(&pool, Some(&cookie), &uuid).await?;
            let found = body_json(response).await?;
            Ok::<_, Box<dyn std::error::Error>>((linked, missing, bad_key, unqualified, bad_png, duplicate, accepted, replacement, stored, reported, status, found))
        }.await;
        delete_user(&pool, &email).await?;
        delete_player_inventory(&pool, &uuid).await?;
        delete_item_icons(&pool, &[first_key.clone(), second_key.clone()]).await?;
        let (linked, missing, bad_key, unqualified, bad_png, duplicate, accepted, replacement, stored, reported, status, found) = outcome?;
        assert_eq!(linked, StatusCode::OK);
        assert_eq!(missing, StatusCode::UNAUTHORIZED);
        assert_eq!(bad_key, StatusCode::BAD_REQUEST);
        assert_eq!(unqualified, StatusCode::BAD_REQUEST);
        assert_eq!(bad_png, StatusCode::BAD_REQUEST);
        assert_eq!(duplicate, StatusCode::BAD_REQUEST);
        assert_eq!(accepted, StatusCode::OK);
        assert_eq!(replacement, StatusCode::OK);
        assert_eq!(stored, Some(format!("data:image/png;base64,{INVENTORY_ICON_PNG}")));
        assert_eq!(reported, StatusCode::OK);
        assert_eq!(status, StatusCode::OK);
        assert_eq!(found["slots"][0]["icon"], format!("data:image/png;base64,{INVENTORY_ICON_PNG}"));
        assert_eq!(found["slots"][36]["icon"], format!("data:image/png;base64,{INVENTORY_ICON_PNG}"));
        Ok(())
    }

    // --- Minigames -------------------------------------------------------------

    // A logged-in user with one linked account that already holds `coins` coins.
    // The coins arrive the way the game server sends them — a reported block-break
    // count — so a test never invents a balance the panel could not have had.
    // Cleanup is the caller's: rounds cascade with the user, `player_stats` cannot.
    async fn paid_player(
        pool: &sqlx::PgPool,
        coins: i64
    ) -> Result<(String, String, String), Box<dyn std::error::Error>> {
        let (email, cookie) = fresh_user(pool).await?;
        let uuid = test_uuid(&email);
        let code = start_code(pool, &cookie).await?;
        claim(pool, &code, &uuid, "Miner").await?;
        report_stats(
            pool,
            Some(&test_service_token()),
            vec![stats_player_with(&uuid, "Miner", 300, 0, coins, serde_json::json!({}))]
        ).await?;
        Ok((email, cookie, uuid))
    }

    async fn post_session(
        pool: &sqlx::PgPool,
        uri: &str,
        cookie: &str,
        body: serde_json::Value
    ) -> Result<axum::response::Response, Box<dyn std::error::Error>> {
        send(pool, "POST", uri, Some(cookie), Some(body)).await
    }

    async fn coins_of(pool: &sqlx::PgPool, uuid: &str) -> Result<i64, Box<dyn std::error::Error>> {
        Ok(
            sqlx::query_scalar("SELECT coins FROM player_stats WHERE uuid = $1")
                .bind(uuid)
                .fetch_one(pool).await?
        )
    }

    // The stored round row: status, stake, payout and why it settled.
    async fn round_row(
        pool: &sqlx::PgPool,
        round_id: &str
    ) -> Result<(String, i64, i64, Option<String>), Box<dyn std::error::Error>> {
        Ok(
            sqlx::query_as(
                "SELECT status, bet, payout, outcome FROM minigame_rounds WHERE id = $1::uuid"
            )
                .bind(round_id)
                .fetch_one(pool).await?
        )
    }

    // The secret field. A test may read it; the API never names a cell before the
    // player opens it. This is how a loss gets tested without weakening the rules.
    async fn mines_board(
        pool: &sqlx::PgPool,
        round_id: &str
    ) -> Result<Vec<String>, Box<dyn std::error::Error>> {
        let raw: String = sqlx
            ::query_scalar("SELECT state::text FROM minigame_rounds WHERE id = $1::uuid")
            .bind(round_id)
            .fetch_one(pool).await?;
        let state: serde_json::Value = serde_json::from_str(&raw)?;
        Ok(
            state["board"]
                .as_array()
                .ok_or("state has no board")?
                .iter()
                .map(|value| value.as_str().unwrap_or_default().to_owned())
                .collect()
        )
    }

    fn cell_of(board: &[String], content: &str) -> usize {
        board
            .iter()
            .position(|value| value == content)
            .unwrap_or_else(|| panic!("the field must hold {content}"))
    }

    /// Return of cashing out after exactly `k` safe cells, in ten-thousandths and
    /// as an exact fraction: (survival chance) × (multiplier). Integers only, so
    /// two cash-out depths compare exactly.
    fn mines_cashout_return_x10000(preset: &MinesPreset, k: usize) -> i128 {
        let safe = mines_safe_cells(preset.mines);
        let (iron, gold, _diamond) = mines_ores(preset.mines);
        let boost_sum =
            iron as i128 * preset.boost_iron as i128 +
            gold as i128 * preset.boost_gold as i128 +
            preset.boost_diamond as i128;
        let mut numerator: i128 = 1;
        let mut denominator: i128 = 1;
        for step in 0..k {
            numerator *= (safe - step) as i128;
            denominator *= (MINES_CELLS - step) as i128;
        }
        // E[multiplier] after k safe cells is 100 + k·boost_sum/safe hundredths.
        let multiplier = 100 * safe as i128 + k as i128 * boost_sum;
        10_000 * numerator * multiplier / (denominator * safe as i128 * 100)
    }

    #[tokio::test]
    async fn chest_spin_moves_real_coins_and_a_retry_never_charges_twice() -> TestResult {
        let pool = connect().await?;
        let (email, cookie, uuid) = paid_player(&pool, 1_000).await?;
        let client_id = test_uuid(&random_ip());
        let spin = post_session(
            &pool,
            "/api/minigames/chest/spin",
            &cookie,
            serde_json::json!({ "uuid": uuid, "bet": 50, "client_id": client_id })
        ).await?;
        let spin_status = spin.status();
        let spin = body_json(spin).await?;
        let round_id = spin["round_id"].as_str().unwrap_or_default().to_owned();
        let payout = spin["payout"].as_i64().unwrap_or(-1);
        let multiplier = spin["multiplier_x100"].as_i64().unwrap_or(-1);
        let reported = spin["balance"].as_i64().unwrap_or(-1);
        let reels = spin["reels"].as_array().cloned().unwrap_or_default();
        let after_spin = coins_of(&pool, &uuid).await?;
        let row = round_row(&pool, &round_id).await?;

        // The same client id is the same spin: a retry must not buy a second one.
        let retry = post_session(
            &pool,
            "/api/minigames/chest/spin",
            &cookie,
            serde_json::json!({ "uuid": uuid, "bet": 50, "client_id": client_id })
        ).await?;
        let retry_status = retry.status();
        let retry = body_json(retry).await?;
        let after_retry = coins_of(&pool, &uuid).await?;
        delete_player_stats(&pool, &uuid).await?;
        delete_user(&pool, &email).await?;

        assert_eq!(spin_status, StatusCode::OK);
        assert_eq!(retry_status, StatusCode::OK);
        assert_eq!(reels.len(), 3, "a spin lands three reels");
        // The payout comes from the server's own roll, and the balance follows it.
        assert_eq!(payout, 50 * multiplier / 100, "the payout matches the multiplier");
        assert_eq!(after_spin, 1_000 - 50 + payout, "stake out, winnings in");
        assert_eq!(reported, after_spin, "the reported balance is the stored balance");
        assert_eq!(row.0, "settled");
        assert_eq!(row.1, 50, "the round records the stake");
        assert_eq!(row.2, payout);
        assert_eq!(row.3.as_deref(), Some(if payout > 0 { "paid" } else { "lost" }));
        assert_eq!(retry["round_id"], serde_json::json!(round_id), "the retry is the same spin");
        assert_eq!(retry["payout"], serde_json::json!(payout));
        assert_eq!(after_retry, after_spin, "a retry is never charged");
        Ok(())
    }

    #[tokio::test]
    async fn chest_spin_refuses_another_users_account_and_a_stake_it_cannot_cover() -> TestResult {
        let pool = connect().await?;
        let (owner_email, _, owner_uuid) = paid_player(&pool, 1_000).await?;
        let (stranger_email, stranger_cookie, stranger_uuid) = paid_player(&pool, 1_000).await?;
        let client_id = test_uuid(&random_ip());

        // Someone else's linked account is simply not there.
        let foreign = post_session(
            &pool,
            "/api/minigames/chest/spin",
            &stranger_cookie,
            serde_json::json!({ "uuid": owner_uuid, "bet": 50, "client_id": client_id })
        ).await?.status();
        let anonymous = post_json(
            &pool,
            "/api/minigames/chest/spin",
            serde_json::json!({ "uuid": owner_uuid, "bet": 50, "client_id": client_id })
        ).await?;
        // A stake below the minimum, above the maximum, or with no usable id.
        let under = post_session(
            &pool,
            "/api/minigames/chest/spin",
            &stranger_cookie,
            serde_json::json!({ "uuid": stranger_uuid, "bet": 1, "client_id": client_id })
        ).await?.status();
        let over = post_session(
            &pool,
            "/api/minigames/chest/spin",
            &stranger_cookie,
            serde_json::json!({ "uuid": stranger_uuid, "bet": 10_000_000, "client_id": client_id })
        ).await?.status();
        let malformed = post_session(
            &pool,
            "/api/minigames/chest/spin",
            &stranger_cookie,
            serde_json::json!({ "uuid": stranger_uuid, "bet": 50, "client_id": "not-a-uuid" })
        ).await?.status();

        // A balance that cannot cover the stake: refused, and nothing is taken.
        let (broke_email, broke_cookie, broke_uuid) = paid_player(&pool, 20).await?;
        let refused = post_session(
            &pool,
            "/api/minigames/chest/spin",
            &broke_cookie,
            serde_json::json!({ "uuid": broke_uuid, "bet": 50, "client_id": client_id })
        ).await?.status();
        let untouched = coins_of(&pool, &broke_uuid).await?;

        delete_player_stats(&pool, &owner_uuid).await?;
        delete_user(&pool, &owner_email).await?;
        delete_player_stats(&pool, &stranger_uuid).await?;
        delete_user(&pool, &stranger_email).await?;
        delete_player_stats(&pool, &broke_uuid).await?;
        delete_user(&pool, &broke_email).await?;

        assert_eq!(foreign, StatusCode::NOT_FOUND, "a UUID that is not yours is not found");
        assert_eq!(anonymous, StatusCode::UNAUTHORIZED);
        assert_eq!(under, StatusCode::BAD_REQUEST);
        assert_eq!(over, StatusCode::BAD_REQUEST);
        assert_eq!(malformed, StatusCode::BAD_REQUEST);
        assert_eq!(refused, StatusCode::CONFLICT, "an unaffordable stake is a conflict");
        assert_eq!(untouched, 20, "a refused stake leaves the balance alone");
        Ok(())
    }

    #[tokio::test]
    async fn mines_round_names_only_opened_cells_and_pays_out_once() -> TestResult {
        let pool = connect().await?;
        let (email, cookie, uuid) = paid_player(&pool, 1_000).await?;
        let started = post_session(
            &pool,
            "/api/minigames/mines/start",
            &cookie,
            serde_json::json!({ "uuid": uuid, "bet": 100, "mines": 8 })
        ).await?;
        let started_status = started.status();
        let started = body_json(started).await?;
        let round_id = started["round_id"].as_str().unwrap_or_default().to_owned();
        let charged = coins_of(&pool, &uuid).await?;
        let board = mines_board(&pool, &round_id).await?;
        let iron_cells: Vec<i64> = board
            .iter()
            .enumerate()
            .filter(|(_, content)| content.as_str() == "iron")
            .take(2)
            .map(|(index, _)| index as i64)
            .collect();

        let first = post_session(
            &pool,
            "/api/minigames/mines/reveal",
            &cookie,
            serde_json::json!({ "round_id": round_id, "cell": iron_cells[0] })
        ).await?;
        let first = body_json(first).await?;
        // Opening the same cell again is not an error: it is the same round.
        let repeat = post_session(
            &pool,
            "/api/minigames/mines/reveal",
            &cookie,
            serde_json::json!({ "round_id": round_id, "cell": iron_cells[0] })
        ).await?;
        let repeat = body_json(repeat).await?;
        let second = post_session(
            &pool,
            "/api/minigames/mines/reveal",
            &cookie,
            serde_json::json!({ "round_id": round_id, "cell": iron_cells[1] })
        ).await?;
        let second = body_json(second).await?;
        let cashout = post_session(
            &pool,
            "/api/minigames/mines/cashout",
            &cookie,
            serde_json::json!({ "round_id": round_id })
        ).await?;
        let cashout_status = cashout.status();
        let cashout = body_json(cashout).await?;
        let payout = cashout["payout"].as_i64().unwrap_or(-1);
        let after_cashout = coins_of(&pool, &uuid).await?;
        // Repeating a successful cash-out returns the settled round and pays nothing.
        let again = post_session(
            &pool,
            "/api/minigames/mines/cashout",
            &cookie,
            serde_json::json!({ "round_id": round_id })
        ).await?;
        let again_status = again.status();
        let again = body_json(again).await?;
        let after_again = coins_of(&pool, &uuid).await?;
        let row = round_row(&pool, &round_id).await?;
        delete_player_stats(&pool, &uuid).await?;
        delete_user(&pool, &email).await?;

        assert_eq!(started_status, StatusCode::OK);
        assert_eq!(started["bet"], serde_json::json!(100));
        assert_eq!(started["mines"], serde_json::json!(8));
        assert_eq!(started["multiplier_x100"], serde_json::json!(100), "a fresh field starts at x1");
        assert_eq!(started["revealed"].as_array().map(Vec::len), Some(0), "the field arrives hidden");
        assert_eq!(charged, 900, "the stake leaves the balance when the round starts");
        assert_eq!(board.len(), MINES_CELLS);
        assert_eq!(first["status"], serde_json::json!("active"));
        assert_eq!(first["multiplier_x100"], serde_json::json!(135), "one iron ingot pays +0.35");
        assert_eq!(repeat["multiplier_x100"], first["multiplier_x100"], "a repeat reveals nothing");
        assert_eq!(second["multiplier_x100"], serde_json::json!(170));
        assert_eq!(second["cashout"], serde_json::json!(170));
        assert_eq!(cashout_status, StatusCode::OK);
        assert_eq!(cashout["status"], serde_json::json!("settled"));
        assert_eq!(cashout["outcome"], serde_json::json!("paid"));
        assert_eq!(
            cashout["revealed"].as_array().map(Vec::len),
            Some(MINES_CELLS),
            "a settled round shows the whole field"
        );
        assert_eq!(payout, 170, "two iron ingots on a stake of 100");
        assert_eq!(after_cashout, 900 + payout);
        assert_eq!(again_status, StatusCode::OK);
        assert_eq!(again["payout"], serde_json::json!(payout));
        assert_eq!(after_again, after_cashout, "a repeated cash-out never pays twice");
        assert_eq!(row.0, "settled");
        assert_eq!(row.2, payout);
        Ok(())
    }

    #[tokio::test]
    async fn mines_explosion_forfeits_the_stake_and_the_next_round_starts_clean() -> TestResult {
        let pool = connect().await?;
        let (email, cookie, uuid) = paid_player(&pool, 1_000).await?;
        let started = post_session(
            &pool,
            "/api/minigames/mines/start",
            &cookie,
            serde_json::json!({ "uuid": uuid, "bet": 100, "mines": 8 })
        ).await?;
        let started = body_json(started).await?;
        let round_id = started["round_id"].as_str().unwrap_or_default().to_owned();
        let board = mines_board(&pool, &round_id).await?;
        let tnt = cell_of(&board, "tnt") as i64;
        let exploded = post_session(
            &pool,
            "/api/minigames/mines/reveal",
            &cookie,
            serde_json::json!({ "round_id": round_id, "cell": tnt })
        ).await?;
        let exploded_status = exploded.status();
        let exploded = body_json(exploded).await?;
        let after = coins_of(&pool, &uuid).await?;
        let row = round_row(&pool, &round_id).await?;
        // The settled round no longer blocks the next one.
        let next = post_session(
            &pool,
            "/api/minigames/mines/start",
            &cookie,
            serde_json::json!({ "uuid": uuid, "bet": 100, "mines": 8 })
        ).await?;
        let next_status = next.status();
        let next = body_json(next).await?;
        let after_next = coins_of(&pool, &uuid).await?;
        delete_player_stats(&pool, &uuid).await?;
        delete_user(&pool, &email).await?;

        assert_eq!(exploded_status, StatusCode::OK);
        assert_eq!(exploded["status"], serde_json::json!("settled"));
        assert_eq!(exploded["outcome"], serde_json::json!("lost"));
        assert_eq!(exploded["payout"], serde_json::json!(0));
        assert_eq!(
            exploded["revealed"].as_array().map(Vec::len),
            Some(MINES_CELLS),
            "the TNT is shown once the round is over"
        );
        assert_eq!(after, 900, "the stake was taken at the start and is not returned");
        assert_eq!(row.0, "settled");
        assert_eq!(row.3.as_deref(), Some("lost"));
        assert_eq!(next_status, StatusCode::OK);
        assert_ne!(next["round_id"], serde_json::json!(round_id), "a fresh field, not the dead one");
        assert_eq!(after_next, 800);
        Ok(())
    }

    #[tokio::test]
    async fn mines_start_resumes_a_live_round_and_refuses_the_impossible() -> TestResult {
        let pool = connect().await?;
        let (email, cookie, uuid) = paid_player(&pool, 1_000).await?;
        let started = post_session(
            &pool,
            "/api/minigames/mines/start",
            &cookie,
            serde_json::json!({ "uuid": uuid, "bet": 100, "mines": 8 })
        ).await?;
        let started = body_json(started).await?;
        let round_id = started["round_id"].as_str().unwrap_or_default().to_owned();

        // Starting again is the same field and the same single stake, whatever the
        // second request asked for.
        let resumed = post_session(
            &pool,
            "/api/minigames/mines/start",
            &cookie,
            serde_json::json!({ "uuid": uuid, "bet": 500, "mines": 16 })
        ).await?;
        let resumed_status = resumed.status();
        let resumed = body_json(resumed).await?;
        let charged_once = coins_of(&pool, &uuid).await?;

        let early_cashout = post_session(
            &pool,
            "/api/minigames/mines/cashout",
            &cookie,
            serde_json::json!({ "round_id": round_id })
        ).await?.status();
        let bad_cell = post_session(
            &pool,
            "/api/minigames/mines/reveal",
            &cookie,
            serde_json::json!({ "round_id": round_id, "cell": 25 })
        ).await?.status();
        let bad_round = post_session(
            &pool,
            "/api/minigames/mines/reveal",
            &cookie,
            serde_json::json!({ "round_id": "bad", "cell": 0 })
        ).await?.status();
        let unknown_round = post_session(
            &pool,
            "/api/minigames/mines/reveal",
            &cookie,
            serde_json::json!({ "round_id": test_uuid(&random_ip()), "cell": 0 })
        ).await?.status();
        // A table that does not exist is refused before anything else happens.
        let wrong_mines = post_session(
            &pool,
            "/api/minigames/mines/start",
            &cookie,
            serde_json::json!({ "uuid": uuid, "bet": 100, "mines": 9 })
        ).await?.status();
        let state = get_with_cookie(&pool, "/api/minigames/state", Some(&cookie)).await?;
        let state = body_json(state).await?;

        // Another user cannot see or settle this round, not even to lose it.
        let (stranger_email, stranger_cookie) = fresh_user(&pool).await?;
        let no_round = post_session(
            &pool,
            "/api/minigames/mines/cashout",
            &stranger_cookie,
            serde_json::json!({ "round_id": round_id })
        ).await?.status();

        delete_player_stats(&pool, &uuid).await?;
        delete_user(&pool, &email).await?;
        delete_user(&pool, &stranger_email).await?;

        assert_eq!(resumed_status, StatusCode::OK);
        assert_eq!(resumed["round_id"], serde_json::json!(round_id), "starting twice resumes");
        assert_eq!(resumed["bet"], serde_json::json!(100), "the live stake is the one that stands");
        assert_eq!(resumed["mines"], serde_json::json!(8));
        assert_eq!(charged_once, 900, "a resume never stakes again");
        assert_eq!(early_cashout, StatusCode::BAD_REQUEST, "two ores are the minimum to cash out");
        assert_eq!(bad_cell, StatusCode::BAD_REQUEST);
        assert_eq!(bad_round, StatusCode::BAD_REQUEST);
        assert_eq!(unknown_round, StatusCode::NOT_FOUND);
        assert_eq!(wrong_mines, StatusCode::BAD_REQUEST, "9 TNT is not a table");
        assert_eq!(state["active"]["round_id"], serde_json::json!(round_id));
        assert_eq!(no_round, StatusCode::NOT_FOUND, "another user's round does not exist for you");
        Ok(())
    }

    #[tokio::test]
    async fn an_abandoned_mines_round_forfeits_its_stake_once() -> TestResult {
        let pool = connect().await?;
        let (email, cookie, uuid) = paid_player(&pool, 1_000).await?;
        let started = post_session(
            &pool,
            "/api/minigames/mines/start",
            &cookie,
            serde_json::json!({ "uuid": uuid, "bet": 100, "mines": 8 })
        ).await?;
        let started = body_json(started).await?;
        let round_id = started["round_id"].as_str().unwrap_or_default().to_owned();
        // A tab that was really gone: past the abandonment deadline.
        sqlx::query(
            "UPDATE minigame_rounds SET created_at = now() - make_interval(secs => $2)
              WHERE id = $1::uuid"
        )
            .bind(&round_id)
            .bind((MINIGAME_ROUND_TTL_SECONDS + 60) as f64)
            .execute(&pool).await?;
        let state = get_with_cookie(&pool, "/api/minigames/state", Some(&cookie)).await?;
        let state = body_json(state).await?;
        let row = round_row(&pool, &round_id).await?;
        let after = coins_of(&pool, &uuid).await?;
        let restarted = post_session(
            &pool,
            "/api/minigames/mines/start",
            &cookie,
            serde_json::json!({ "uuid": uuid, "bet": 100, "mines": 8 })
        ).await?;
        let restarted = body_json(restarted).await?;
        let after_restart = coins_of(&pool, &uuid).await?;
        delete_player_stats(&pool, &uuid).await?;
        delete_user(&pool, &email).await?;

        assert_eq!(state["active"], serde_json::Value::Null, "the abandoned round is closed");
        assert_eq!(row.0, "settled");
        assert_eq!(row.3.as_deref(), Some("expired"));
        assert_eq!(row.2, 0, "an abandoned stake is not returned");
        assert_eq!(after, 900);
        assert_ne!(restarted["round_id"], serde_json::json!(round_id));
        assert_eq!(after_restart, 800);
        Ok(())
    }

    #[tokio::test]
    async fn every_minigame_route_that_spends_or_owns_requires_a_session() -> TestResult {
        let pool = connect().await?;
        let uuid = test_uuid(&random_ip());
        let round_id = test_uuid(&random_ip());
        let state = get_with_cookie(&pool, "/api/minigames/state", None).await?.status();
        // The paytable is public: it says what is paid, not who holds what.
        let config = get_with_cookie(&pool, "/api/minigames/config", None).await?.status();
        let spin = post_json(
            &pool,
            "/api/minigames/chest/spin",
            serde_json::json!({ "uuid": uuid, "bet": 50, "client_id": test_uuid(&random_ip()) })
        ).await?;
        let start = post_json(
            &pool,
            "/api/minigames/mines/start",
            serde_json::json!({ "uuid": uuid, "bet": 50, "mines": 8 })
        ).await?;
        let reveal = post_json(
            &pool,
            "/api/minigames/mines/reveal",
            serde_json::json!({ "round_id": round_id, "cell": 0 })
        ).await?;
        let cashout = post_json(
            &pool,
            "/api/minigames/mines/cashout",
            serde_json::json!({ "round_id": round_id })
        ).await?;
        let unknown = get_with_cookie(&pool, "/api/minigames/nope", None).await?.status();
        assert_eq!(config, StatusCode::OK);
        assert_eq!(state, StatusCode::UNAUTHORIZED);
        assert_eq!(spin, StatusCode::UNAUTHORIZED);
        assert_eq!(start, StatusCode::UNAUTHORIZED);
        assert_eq!(reveal, StatusCode::UNAUTHORIZED);
        assert_eq!(cashout, StatusCode::UNAUTHORIZED);
        assert_eq!(unknown, StatusCode::NOT_FOUND);
        Ok(())
    }

    #[tokio::test]
    async fn the_published_paytable_matches_the_tables_the_server_pays_from() -> TestResult {
        let pool = connect().await?;
        let response = get_with_cookie(&pool, "/api/minigames/config", None).await?;
        assert_eq!(response.status(), StatusCode::OK);
        let config = body_json(response).await?;
        assert_eq!(config["min_bet"], serde_json::json!(MINIGAME_MIN_BET));
        assert_eq!(config["max_bet"], serde_json::json!(MINIGAME_MAX_BET));
        assert_eq!(config["chest"]["rtp_x10000"], serde_json::json!(chest_rtp_x10000()));
        assert_eq!(config["chest"]["symbols"].as_array().map(Vec::len), Some(CHEST_SYMBOLS.len()));
        assert_eq!(config["mines"]["cells"], serde_json::json!(MINES_CELLS));
        let presets = config["mines"]["presets"].as_array().ok_or("no presets")?;
        assert_eq!(presets.len(), MINES_PRESETS.len());
        for (index, preset) in MINES_PRESETS.iter().enumerate() {
            assert_eq!(presets[index]["mines"], serde_json::json!(preset.mines as i64));
            assert_eq!(presets[index]["rtp_x10000"], serde_json::json!(mines_rtp_x10000(preset)));
        }
        Ok(())
    }

    #[tokio::test]
    async fn the_minigame_tables_keep_a_house_margin_at_the_best_cash_out() -> TestResult {
        // The chest: a pair must be a real win, a triple must beat its own pair, and
        // the whole table must return less than it takes.
        let weight_sum: u64 = CHEST_SYMBOLS.iter().map(|symbol| symbol.triple_weight).sum();
        assert_eq!(weight_sum, 100, "the three-of-a-kind weights are a distribution");
        for symbol in CHEST_SYMBOLS.iter() {
            assert!(
                symbol.triple_x100 > symbol.pair_x100,
                "{} must pay more for three than for two",
                symbol.id
            );
            assert!(symbol.pair_x100 >= 100, "{} must not pay a pair below the stake", symbol.id);
        }
        assert!(
            CHEST_TRIPLE_ROLLS + CHEST_PAIR_ROLLS + CHEST_SINGLE_DIAMOND_ROLLS < CHEST_ROLLS,
            "a spin must be able to pay nothing"
        );
        let chest = chest_rtp_x10000();
        assert!(
            (9_000..=9_500).contains(&chest),
            "the chest returns {chest}/10000, which is not a house margin"
        );

        // Minesweeper: cashing out at the minimum must be the best a player can do,
        // or a deeper round would be a defined way to beat the house.
        for preset in MINES_PRESETS.iter() {
            let safe = mines_safe_cells(preset.mines);
            let (iron, gold, diamond) = mines_ores(preset.mines);
            assert_eq!(iron + gold + diamond, safe, "the field is fully accounted for");
            assert_eq!(diamond, 1, "exactly one diamond");
            assert!(gold >= 2, "at least two gold");
            assert!(preset.boost_diamond > preset.boost_gold);
            assert!(preset.boost_gold > preset.boost_iron);
            let first = mines_cashout_return_x10000(preset, MINES_MIN_SAFE as usize);
            let best = (MINES_MIN_SAFE as usize..=safe)
                .map(|k| mines_cashout_return_x10000(preset, k))
                .max()
                .unwrap_or_default();
            assert_eq!(
                first,
                mines_rtp_x10000(preset) as i128,
                "the reported return is the earliest cash-out"
            );
            assert_eq!(best, first, "{} TNT pays best at the earliest cash-out", preset.mines);
            assert!(
                (9_000..=9_500).contains(&first),
                "{} TNT returns {first}/10000, which is not a house margin",
                preset.mines
            );
        }
        Ok(())
    }

}
