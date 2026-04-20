# Deployment

## Target host

`append.page` runs as a **co-tenant** on the shared box at `65.108.32.165` (Helsinki, FI). Other tenants on the same host:

- `aggregativeqa.com` — Next.js process on `127.0.0.1:3000`, served by inline `server { }` blocks in `/etc/nginx/nginx.conf`.
- `interactivetraining.ai` — Next.js process on `127.0.0.1:3451`, same pattern.

Both tenants run as `root` from `/root/...`. We deliberately do **not** follow that pattern — append.page runs under a dedicated `appendpage` user from `/var/lib/appendpage/`. The two patterns coexist; nothing we do touches root's processes or files.

## Co-tenant safety contract

`infra/bootstrap.sh` and our nginx integration are designed around these guarantees:

1. **One Linux user.** `appendpage:appendpage`, system user, no login shell, member of `docker`. Created by `bootstrap.sh`. Never elevated.
2. **One state directory.** Everything under `/var/lib/appendpage/` (data, backups, anchors, HF mirror clone, the Compose project clone). Owned `appendpage:appendpage`, mode 0750.
3. **One env file.** `/etc/appendpage/.env`, mode 0640, owner `root:appendpage`. Sealed; never committed.
4. **No public ports.** Our Compose stack binds to `127.0.0.1` only — `127.0.0.1:38080` (app), `127.0.0.1:38432` (postgres), `127.0.0.1:38379` (redis). Public traffic only reaches us via the host's nginx.
5. **One nginx file added.** `/etc/nginx/conf.d/append.page.conf`. We never edit other tenants' inline blocks in `/etc/nginx/nginx.conf`.
6. **One nginx.conf line touched** (and only on first run, only if needed). The line `include /etc/nginx/conf.d/*.conf;` already exists in `/etc/nginx/nginx.conf` but is commented out. We uncomment it. nginx.conf is backed up first as `/etc/nginx/nginx.conf.appendpage-bak.<timestamp>`.
7. **`nginx -t` before every reload.** If validation fails, the reload is aborted. The other tenants' configs are unaffected by any of our work.
8. **TLS via certbot, not getssl.** The existing tenants use `getssl` with certs at `/root/.getssl/<domain>/`. We use `certbot --webroot` with certs at `/etc/letsencrypt/live/append.page/`. Different ACME clients, different cert paths, no conflict; certbot leaves getssl alone.

## First run

```bash
# As root on the prod box:
git clone https://github.com/appendpage/appendpage.git /tmp/appendpage-bootstrap
cd /tmp/appendpage-bootstrap
sudo bash infra/bootstrap.sh
# First run will fail-stop after creating /etc/appendpage/.env from a template.
# Edit /etc/appendpage/.env, fill in POSTGRES_PASSWORD, OPENAI_API_KEY, IP_HASH_SALT_SEED.
# Then re-run:
sudo bash infra/bootstrap.sh
# It will:
#   1. Clone the repo to /var/lib/appendpage/compose
#   2. Install certbot
#   3. Drop /etc/nginx/conf.d/append.page.conf and reload nginx
#   4. Bring up the Compose stack
#   5. Run migrations
#   6. Smoke-test /status
# Then issue the cert manually (chicken-and-egg with the HTTP-01 challenge):
sudo certbot certonly --webroot -w /var/www/append.page-acme \
  -d append.page -d www.append.page
sudo nginx -t && sudo systemctl reload nginx
```

## Updates / redeploys

```bash
sudo -u appendpage git -C /var/lib/appendpage/compose pull --ff-only
sudo -u appendpage docker compose \
  --project-directory /var/lib/appendpage/compose \
  -f /var/lib/appendpage/compose/infra/compose.yaml \
  --env-file /etc/appendpage/.env \
  up -d --build
```

`infra/compose.yaml` uses pinned image *tags* for now (`postgres:16-alpine`, `redis:7-alpine`). For Phase D we pin by digest — see <https://docs.docker.com/engine/security/trust/content_trust/> for context. Update the digests deliberately when bumping a dependency.

## Rollback

```bash
# Find the commit you want to roll back to:
sudo -u appendpage git -C /var/lib/appendpage/compose log --oneline -20
# Reset and rebuild:
sudo -u appendpage git -C /var/lib/appendpage/compose reset --hard <commit-sha>
sudo -u appendpage docker compose \
  --project-directory /var/lib/appendpage/compose \
  -f /var/lib/appendpage/compose/infra/compose.yaml \
  --env-file /etc/appendpage/.env \
  up -d --build
```

If a migration was applied that you can't easily undo, restore from backup:

```bash
# (Phase D) restore from latest off-site backup
sudo -u appendpage docker compose ... down
# pg_restore from /var/lib/appendpage/backups/latest.dump or from the HF dataset
sudo -u appendpage docker compose ... up -d
```

## What we deliberately don't do (host-level)

- We don't manage `ufw`, `fail2ban`, `sysctl`, `nftables`, `crowdsec`, kernel tuning, or any other host-wide concern. That's the host owner's responsibility. Our origin-side hardening (rate limiting, security headers, body size caps, slow-loris timeouts) is applied **inside our nginx server block** so it doesn't affect the other tenants.
- We don't install systemd units that could affect other services. The Compose stack is brought up by hand on first install; for unattended boot we add a single small systemd unit (`appendpage.service`) in Phase D, scoped to our project only.
- We don't modify the host's certbot/getssl/letsencrypt cron jobs. certbot's auto-renewal timer (`certbot.timer`) handles our renewals independently.

## Backups (Phase D)

Nightly cron under `appendpage`:

```
pg_dump -Fc -U appendpage appendpage \
  | zstd -19 \
  | rsync ... /var/lib/appendpage/backups/$(date -u +%F).dump.zst
```

And hourly push to `huggingface.co/datasets/appendpage/ledger` (the per-page JSONL files + `verify.py`).

A monthly **restore drill**: spin up a scratch VPS, restore the latest backup OR `git clone https://huggingface.co/datasets/appendpage/ledger`, run `python verify.py` against every page. Documented separately in Phase D.
