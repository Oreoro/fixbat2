"""Per-request correlation: captured, shown, linkable — and kept out of the
fingerprint.

The last one is the point. The fingerprint answers "which bug is this"; a trace
id is unique per request. Hashing one into the other would give every single
occurrence its own identity and silently destroy dedupe — one bad deploy would
go back to four hundred Slack messages. This suite is what holds that line.
"""
import hashlib, json, os, re, subprocess, urllib.parse, urllib.request, urllib.error, io
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
    print(f"  {'PASS' if good else 'FAIL'}  {name:<50}{got}{'' if good else f'  (want {want})'}")

def d1(sql):
    o = subprocess.run(["npx", "wrangler", "d1", "execute", DB, "--local", "--json", "--command", sql],
                       capture_output=True, text=True, cwd=ROOT)
    try:
        return json.loads(o.stdout)[0]["results"]
    except Exception:
        raise SystemExit(f"d1 failed: {sql}\n{o.stdout}\n{o.stderr}")

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None

def req(path, method="GET", form=None, body=None, token=None):
    h = {}; data = None
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        h["Content-Type"] = "application/x-www-form-urlencoded"
    if body is not None:
        data = json.dumps(body).encode(); h["Content-Type"] = "application/json"
    if token: h["Authorization"] = "Bearer " + token
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

# ---- a fresh deployment with the sample incidents loaded --------------------
for t in ("users", "integration_secrets", "services", "incidents", "cursors",
          "events", "auth_attempts", "tickets", "dispositions", "briefs"):
    d1(f"DELETE FROM {t}")
d1("UPDATE deployment SET token_hash=NULL, claimed_at=NULL, claimed_by=NULL")
d1("UPDATE settings SET kill_switch=0, trace_url_template='' WHERE id=1")
JAR.clear()

_, body = req("/setup/claim", "POST", form={"name": "Trace Test"})
m = re.search(r'select-all">([A-Za-z0-9_-]{40,})', body)
TOKEN = m.group(1) if m else ""
req("/setup/demo", "POST")

fixtures = json.load(io.open(os.path.join(ROOT, "fixtures", "incidents.json"), encoding="utf-8"))

# ---- an independent oracle -------------------------------------------------
# Reimplemented from the spec, not imported from the source: if the fingerprint
# ever starts folding in a trace id, these expectations stop matching.
FRAME = re.compile(r'^\s*at\s+(?:async\s+)?(.+?)\s+\((.+?):(\d+):(\d+)\)\s*$')

def first_app_frame(stack):
    for line in stack.split("\n"):
        m = FRAME.match(line)
        if not m:
            continue
        fn, f = m.group(1).strip(), m.group(2)
        if "/node_modules/" in f or "\\node_modules\\" in f:
            continue
        return fn, f
    return None

def normalize_message(msg):
    out = re.sub(r'0x[0-9a-f]+', '<hex>', msg, flags=re.I)
    out = re.sub(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<uuid>', out, flags=re.I)
    return re.sub(r'\d+', '<n>', out)[:200]

def fingerprint_of(e):
    fr = first_app_frame(e["stack_trace"])
    tail = f"{fr[1]}:{fr[0]}" if fr else normalize_message(e["message"])
    return hashlib.sha256(
        f"{e['service']} {e['environment']} {e['exception_type']} {tail}".encode()
    ).hexdigest()

# The pipeline reads events oldest-first, so within a fingerprint the last one
# processed is the one with the smallest minutes_ago. Latest non-null trace wins.
ordered = sorted(fixtures, key=lambda e: -e["minutes_ago"])
groups = {}
for e in ordered:
    g = groups.setdefault(fingerprint_of(e), {"n": 0, "trace": None})
    g["n"] += 1
    if e.get("trace_id"):
        g["trace"] = e["trace_id"]

expected_incidents = len(groups)
expected_with_trace = sum(1 for g in groups.values() if g["trace"])
expected_without = expected_incidents - expected_with_trace


print("\n1. THE CORRELATION ID IS CAPTURED")
chk("samples collapse to one row per bug", count("incidents"), expected_incidents)
chk("...those with a trace kept it", count("incidents", "trace_id IS NOT NULL"), expected_with_trace)
chk("...those without are null, not empty", count("incidents", "trace_id IS NULL"), expected_without)
chk("no trace was invented", count("incidents", "trace_id = ''"), 0)

# Where two occurrences of one bug carried different traces, the later one is
# kept — an incident firing now is best debugged from its most recent request.
stored = {r["fingerprint"]: r["trace_id"] for r in d1("SELECT fingerprint, trace_id FROM incidents")}
want = {fp: g["trace"] for fp, g in groups.items()}
chk("every stored trace is the latest for its bug",
    sum(1 for k in want if stored.get(k) == want[k]), len(want))


print("\n2. IT IS NOT PART OF THE FINGERPRINT")
# The fingerprint is sha256 over service, environment, exception type and the
# first application frame as "file:function" — and nothing else. Computed here
# independently, so hashing a trace id in would break this immediately.
pricing = next(e for e in fixtures if "checkout/pricing.ts" in e["stack_trace"].split("\n")[1])
expected = fingerprint_of(pricing)
row = d1(f"""SELECT id, fingerprint, trace_id FROM incidents
              WHERE fingerprint = '{expected}' LIMIT 1""")
chk("the frame hash alone identifies the bug", len(row), 1)
row = row[0]
chk("...and that incident does carry a trace", bool(row["trace_id"]), True)
# The clincher: two sample events share this bug and carry *different* traces,
# yet produced one incident. If the trace were hashed in, there would be two.
same_bug = [e for e in fixtures if fingerprint_of(e) == expected]
chk("...two requests, different traces, one incident", len(same_bug) >= 2, True)
chk("...their traces really do differ",
    len({e.get("trace_id") for e in same_bug}) > 1, True)

# Every fingerprint must be distinct-by-bug, not distinct-by-request: 9 sample
# events that dedupe correctly cannot produce 9 different traces' worth of rows.
chk("one row per bug, not per request",
    d1("SELECT COUNT(DISTINCT fingerprint) AS n FROM incidents")[0]["n"], count("incidents"))


print("\n3. DEDUPE STILL COLLAPSES WITH TRACES PRESENT")
before = count("incidents")
d1("DELETE FROM cursors")          # replay the same window
req("/setup/ingest", "POST")
chk("re-ingesting minted no new incidents", count("incidents"), before)
chk("...it bumped occurrences instead", count("incidents", "occurrences > 1") > 0, True)


print("\n4. IT IS SHOWN, AND LINKABLE")
iid, trace = row["id"], row["trace_id"]
_, page = req(f"/incident/{iid}")
chk("the incident page shows the trace", trace in page, True)
chk("...unlinked until told where traces live", f'href="https://apm.example.com' in page, False)

req("/admin/settings", "POST", body={"trace_url_template": "https://apm.example.com/traces/{traceId}"},
    token=TOKEN)
_, page = req(f"/incident/{iid}")
chk("with a template it becomes a link", f"https://apm.example.com/traces/{trace}" in page, True)
chk("the kill switch survived the update", d1("SELECT kill_switch FROM settings")[0]["kill_switch"], 0)

# an incident whose source emitted no trace must still render
none_id = d1("SELECT id FROM incidents WHERE trace_id IS NULL LIMIT 1")
if none_id:
    s, _ = req(f"/incident/{none_id[0]['id']}")
    chk("an incident with no trace still renders", s, 200)


print("\n" + "=" * 70)
print(f"  {ok} passed, {fail} failed")
print("=" * 70)
raise SystemExit(1 if fail else 0)
