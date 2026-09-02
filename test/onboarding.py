"""Client readiness: what a new deployment ships with, and whether the parts
that run unattended actually use what the client configured in the browser.

Every check here corresponds to a defect that shipped. They are the ones a
health check cannot see: the product stays green while doing nothing real.

Needs `wrangler dev --test-scheduled` so the cron can be triggered on demand.
"""
import json, os, re, subprocess, time, urllib.parse, urllib.request, urllib.error, io
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def _dbname():
    try:
        s = io.open(os.path.join(ROOT, "wrangler.jsonc"), encoding="utf-8").read()
        m = re.search(r'"database_name"\s*:\s*"([^"]+)"', s)
        if m: return m.group(1)
    except OSError:
        pass
    return "fixbat"

DB = _dbname()
B = os.environ.get("FIXBAT_URL", "http://localhost:8787")
ok = fail = 0
JAR = {}

def chk(name, got, want):
    global ok, fail
    good = got == want
    ok, fail = ok + good, fail + (not good)
    print(f"  {'PASS' if good else 'FAIL'}  {name:<52}{got}{'' if good else f'  (want {want})'}")

def d1(sql):
    o = subprocess.run(["npx", "wrangler", "d1", "execute", DB, "--local", "--json", "--command", sql],
                       capture_output=True, text=True, cwd=ROOT)
    # wrangler sometimes prints a banner (an update notice, say) before the
    # JSON, so parse from the first bracket rather than the first byte.
    raw = o.stdout
    i = raw.find("[")
    if i < 0:
        raise SystemExit(f"d1 returned no JSON for: {sql}\n{o.stdout}\n{o.stderr}")
    return json.loads(raw[i:])[0]["results"]

def d1_file(path):
    """Run a shipped migration file, so the test exercises the real artefact."""
    sql = io.open(path, encoding="utf-8").read()
    o = subprocess.run(["npx", "wrangler", "d1", "execute", DB, "--local", "--json", "--file", path],
                       capture_output=True, text=True, cwd=ROOT)
    if o.returncode != 0:
        raise SystemExit(f"migration failed: {path}\n{o.stdout}\n{o.stderr}")

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None

def req(path, method="GET", form=None, follow=False):
    h = {}; data = None
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        h["Content-Type"] = "application/x-www-form-urlencoded"
    if JAR: h["Cookie"] = "; ".join(f"{k}={v}" for k, v in JAR.items())
    r = urllib.request.Request(B + path, data=data, headers=h, method=method)
    op = urllib.request.build_opener() if follow else urllib.request.build_opener(NoRedirect)
    try:
        with op.open(r) as resp:
            for hk, hv in resp.getheaders():
                if hk.lower() == "set-cookie":
                    m = re.match(r'([^=]+)=([^;]*)', hv)
                    if m: JAR[m.group(1)] = m.group(2)
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        for hk, hv in e.headers.items():
            if hk.lower() == "set-cookie":
                m = re.match(r'([^=]+)=([^;]*)', hv)
                if m: JAR[m.group(1)] = m.group(2)
        return e.code, e.read().decode()

def wipe():
    for t in ("users", "integration_secrets", "services", "incidents", "cursors",
              "events", "auth_attempts", "tickets", "dispositions", "briefs"):
        d1(f"DELETE FROM {t}")
    d1("UPDATE deployment SET token_hash=NULL, claimed_at=NULL, claimed_by=NULL")
    d1("UPDATE settings SET kill_switch=0, kill_switch_reason='', log_source='auto' WHERE id=1")
    JAR.clear()

def claim():
    req("/setup/claim", "POST", form={"name": "Onboarding Test"})

def cron():
    """Trigger the scheduled handler and let waitUntil settle."""
    req("/__scheduled")
    time.sleep(2)

def events_like(pattern):
    rows = d1(f"SELECT kind, detail FROM events WHERE detail LIKE '%{pattern}%'")
    return len(rows)

