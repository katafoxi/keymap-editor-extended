# Deploy on a VPS

Same-origin production: Caddy terminates HTTPS and proxies to the Hono app on `:8080`. GitHub OAuth and App secrets stay on the server ([ADR 0003](adr/0003-github-auth-server-session.md)).

Public example: [zmk-keymap-editor.com](https://zmk-keymap-editor.com/).

```text
Internet :443 / :80 ──► Caddy ──► app:8080
```

Publish **TCP 80** and **443** (and **22** for SSH). Do not expose the Node port `8080` on the host.

## 1. DNS

| Type | Name | Value |
|------|------|--------|
| A | `@` | VPS IPv4 |
| A | `www` | same IPv4 |

Wait until lookups return only that address before expecting Let’s Encrypt to succeed. Caddy answers `www` with a permanent redirect to `https://zmk-keymap-editor.com`. Leave the `www` A record in place so that certificate and redirect can be issued.

## 2. Production GitHub App

| Field | Value |
|-------|--------|
| Homepage | `https://zmk-keymap-editor.com` |
| Callback | `https://zmk-keymap-editor.com/github/authorize` |
| OAuth during install | yes |
| Webhook | off |
| Permissions | Contents R/W, Metadata R, Actions R |
| Install | Any account |

Slug must match `VITE_GITHUB_APP_NAME` / `GITHUB_APP_NAME`. Keep a separate App for local `pnpm dev`.

## 3. Docker + Compose on the VPS

```bash
sudo apt update
sudo apt install -y docker.io git curl ca-certificates
sudo systemctl enable --now docker

sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -fsSL "https://github.com/docker/compose/releases/download/v2.32.4/docker-compose-linux-x86_64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
docker compose version
```

## 4. Ship the app

```bash
cd /opt
git clone https://github.com/katafoxi/keymap-editor-extended.git
cd keymap-editor-extended
cp deploy/env.production.example deploy/.env
# edit deploy/.env

cd deploy
docker compose up -d --build
docker compose ps
curl -sI https://zmk-keymap-editor.com/health
```

[`docker-compose.yml`](../deploy/docker-compose.yml) publishes host `80` and `443`. Caddy obtains certificates once DNS points here.

Update later: `git pull` then `cd deploy && docker compose up -d --build`.

## 5. Smoke check

- Browser: `https://zmk-keymap-editor.com` opens Demo
- `curl -sI https://zmk-keymap-editor.com/health` returns success
- `ss -tulnp` shows `:80` / `:443` on Caddy; `:8080` is not published on the host

## Layout

| Path | Role |
|------|------|
| [`deploy/docker-compose.yml`](../deploy/docker-compose.yml) | `app` + `caddy` |
| [`deploy/Caddyfile`](../deploy/Caddyfile) | HTTPS reverse proxy |
| [`deploy/env.production.example`](../deploy/env.production.example) | `deploy/.env` template |
| [`Dockerfile`](../Dockerfile) | Node image |
