# GitHub tests and automatic deployment

`.github/workflows/deploy.yml` runs on pushes to `main`. It checks frontend lint,
tests and build, operator-script tests, `cargo check --tests`, Rust/Postgres tests,
the production Docker image, and the LinkBridge build. Tests use a disposable
GitHub-hosted runner and its own database, never the Ubuntu production database.
Only a successful run deploys its exact commit over SSH and checks
`https://oasisaero.ru/`. Manual runs deploy only when run against `main`.

## Prepare Ubuntu once

Use a normal SSH user that owns the production Git checkout (for example,
`ubuntu`, with the project at `/home/ubuntu/minecraft`). Install Docker Engine,
Compose, Buildx, Git, curl, OpenSSL, and util-linux (`flock`). The checkout must
have an `origin` remote and a local `main` branch. Start the stack manually first;
configure its `.env.docker`, public DNS, SMTP, and Minecraft directory ownership.

The deployment user needs Docker access without an interactive sudo prompt:

```sh
sudo usermod -aG docker ubuntu
```

If earlier setup commands used sudo, ensure this user owns the checkout and build
caches. For the example username and path:

```sh
sudo chown -R ubuntu:ubuntu /home/ubuntu/minecraft
sudo chown -R 1000:1000 /home/ubuntu/minecraft/mc/velocity /home/ubuntu/minecraft/mc/purpur
```

Log out and reconnect. As that user, **without sudo**, verify access and log in:

```sh
docker ps
docker login dhi.io --username YOUR_DOCKER_USERNAME
git -C /home/ubuntu/minecraft fetch origin main
```

Paste your Docker read token at the password prompt. A previous `sudo docker
login` saved credentials for root; the deployment user needs its own login.
Docker-group access grants control equivalent to root: give it only to a trusted
deployment account. For a private repository, configure that user's Git access
with a read-only GitHub deploy key so `git fetch` never asks for credentials.

## Configure SSH and GitHub

1. On your own computer, generate a dedicated Actions login key with
   `ssh-keygen -t ed25519 -f ~/.ssh/oasis-actions -C oasis-actions`. Leave its
   passphrase empty for unattended use; do not overwrite an existing key.
2. Add the contents of `~/.ssh/oasis-actions.pub` to the Ubuntu deployment user's
   `~/.ssh/authorized_keys`. Its `.ssh` directory must have mode 700 and
   `authorized_keys` mode 600. Keep your existing login keys.
3. Obtain the server host key through your existing trusted SSH connection or
   hosting console: `cat /etc/ssh/ssh_host_ed25519_key.pub`. This is a public key,
   different from the Actions login key.
4. In GitHub repository **Settings → Secrets and variables → Actions**, add:

| Secret | Value |
| --- | --- |
| `DHI_USERNAME` | Docker Hub username |
| `DHI_TOKEN` | Docker personal access token with Read permission |
| `DEPLOY_HOST` | Ubuntu public IP address or hostname |
| `DEPLOY_USER` | Deployment username, e.g. `ubuntu` |
| `SSH_PRIVATE_KEY` | Entire private `oasis-actions` key, including BEGIN/END lines |
| `SSH_KNOWN_HOSTS` | `SERVER_IP ssh-ed25519 AAAA...` using the server host key |

The known-hosts entry must use exactly the host in `DEPLOY_HOST`. For a custom SSH
port use `[SERVER_IP]:PORT ssh-ed25519 AAAA...`. Verify the host key via a trusted
connection rather than blindly trusting a new network scan.

Add these repository **Variables** on the same settings page:

| Variable | Value |
| --- | --- |
| `DEPLOY_PATH` | Absolute project path, e.g. `/home/ubuntu/minecraft`, without spaces |
| `DEPLOY_PORT` | Optional SSH port; defaults to `22` |

Create an environment named `production` under **Settings → Environments**, and
restrict its deployment branch to `main`. Required reviewers are optional; leave
them unset for fully automatic deployment. Restrict pushes to `main` to trusted
maintainers because pushed code can control the production server. Keep the
Resend key and production database secrets only in the server's `.env.docker`.

## Deploy

Commit and push the workflow, `scripts/deploy.sh`, and documentation to `main`.
Follow **Actions → Test and deploy**. The deployment updates a clean server
checkout with `git merge --ff-only`; it refuses local tracked changes or a
checkout ahead of the tested revision. Do not edit tracked files directly on the
server. Both builds complete before running services are changed. The workflow
does not copy its test environment file to production.

Deployments restart Purpur to load LinkBridge and can briefly disconnect players.
Worlds, AuthMe data, secrets, and Docker volumes persist. Schema migrations run
when the app starts. The pipeline does not make backups or automatically roll
back database migrations; keep operational backups using `scripts/export.sh`.
The final HTTPS check verifies the website responds, not authenticated gameplay,
mailbox delivery, or every API operation.

If a run fails, inspect its Actions logs. Fix the failure and push another commit,
or rerun the current commit. Do not rerun an older deployment after a newer commit
has already been installed; the deployment script intentionally rejects it.
