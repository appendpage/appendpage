#!/usr/bin/env bash
# infra/bootstrap.sh
#
# Provisions the append.page stack on a host that already runs other tenants.
# CO-TENANT-SAFE GUARANTEES (see docs/03-deployment.md):
#
#   * Creates a dedicated `appendpage` Linux user. Never modifies root or other tenants' users.
#   * All our state goes under /var/lib/appendpage/ and /etc/appendpage/. Never touches /root/*.
#   * Runs Docker Compose as a separate project (project name "appendpage") on
#     127.0.0.1-only ports 38080 (app), 38432 (postgres), 38379 (redis).
#     Never binds anything publicly except via the host's nginx.
#   * Drops a single file at /etc/nginx/conf.d/append.page.conf.
#   * Uncomments the existing `include /etc/nginx/conf.d/*.conf;` line in
#     /etc/nginx/nginx.conf if it's currently commented out. This is the ONLY
#     edit to a shared file. The line is already present (commented) on the
#     host as of inspection on 2026-04-20.
#   * Runs `nginx -t` BEFORE every reload. Refuses to reload if validation fails.
#   * Uses certbot --webroot for TLS — coexists with the existing getssl setup
#     for aggregativeqa.com and interactivetraining.ai (different ACME clients
#     and different cert paths; no conflict).
#   * Idempotent: running it twice is safe.
#
# Run as root. Re-runnable.
#   sudo bash bootstrap.sh
#
# Required env at runtime (from /etc/appendpage/.env, sourced below):
#   POSTGRES_PASSWORD, OPENAI_API_KEY, IP_HASH_SALT_SEED  (set during first run)

set -euo pipefail

# ====================== config ======================
APPENDPAGE_USER="${APPENDPAGE_USER:-appendpage}"
APPENDPAGE_HOME="/var/lib/appendpage"
ENV_DIR="/etc/appendpage"
ENV_FILE="${ENV_DIR}/.env"
NGINX_CONF="/etc/nginx/conf.d/append.page.conf"
ACME_WEBROOT="/var/www/append.page-acme"
DOMAIN="append.page"
WWW_DOMAIN="www.append.page"
COMPOSE_PROJECT_DIR="${APPENDPAGE_HOME}/compose"
GIT_SOURCE="${GIT_SOURCE:-https://github.com/appendpage/appendpage.git}"
GIT_BRANCH="${GIT_BRANCH:-main}"

# ====================== helpers ======================
log()  { printf '\033[1;34m[bootstrap]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[bootstrap]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[bootstrap]\033[0m %s\n' "$*" >&2; exit 1; }

require_root() {
  [[ $EUID -eq 0 ]] || fail "must run as root (use sudo)."
}

confirm_or_skip_existing_tenants() {
  # Sanity check: this script is co-tenant-safe by design, but warn loudly
  # if we detect we're running on a fresh host instead of the expected shared one.
  if ! grep -q "aggregativeqa.com\|interactivetraining.ai" /etc/nginx/nginx.conf 2>/dev/null; then
    warn "did not detect aggregativeqa.com or interactivetraining.ai in nginx.conf —"
    warn "this script was designed for the shared host. Continuing, but ensure"
    warn "you actually want to run on this box."
  fi
}

# ====================== steps ======================

step_create_user() {
  if id -u "$APPENDPAGE_USER" >/dev/null 2>&1; then
    log "user '$APPENDPAGE_USER' already exists"
  else
    log "creating user '$APPENDPAGE_USER'"
    useradd --system --shell /usr/sbin/nologin --home-dir "$APPENDPAGE_HOME" \
            --create-home --user-group "$APPENDPAGE_USER"
  fi
  if ! id -nG "$APPENDPAGE_USER" | tr ' ' '\n' | grep -qx "docker"; then
    log "adding '$APPENDPAGE_USER' to docker group"
    usermod -aG docker "$APPENDPAGE_USER"
  else
    log "user '$APPENDPAGE_USER' already in docker group"
  fi
}

step_create_dirs() {
  log "ensuring directory tree"
  install -d -o "$APPENDPAGE_USER" -g "$APPENDPAGE_USER" -m 750 \
    "$APPENDPAGE_HOME" \
    "$APPENDPAGE_HOME/pages" \
    "$APPENDPAGE_HOME/backups" \
    "$APPENDPAGE_HOME/anchor" \
    "$APPENDPAGE_HOME/hf-mirror" \
    "$APPENDPAGE_HOME/compose"
  install -d -o root -g root -m 755 "$ACME_WEBROOT"
  install -d -o root -g "$APPENDPAGE_USER" -m 750 "$ENV_DIR"
}

