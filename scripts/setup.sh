#!/usr/bin/env bash
# FixBat onboarding.
#
# Provisions FixBat into YOUR Cloudflare account: creates the database, runs
# migrations, stores secrets, registers your services and deploys.
#
# Safe to re-run. Nothing is dropped, existing secrets are kept unless you
# choose to replace them, and every step tells you what it is about to do.
set -euo pipefail

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'

step()  { printf "\n${BOLD}${BLUE}==>${RESET} ${BOLD}%s${RESET}\n" "$1"; }
ok()    { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
warn()  { printf "  ${YELLOW}!${RESET} %s\n" "$1"; }
fail()  { printf "  ${RED}✗${RESET} %s\n" "$1"; exit 1; }
info()  { printf "  ${DIM}%s${RESET}\n" "$1"; }

ask() { # ask <prompt> <default>
  local prompt="$1" default="${2:-}" reply
  if [ -n "$default" ]; then
    read -r -p "  $prompt [$default]: " reply </dev/tty || true
    printf '%s' "${reply:-$default}"
  else
    read -r -p "  $prompt: " reply </dev/tty || true
    printf '%s' "$reply"
  fi
}

confirm() { # confirm <prompt>  -> 0 if yes
  local reply
  read -r -p "  $1 [y/N]: " reply </dev/tty || true
  [[ "$reply" =~ ^[Yy] ]]
}

DB_NAME="${FIXBAT_DB_NAME:-fixbat}"
WRANGLER="npx --yes wrangler@4"

# --check runs every detection step and changes nothing. Use it to verify the
# environment before committing, or in CI.
CHECK_ONLY=no
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=yes ;;
    -h|--help)
      echo "Usage: npm run setup [-- --check]"
      echo "  --check   verify prerequisites and report state; make no changes"
      exit 0 ;;
    *) fail "Unknown option: $arg" ;;
  esac
done
[ "$CHECK_ONLY" = yes ] && printf "\n${BOLD}${YELLOW}Dry run — nothing will be changed.${RESET}\n"

# ---------------------------------------------------------------- preflight

step "Checking prerequisites"

command -v node >/dev/null || fail "node is not installed. Install Node 18 or newer."
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge 18 ] || fail "Node $NODE_MAJOR is too old. FixBat needs Node 18 or newer."
ok "node $(node -v)"

command -v npm >/dev/null || fail "npm is not installed."
ok "npm $(npm -v)"

[ -d node_modules ] || { info "Installing dependencies (first run only)…"; npm install --silent; }
ok "dependencies installed"

# ------------------------------------------------------------------- login

step "Cloudflare account"

if [ "$CHECK_ONLY" = yes ]; then
  if $WRANGLER whoami >/dev/null 2>&1; then ok "signed in to Cloudflare"; else warn "not signed in — setup would run 'wrangler login'"; fi
elif ! $WRANGLER whoami >/dev/null 2>&1; then
  warn "Not logged in to Cloudflare."
  info "A browser window will open so you can authorise wrangler."
  $WRANGLER login
fi

ACCOUNT=$($WRANGLER whoami 2>/dev/null | grep -oE '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+' | head -1 || echo "unknown")
ok "signed in as $ACCOUNT"

# ---------------------------------------------------------------- database

step "Database"

if $WRANGLER d1 list --json 2>/dev/null | grep -q "\"name\": *\"$DB_NAME\""; then
  ok "database '$DB_NAME' already exists"
elif [ "$CHECK_ONLY" = yes ]; then
  warn "database '$DB_NAME' does not exist — setup would create it"
else
  info "Creating D1 database '$DB_NAME'…"
  $WRANGLER d1 create "$DB_NAME" >/dev/null
  ok "created database '$DB_NAME'"
fi

DB_ID=$($WRANGLER d1 list --json 2>/dev/null \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=JSON.parse(s).find(d=>d.name==='$DB_NAME');process.stdout.write(m?(m.uuid||m.database_id||''):'')})")

# --check promises to report state and change nothing, so it neither fails on a
# database that does not exist yet — the normal state for a new client — nor
# rewrites the config.
if [ "$CHECK_ONLY" = yes ]; then
  if [ -n "$DB_ID" ]; then
    ok "database id $DB_ID"
    info "wrangler.jsonc would be pointed at it"
  else
    warn "no database yet — setup would create one and write its id into wrangler.jsonc"
  fi
else

