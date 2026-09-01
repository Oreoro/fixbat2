"""Pipeline recovery and lookup correctness.

Three defects, all of which only show up after a client has been running for a
while — which is exactly when they are most expensive:

  * incidents that arrived before their service was registered stayed unmapped
    for ever, so the documented onboarding order produced zero briefs;
  * the ticket link and disposition were found by scanning the newest 200
    incidents, so both silently vanished past that;
  * an issue creation that died mid-flight left a reservation that blocked the
    incident from ever being filed again.
"""
import json, os, re, subprocess, urllib.parse, urllib.request, urllib.error, io
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
    raw = o.stdout; i = raw.find("[")
    if i < 0: raise SystemExit(f"d1 failed: {sql}\n{o.stdout}\n{o.stderr}")
    return json.loads(raw[i:])[0]["results"]

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None

def req(path, method="GET", form=None):
    h = {}; data = None
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        h["Content-Type"] = "application/x-www-form-urlencoded"
    if JAR: h["Cookie"] = "; ".join(f"{k}={v}" for k, v in JAR.items())
    r = urllib.request.Request(B + path, data=data, headers=h, method=method)
    try:
        with urllib.request.build_opener(NoRedirect).open(r) as resp:
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

def count(table, where="1=1"):
    return d1(f"SELECT COUNT(*) AS n FROM {table} WHERE {where}")[0]["n"]

def wipe():
    for t in ("users", "integration_secrets", "services", "incidents", "cursors",
              "events", "auth_attempts", "tickets", "dispositions", "briefs"):
        d1(f"DELETE FROM {t}")
    d1("UPDATE deployment SET token_hash=NULL, claimed_at=NULL, claimed_by=NULL")
    d1("UPDATE settings SET kill_switch=0, daily_brief_limit=50 WHERE id=1")
    JAR.clear()


print("\n1. ERRORS THAT ARRIVE BEFORE THE SERVICE IS REGISTERED")
# The runbook says register services at step 4, so a client's first errors
# normally land before any registry entry exists.
wipe()
req("/setup/claim", "POST", form={"name": "Pipeline Test"})
req("/setup/ingest", "POST")
chk("they are recorded, not dropped", count("incidents") > 0, True)
chk("...as unmapped", count("incidents", "status='unmapped'"), count("incidents"))
chk("...with no brief written", count("briefs"), 0)

req("/setup/services", "POST", form={"name": "checkout-service", "repo": "acme/checkout-service",
                                     "slack_channel": "#incidents-checkout", "team": "Checkout"})
d1("DELETE FROM cursors")
req("/setup/ingest", "POST")
chk("registering the service completes them", count("incidents", "service='checkout-service' AND status='unmapped'"), 0)
chk("...briefs are written for them", count("briefs") > 0, True)
chk("...and they are delivered", count("incidents", "service='checkout-service' AND slack_ts IS NOT NULL") > 0, True)
chk("services still unregistered stay unmapped", count("incidents", "service='payments-api' AND status='unmapped'") > 0, True)


print("\n2. A DELIVERED INCIDENT IS NEVER RE-DIAGNOSED")
# The recovery above must not turn every repeat into a fresh model call. A
# brief costs money; paying again for one already delivered would be a leak.
briefed_before = count("events", "kind='briefed'")
briefs_before = count("briefs")
d1("DELETE FROM cursors")
req("/setup/ingest", "POST")
chk("no new brief was generated", count("events", "kind='briefed'"), briefed_before)
chk("...and none was added", count("briefs"), briefs_before)
chk("...the repeat deduped instead", count("events", "kind='deduped'") > 0, True)
chk("...bumping occurrences", count("incidents", "occurrences > 1") > 0, True)


print("\n3. THE TICKET LINK SURVIVES A LARGE BACKLOG")
# Both the incident page and the Slack re-render used to locate these by
# scanning the newest 200 incidents.
# Any incident will do; this section is about the lookup, not the pipeline.
_t = d1("SELECT id FROM incidents ORDER BY status='posted' DESC LIMIT 1")
target = _t[0]["id"]
d1(f"UPDATE incidents SET last_seen='2020-01-01T00:00:00.000Z' WHERE id='{target}'")
d1(f"""INSERT INTO tickets (id,incident_id,provider,external_id,url,created_by,created_at)
       VALUES ('t-backlog','{target}','github','4242','https://github.com/acme/x/issues/4242','test',datetime('now'))""")
rows = ",".join(
    f"('bk-{i}','bkfp-{i}','svc','production','high','E','m','s','v',1,"
    f"'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','briefed',0,"
    f"datetime('now'),datetime('now'))" for i in range(205))
d1(f"""INSERT INTO incidents (id,fingerprint,service,environment,severity,exception_type,message,
       stack_trace,version,occurrences,first_seen,last_seen,status,is_demo,created_at,updated_at)
       VALUES {rows}""")
newer = d1(f"""SELECT COUNT(*) AS n FROM incidents
               WHERE last_seen > (SELECT last_seen FROM incidents WHERE id='{target}')""")[0]["n"]
chk("the ticketed incident is outside the top 200", newer >= 200, True)
_, page = req(f"/incident/{target}")
chk("its issue link still renders", "issues/4242" in page, True)


print("\n4. AN ABANDONED FILING DOES NOT BLOCK RE-FILING")
# A worker evicted between reserving the row and writing the issue url leaves
# a reservation with an empty url.
victim = d1("""SELECT i.id FROM incidents i JOIN briefs b ON b.incident_id = i.id
                WHERE i.id != '%s' LIMIT 1""" % target)
if victim:
    vid = victim[0]["id"]
    d1(f"DELETE FROM tickets WHERE incident_id='{vid}'")
    d1(f"""INSERT INTO tickets (id,incident_id,provider,external_id,url,created_by,created_at)
           VALUES ('t-abandoned','{vid}','github','','','crashed',datetime('now'))""")
    chk("the stale reservation is present", count("tickets", f"incident_id='{vid}' AND url=''"), 1)
    req(f"/incident/{vid}/file", "POST")
    chk("filing now succeeds", count("tickets", f"incident_id='{vid}' AND url != ''"), 1)
    chk("...and did not duplicate the row", count("tickets", f"incident_id='{vid}'"), 1)


print("\n" + "=" * 70)
print(f"  {ok} passed, {fail} failed")
print("=" * 70)
raise SystemExit(1 if fail else 0)