step_install_env_template() {
  if [[ -f "$ENV_FILE" ]]; then
    log "$ENV_FILE already exists — leaving as-is"
    return
  fi
  warn "creating $ENV_FILE FROM TEMPLATE — you MUST edit it before the stack will work"
  install -o root -g "$APPENDPAGE_USER" -m 640 /dev/null "$ENV_FILE"
  cat > "$ENV_FILE" <<'EOF'
# /etc/appendpage/.env — DO NOT COMMIT
# Edit these placeholders before bringing the stack up.

POSTGRES_PASSWORD=__SET_ME_LONG_RANDOM__
DATABASE_URL=postgres://appendpage:__SET_ME_LONG_RANDOM__@db:5432/appendpage
REDIS_URL=redis://redis:6379
PAGES_DIR=/var/lib/appendpage/pages

OPENAI_API_KEY=sk-...
OPENAI_PRIMARY_MODEL=gpt-5.4-mini-2026-03-17
OPENAI_FALLBACK_MODEL=gpt-5.4-nano-2026-03-17
OPENAI_DAILY_BUDGET_USD=50

TURNSTILE_SITE_KEY=
TURNSTILE_SECRET_KEY=

GITHUB_OAUTH_CLIENT_ID=
GITHUB_OAUTH_CLIENT_SECRET=
GITHUB_ADMIN_ALLOWLIST=da03

PUBLIC_BASE_URL=https://append.page
IP_HASH_SALT_SEED=__SET_ME_LONG_RANDOM__

HF_DATASET_REPO=appendpage/ledger
HF_TOKEN=
EOF
  chmod 640 "$ENV_FILE"
  chown root:"$APPENDPAGE_USER" "$ENV_FILE"
  warn "edit $ENV_FILE then re-run bootstrap.sh"
  exit 2
}

step_check_env_filled() {
  if grep -q "__SET_ME_LONG_RANDOM__" "$ENV_FILE"; then
    fail "$ENV_FILE still contains placeholder values (__SET_ME_LONG_RANDOM__). Edit it first."
  fi
}

step_clone_or_update_source() {
  if [[ ! -d "$COMPOSE_PROJECT_DIR/.git" ]]; then
    log "cloning $GIT_SOURCE → $COMPOSE_PROJECT_DIR"
    sudo -u "$APPENDPAGE_USER" git clone --branch "$GIT_BRANCH" --depth 50 \
      "$GIT_SOURCE" "$COMPOSE_PROJECT_DIR"
  else
    log "updating $COMPOSE_PROJECT_DIR (fetch + reset to origin/$GIT_BRANCH)"
    sudo -u "$APPENDPAGE_USER" git -C "$COMPOSE_PROJECT_DIR" fetch --depth 50 origin "$GIT_BRANCH"
    sudo -u "$APPENDPAGE_USER" git -C "$COMPOSE_PROJECT_DIR" reset --hard "origin/$GIT_BRANCH"
  fi
}

step_install_certbot() {
  if command -v certbot >/dev/null 2>&1; then
    log "certbot already installed: $(certbot --version 2>&1 | head -1)"
    return
  fi
  log "installing certbot via apt"
  apt-get update -y -qq
  apt-get install -y -qq certbot
}

# ----------------------------------------------------------------------------
# nginx & TLS provisioning is a chicken-and-egg dance:
#
#   * The full append.page.conf references /etc/letsencrypt/live/append.page/.
#     If we install it before the cert exists, `nginx -t` fails and we abort.
#   * certbot --webroot needs nginx already serving the ACME HTTP-01 challenge
#     for our domain.
#
# Resolution: install append.page.http-only.conf first (HTTP-only, just the
# ACME endpoint + 503 placeholder). Run certbot. Then swap in the full config.
#
# Both functions are idempotent and safe to re-run.
# ----------------------------------------------------------------------------

ensure_nginx_includes_conf_d() {
  # Idempotent: ensure /etc/nginx/nginx.conf includes /etc/nginx/conf.d/*.conf.
  # Inspection on 2026-04-20 showed the line is present but commented out.
  if grep -qE '^\s*include\s+/etc/nginx/conf.d/\*\.conf;' /etc/nginx/nginx.conf; then
    return 0
  fi
  if grep -qE '^\s*#\s*include\s+/etc/nginx/conf.d/\*\.conf;' /etc/nginx/nginx.conf; then
    log "uncommenting 'include /etc/nginx/conf.d/*.conf;' in /etc/nginx/nginx.conf"
    cp -a /etc/nginx/nginx.conf "/etc/nginx/nginx.conf.appendpage-bak.$(date +%s)"
    sed -i -E 's|^\s*#\s*include\s+/etc/nginx/conf.d/\*\.conf;|\tinclude /etc/nginx/conf.d/*.conf;|' \
      /etc/nginx/nginx.conf
  else
    warn "no 'include /etc/nginx/conf.d/*.conf;' line found in nginx.conf — adding one"
    cp -a /etc/nginx/nginx.conf "/etc/nginx/nginx.conf.appendpage-bak.$(date +%s)"
    awk '
      /^}\s*$/ && !done { print "\tinclude /etc/nginx/conf.d/*.conf;"; done=1 }
      { print }
    ' /etc/nginx/nginx.conf > /etc/nginx/nginx.conf.new
    mv /etc/nginx/nginx.conf.new /etc/nginx/nginx.conf
  fi
}