[ -n "$DB_ID" ] || fail "Could not determine the database id for '$DB_NAME'."
ok "database id $DB_ID"

# Point wrangler.jsonc at this account's database.
node -e "
const fs=require('fs');
const p='wrangler.jsonc';
let s=fs.readFileSync(p,'utf8');
const before=s;
s=s.replace(/(\"database_name\":\s*\")[^\"]*(\")/, '\$1$DB_NAME\$2');
if (/\"database_id\"\s*:/.test(s)) {
  s=s.replace(/(\"database_id\":\s*\")[^\"]*(\")/, '\$1$DB_ID\$2');
} else {
  // The committed config ships without one deliberately: it names one database
  // in one account. Add it here, for this account.
  s=s.replace(/(\"database_name\":\s*\"[^\"]*\",)/, '\$1\n      \"database_id\": \"$DB_ID\",');
}
if (s!==before) fs.writeFileSync(p,s);
"
ok "wrangler.jsonc points at your database"

fi

if [ "$CHECK_ONLY" = yes ]; then
  # Listing migrations against a database that does not exist yet prints a raw
  # wrangler error, which reads as a failure on a first run when it is simply
  # not created yet.
  if [ -n "$DB_ID" ]; then
    info "Pending migrations:"
    $WRANGLER d1 migrations list "$DB_NAME" --remote 2>&1 | sed 's/^/    /' || true
  else
    info "Migrations will be applied once the database exists."
  fi
else
  info "Applying migrations (additive — existing data is preserved)…"
  $WRANGLER d1 migrations apply "$DB_NAME" --remote
  ok "migrations applied"
fi

# ----------------------------------------------------------------- secrets

step "Secrets"

info "FixBat runs with any subset of these. Anything you skip stays simulated,"
info "so the platform works end to end from the first deploy."
echo

have_secret() { $WRANGLER secret list 2>/dev/null | grep -q "\"$1\""; }

put_secret() { # put_secret <NAME> <description> <required>
  local name="$1" desc="$2" required="${3:-no}" value
  if have_secret "$name"; then
    if confirm "$name is already set. Replace it?"; then :; else info "keeping existing $name"; return; fi
  elif [ "$required" != "yes" ]; then
    printf "  ${DIM}%s${RESET}\n" "$desc"
    if ! confirm "Set $name now?"; then info "skipped — this provider stays simulated"; return; fi
  else
    printf "  ${DIM}%s${RESET}\n" "$desc"
  fi
  read -r -s -p "  $name: " value </dev/tty; echo
  [ -n "$value" ] || { warn "empty, skipped"; return; }
  printf '%s' "$value" | $WRANGLER secret put "$name" >/dev/null
  ok "$name stored"
}

if [ "$CHECK_ONLY" = yes ]; then
  # ADMIN_TOKEN is not a provider — unset means the deployment is claimed in the
  # browser instead, which is the normal one-click path, not a missing feature.
  if have_secret ADMIN_TOKEN; then
    ok "ADMIN_TOKEN set — the claim step will be skipped"
  else
    info "ADMIN_TOKEN not set — the first person to open the site claims it"
  fi
  for n in ANTHROPIC_API_KEY SLACK_BOT_TOKEN SLACK_SIGNING_SECRET GITHUB_TOKEN ELASTICSEARCH_URL ELASTICSEARCH_API_KEY; do
    if have_secret "$n"; then ok "$n set"; else info "$n not set — that provider stays simulated"; fi
  done
  step "Check complete"
  info "No changes were made. Run 'npm run setup' to provision."
  echo
  exit 0
fi

# Required: without it the admin API is open to the internet.
if have_secret ADMIN_TOKEN; then
  ok "ADMIN_TOKEN already set"
else
  GENERATED=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
  printf '%s' "$GENERATED" | $WRANGLER secret put ADMIN_TOKEN >/dev/null
  ok "ADMIN_TOKEN generated and stored"
  echo
  printf "  ${BOLD}${YELLOW}Save this now — it is not shown again:${RESET}\n"
  printf "  ${BOLD}%s${RESET}\n\n" "$GENERATED"
  read -r -p "  Press enter once you have saved it… " _ </dev/tty || true
fi

put_secret ANTHROPIC_API_KEY     "Real incident briefs. Without it FixBat writes canned briefs. sk-ant-… from console.anthropic.com"
put_secret SLACK_BOT_TOKEN       "Posts briefs to Slack. Bot token (xoxb-…) with the chat:write scope."
put_secret SLACK_SIGNING_SECRET  "Verifies Slack button clicks. Required for the buttons to work."
put_secret GITHUB_TOKEN          "Reads commit history and files issues. Needs contents:read + issues:write."
put_secret ELASTICSEARCH_URL     "Live log source. Without it FixBat reads bundled sample errors."
put_secret ELASTICSEARCH_API_KEY "Elasticsearch API key."

# ---------------------------------------------------------------- services

step "Service registry"

info "FixBat only diagnoses services listed here — an unmapped service has no"
info "repository to correlate against. You can add more later from the UI docs."
echo

SERVICES_JSON="[]"
if confirm "Register a service now?"; then
  while true; do
    NAME=$(ask "service.name as it appears in your logs")
    [ -n "$NAME" ] || break
    REPO=$(ask "GitHub repo (owner/name)")
    CHAN=$(ask "Slack channel" "#incidents")
    TEAM=$(ask "owning team (optional)" "")
    SERVICES_JSON=$(node -e "
      const a=JSON.parse(process.argv[1]);
      a.push({name:process.argv[2],repo:process.argv[3],slack_channel:process.argv[4],team:process.argv[5]});
      process.stdout.write(JSON.stringify(a));
    " "$SERVICES_JSON" "$NAME" "$REPO" "$CHAN" "$TEAM")
    ok "queued $NAME → $REPO"
    confirm "Add another?" || break
  done
fi

# ------------------------------------------------------------------ deploy

step "Deploy"

info "Building assets and deploying to Cloudflare…"
npm run build --silent
DEPLOY_OUT=$($WRANGLER deploy 2>&1)
echo "$DEPLOY_OUT" | grep -E "Total Upload|Current Version" | sed 's/^/  /' || true
URL=$(echo "$DEPLOY_OUT" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)
[ -n "$URL" ] || fail "Deploy did not report a URL. Full output:\n$DEPLOY_OUT"
ok "deployed to $URL"

# Register the queued services now that the API is live.
if [ "$SERVICES_JSON" != "[]" ]; then
  TOKEN=$(ask "Paste your ADMIN_TOKEN to register the services (or leave blank to skip)" "")
  if [ -n "$TOKEN" ]; then
    node -e "
      const services=JSON.parse(process.argv[1]);
      (async () => {
        for (const s of services) {
          const r = await fetch(process.argv[2]+'/admin/services', {
            method:'POST',
            headers:{'content-type':'application/json','authorization':'Bearer '+process.argv[3]},
            body: JSON.stringify(s),
          });
          console.log('  ' + (r.ok ? '✓' : '✗') + ' ' + s.name);
        }
      })();
    " "$SERVICES_JSON" "$URL" "$TOKEN"
  fi
fi

# ------------------------------------------------------------------- verify

step "Verifying"

HEALTH=$(curl -fsS "$URL/health" 2>/dev/null || echo "")
[ -n "$HEALTH" ] || fail "The deployment is not responding at $URL/health"
ok "health check passed"

node -e "
const h=JSON.parse(process.argv[1]);
const p=h.providers;
const live=Object.entries(p).filter(([,v])=>v!=='simulated'&&v!=='fixture');
console.log('  providers:');
for (const [k,v] of Object.entries(p)) console.log('    ' + k.padEnd(10) + v);
console.log('');
console.log(live.length ? '  ' + live.length + ' provider(s) live.' : '  All providers simulated — FixBat works, using bundled sample data.');
" "$HEALTH"

UNAUTH=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/admin/reset")
if [ "$UNAUTH" = "401" ]; then ok "admin API is locked"; else fail "admin API returned $UNAUTH without a token — expected 401"; fi

# --------------------------------------------------------------------- done

step "Done"
printf "  ${BOLD}%s${RESET}\n\n" "$URL"
info "Next steps:"
info "  • Open the URL above — it works immediately with sample data."
info "  • Slack buttons: set the app's Interactivity URL to $URL/slack/actions"
info "  • Trigger a run:  curl -X POST $URL/admin/ingest -H \"authorization: Bearer \$ADMIN_TOKEN\""
info "  • The cron polls every 5 minutes. Pause it any time with:"
info "      curl -X POST $URL/admin/settings -H \"authorization: Bearer \$ADMIN_TOKEN\" \\"
info "           -H 'content-type: application/json' -d '{\"kill_switch\":true}'"
echo