def count(table, where="1=1"):
    return d1(f"SELECT COUNT(*) AS n FROM {table} WHERE {where}")[0]["n"]


# ---------------------------------------------------------------------------
print("\n1. A NEW DEPLOYMENT SHIPS NO SERVICES THE CLIENT DID NOT ADD")
# 0001 seeds three sample services. It ran before is_demo existed, so they
# landed as real ones: unremovable by "Clear demo data", and — with live
# tokens — pointing a client's incidents at acme/* repos they do not own.
wipe()
ts = "datetime('now')"
d1(f"""INSERT INTO services (name,repo,slack_channel,team,enabled,created_at,updated_at) VALUES
  ('checkout-service','acme/checkout-service','#incidents-checkout','Checkout',1,{ts},{ts}),
  ('payments-api','acme/payments-api','#incidents-payments','Payments',1,{ts},{ts}),
  ('inventory-worker','acme/inventory-worker','#incidents-inventory','Inventory',1,{ts},{ts})""")
# a service the client genuinely registered, plus one of the seeded names they
# repointed at their own repo — neither may be treated as demo data
d1(f"""INSERT INTO services (name,repo,slack_channel,team,enabled,created_at,updated_at)
       VALUES ('billing','clientco/billing','#eng-billing','Billing',1,{ts},{ts})""")
d1("UPDATE services SET repo='clientco/checkout', slack_channel='#eng-checkout' WHERE name='checkout-service'")

chk("seeded services start out indistinguishable", count("services", "is_demo=1"), 0)
d1_file(os.path.join(ROOT, "migrations", "0006_demo_services.sql"))
chk("untouched samples are marked as demo", count("services", "is_demo=1"), 2)
chk("a repointed service stays the client's", count("services", "name='checkout-service' AND is_demo=0"), 1)
chk("a client's own service is untouched", count("services", "name='billing' AND is_demo=0"), 1)

claim()
req("/setup/demo/clear", "POST")
chk("'clear demo data' removes the samples", count("services", "repo LIKE 'acme/%'"), 0)
chk("...and leaves everything the client owns", count("services"), 2)


# ---------------------------------------------------------------------------
print("\n2. THE CRON USES CREDENTIALS ENTERED IN THE BROWSER")
# A one-click deployment has no terminal, so the client's credentials live in
# D1, not in the Worker env. The scheduled handler read the raw env, so every
# unattended pass ran fully simulated while /health reported the providers live.
wipe()
claim()
req("/setup/secrets", "POST", form={"name": "ELASTICSEARCH_URL",
                                    "value": "https://fixbat-nonexistent.invalid"})

health = json.loads(req("/health")[1])
chk("a request resolves the stored credential", health["providers"]["logs"], "elasticsearch")

cron()
chk("the cron resolves it too", events_like("could not read from elasticsearch"), 1)
chk("...it did not fall back to the samples", count("briefs"), 0)
chk("...and wrote no fixture incidents", count("incidents"), 0)


# ---------------------------------------------------------------------------
print("\n3. A BROKEN LOG SOURCE IS REPORTED, NOT SWALLOWED")
# The failure throws before the per-event handler, so it used to take the run
# down having written nothing: the setup page's failure banner stayed empty and
# the client had no way to tell why nothing was happening.
chk("it surfaces as a pipeline error", count("events", "kind='pipeline_error'") >= 1, True)
chk("the cursor is not advanced over it", count("cursors"), 0)

req("/setup/secrets/delete", "POST", form={"name": "ELASTICSEARCH_URL"})
chk("removing it reverts to the samples", json.loads(req("/health")[1])["providers"]["logs"], "fixture")

req("/setup/demo", "POST")   # register the sample services so events map
cron()
chk("and the cron then works end to end", count("briefs") > 0, True)


print("\n" + "=" * 70)
print(f"  {ok} passed, {fail} failed")
print("=" * 70)
raise SystemExit(1 if fail else 0)