reload_nginx() {
  log "validating nginx config"
  if ! nginx -t; then
    fail "nginx -t failed; refusing to reload. Investigate and re-run."
  fi
  log "reloading nginx"
  systemctl reload nginx
}

step_install_nginx_http_only() {
  # Always install the http-only config first. If we already have a cert,
  # the next step replaces it with the full config.
  local src="$COMPOSE_PROJECT_DIR/infra/nginx/append.page.http-only.conf"
  [[ -f "$src" ]] || fail "expected nginx config at $src"
  log "installing HTTP-only nginx block: $NGINX_CONF"
  install -o root -g root -m 644 "$src" "$NGINX_CONF"
  ensure_nginx_includes_conf_d
  reload_nginx
}

step_obtain_cert() {
  if [[ -d "/etc/letsencrypt/live/$DOMAIN" ]]; then
    log "certbot cert for $DOMAIN already present — skipping issuance"
    return
  fi
  # Include www by default (DNS A record was added 2026-04-21). Set
  # INCLUDE_WWW=0 to opt out if you ever deploy this without a www record.
  local -a www_args=()
  if [[ "${INCLUDE_WWW:-1}" == "1" ]]; then
    www_args+=("-d" "$WWW_DOMAIN")
  fi
  log "obtaining TLS cert for $DOMAIN${INCLUDE_WWW:+ + $WWW_DOMAIN} via certbot --webroot"
  certbot certonly \
    --webroot -w "$ACME_WEBROOT" \
    -d "$DOMAIN" "${www_args[@]}" \
    --non-interactive --agree-tos \
    --email "${CERTBOT_EMAIL:-da03@yuntiandeng.com}" \
    --no-eff-email
  if [[ ! -d "/etc/letsencrypt/live/$DOMAIN" ]]; then
    fail "certbot succeeded? expected /etc/letsencrypt/live/$DOMAIN to exist"
  fi
}

step_install_nginx_full() {
  local src="$COMPOSE_PROJECT_DIR/infra/nginx/append.page.conf"
  [[ -f "$src" ]] || fail "expected nginx config at $src"
  log "installing full HTTPS nginx block: $NGINX_CONF"
  install -o root -g root -m 644 "$src" "$NGINX_CONF"
  ensure_nginx_includes_conf_d
  reload_nginx
}

step_compose_up() {
  log "starting docker compose stack"
  sudo -u "$APPENDPAGE_USER" \
    env DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2-)" \
    docker compose --project-directory "$COMPOSE_PROJECT_DIR" \
      -f "$COMPOSE_PROJECT_DIR/infra/compose.yaml" \
      --env-file "$ENV_FILE" \
      up -d --remove-orphans
}

step_run_migrations() {
  log "running migrations"
  sudo -u "$APPENDPAGE_USER" \
    docker compose --project-directory "$COMPOSE_PROJECT_DIR" \
      -f "$COMPOSE_PROJECT_DIR/infra/compose.yaml" \
      --env-file "$ENV_FILE" \
      exec -T app node --import tsx scripts/migrate.ts
}

step_smoke() {
  log "smoke test: GET /status"
  if curl -sS --max-time 5 http://127.0.0.1:38080/status | grep -q '"ok":true'; then
    log "smoke test passed"
  else
    warn "smoke test failed — check 'docker compose logs app'"
  fi
}

# ====================== main ======================
require_root
confirm_or_skip_existing_tenants

log "==> create user"
step_create_user

log "==> create dirs"
step_create_dirs

log "==> install env template (first run only)"
step_install_env_template
step_check_env_filled

log "==> clone / update source"
step_clone_or_update_source

log "==> install certbot"
step_install_certbot

log "==> install HTTP-only nginx block (so ACME challenge works)"
step_install_nginx_http_only

log "==> obtain TLS cert via certbot --webroot"
step_obtain_cert

log "==> install full HTTPS nginx block"
step_install_nginx_full

log "==> bring up compose stack"
step_compose_up

log "==> run migrations"
step_run_migrations

log "==> smoke test"
step_smoke

log "DONE. Visit https://append.page/status (after cert is issued)."
