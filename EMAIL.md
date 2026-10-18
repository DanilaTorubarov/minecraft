# Automatic account emails

The website sends registration codes, mailbox-confirmation links, and security notifications using
SMTP (the standard protocol for sending email). The website server sends the
message to a delivery provider, and the provider delivers it to Gmail, Outlook,
or the recipient's other mailbox. You do not need to operate your own mail server.

## Try it locally first

Local development is configured to use **Mailpit**, a fake delivery server:

1. Open `https://localhost/register`, enter the account details, and press
   **Send confirmation code**. The account does not exist yet.
2. Open **http://localhost:8025** and read the six-digit registration code.
   Local mail appears here even for a made-up address; it does not arrive in a
   real inbox. Enter the code in the same registration window within 15 minutes.
3. Press **Confirm email & create account**. The address is marked verified and
   the website signs you in. Codes work once; a resend invalidates the old code.
   Resends require a 60-second wait, with at most five emails per mailbox per
   hour and five incorrect attempts per code. An expired/exhausted code requires
   a new request. Reloading the registration page also requires a new request.
4. Later email changes remain in **Account → Security**: enter the current
   website password and request confirmation of the destination address. That
   separate flow sends a single-use link valid for 15 minutes. Confirming it
   changes the login email and signs website sessions out.

Mailpit's inbox is bound to `127.0.0.1` and its SMTP port is not published. The
container stores preview mail only temporarily; it is not a production mailbox.
Start it with `docker compose --env-file .env.docker up -d mailpit` if needed.

## Deliver real emails

One option is [Resend](https://resend.com/docs/send-with-smtp). Other providers
with authenticated SMTP also work.

1. Own a domain, such as `your-server.example`, and use a public HTTPS address
   for the website. `localhost` links will not work for remote players.
2. Create a provider account and add your sending domain. Copy the DNS records
   shown by the provider into the DNS settings at your domain provider. These
   prove permission to send mail from your domain (SPF/DKIM). Add the provider's
   recommended DMARC policy, and wait for the dashboard to show verification.
   See [Resend's domain guide](https://resend.com/docs/dashboard/domains/introduction).
3. Create SMTP credentials/a sending API key in the provider dashboard. Keep it
   private. Put the following in **`.env.docker`**, replacing the local Mailpit
   values, not adding a second set of the same variables:

```dotenv
SMTP_HOST=smtp.resend.com
SMTP_PORT=587
SMTP_TLS=starttls
SMTP_USERNAME=resend
SMTP_PASSWORD=your_private_sending_api_key
SMTP_FROM=accounts@your-verified-domain.example
PUBLIC_SITE_URL=https://your-public-website.example
```

Those host/username values are Resend-specific. Other providers supply their own.
For implicit TLS on port 465 use `SMTP_TLS=tls`. Never use `none` for a real
provider; the application permits unencrypted SMTP only for local preview hosts.
Use the HTTPS origin without a path, query, or trailing fragment for
`PUBLIC_SITE_URL`. It is configured by the operator, never taken from a request's
Host header. Disable email click/open tracking for security links.

4. Recreate the web app so it reads the new variables:

```sh
docker compose --env-file .env.docker up -d --force-recreate app proxy
```

5. Test with your own real mailbox from **Account → Security**, confirm delivery
   and the link's public hostname, and check the provider dashboard for bounces.
   There is no need to expose SMTP on your server. Never commit credentials or
   put them in frontend code or chat.

## What is implemented

- Registration uses one displayed nickname instead of legal names and requires
  a six-digit email code valid for 15 minutes. Migration `0011` keeps pending
  signups separate from users; they cannot log in. Passwords are Argon2 hashes,
  and codes are hashed together with an unguessable browser challenge. Neither
  the code nor the challenge is stored in plaintext or logged. Confirmation
  creates a verified user and consumes the pending signup in one transaction.
  Existing accounts keep their current verification state and login access.
- `POST /api/register` returns `202 {challenge, expires_in, email_delivery}` only
  after SMTP accepts the message; its JSON response has `Cache-Control: no-store`.
  `POST /api/register/confirm {challenge, code}` returns `201` on success, `400`
  for an invalid/expired/exhausted/used code, or `409` if the email/login became
  taken. IP limits apply to both endpoints; mailbox/resend limits return `429`.
  SMTP failures return `503` and roll back the pending signup. An expired pending
  row is removed on a later registration request. The browser keeps the challenge
  only in memory, never in local storage or a URL.
- Overview contains linking and account details; Security contains password and
  email changes.
- Password changes require the current password and at least 6 characters for
  the new one. They revoke every website session, unused link codes, and pending
  email confirmations. Minecraft passwords and links are unchanged.
- Email verification/changes require the current password plus confirmation from
  the destination mailbox. A change request also notifies the old address.
  The confirmation token is random, stored only as a SHA-256 hash, expires after
  15 minutes, is single-use, and is consumed in the same transaction as the change.
  Confirming signs out website sessions. Requests have IP and per-account limits.
- Missing or failed SMTP returns an explicit error and does not change the email.
  Neither tokens nor passwords are written to application logs.

**Forgot-password recovery is a separate next feature.** This release provides
the email delivery and verification infrastructure, plus signed-in security
changes. A reset flow can use the same SMTP configuration to send a different
single-use token to an already verified mailbox; email-confirmation tokens must
never be accepted as password-reset tokens.

The website database reset does not delete Minecraft AuthMe registrations, worlds,
builds, or server configuration. A private pre-reset SQL backup is stored under
`mc/backups/` (gitignored). Treat backups as sensitive data.
