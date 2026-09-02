"""The API contract, route by route.

Every route, the credentials it demands, the codes it returns, and how it
behaves when given something wrong. Written as a contract because clients will
script against these — and because an auth check that silently loosens is the
kind of regression nothing else here would catch.
"""
import json, os, re, subprocess, urllib.parse, urllib.request, urllib.error, io
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def _dbname():
    try:
        s = io.open(os.path.join(ROOT, "wrangler.jsonc"), encoding="utf-8").read()
        m = re.search(r'"database_name"\s*:\s*"([^"]+)"', s)
        if m: return m.group(1)
    except OSError: pass
    return "fixbat"

DB=_dbname(); B=os.environ.get("FIXBAT_URL","http://localhost:8787"); ok=fail=0

def chk(name, got, want):
    global ok, fail
    good = (want(got) if callable(want) else got == want)
    ok, fail = ok+good, fail+(not good)
    shown = got if not isinstance(got, str) or len(got) < 40 else got[:40]+"…"
    print(f"  {'PASS' if good else 'FAIL'}  {name:<50}{shown}{'' if good else f'  (want {want})'}")

def d1(sql):
    o=subprocess.run(["npx","wrangler","d1","execute",DB,"--local","--json","--command",sql],
                     capture_output=True,text=True,cwd=ROOT)
    raw=o.stdout; i=raw.find("[")
    if i<0: raise SystemExit(f"d1 failed: {sql}\n{o.stdout}\n{o.stderr}")
    return json.loads(raw[i:])[0]["results"]

def _ci(pairs):
    """Header names are case-insensitive; the server sends them lowercase."""
    return {k.lower(): v for k, v in pairs}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*a,**k): return None

def call(path, method="GET", form=None, body=None, raw=None, token=None, jar=None, headers=None):
    """Returns (status, body, headers). Never follows redirects."""
    h=dict(headers or {}); data=None
    if form is not None:
        data=urllib.parse.urlencode(form).encode(); h.setdefault("Content-Type","application/x-www-form-urlencoded")
    if body is not None:
        data=json.dumps(body).encode(); h.setdefault("Content-Type","application/json")
    if raw is not None:
        data=raw if isinstance(raw,bytes) else raw.encode(); h.setdefault("Content-Type","application/json")
    if token: h["Authorization"]="Bearer "+token
    if jar: h["Cookie"]="; ".join(f"{k}={v}" for k,v in jar.items())
    r=urllib.request.Request(B+path,data=data,headers=h,method=method)
    try:
        with urllib.request.build_opener(NoRedirect).open(r) as resp:
            if jar is not None:
                for hk,hv in resp.getheaders():
                    if hk.lower()=="set-cookie":
                        m=re.match(r'([^=]+)=([^;]*)',hv)
                        if m: jar[m.group(1)]=m.group(2)
            return resp.status, resp.read().decode(), _ci(resp.getheaders())
    except urllib.error.HTTPError as e:
        if jar is not None:
            for hk,hv in e.headers.items():
                if hk.lower()=="set-cookie":
                    m=re.match(r'([^=]+)=([^;]*)',hv)
                    if m: jar[m.group(1)]=m.group(2)
        return e.code, e.read().decode(), _ci(e.headers.items())

def status(*a, **k): return call(*a, **k)[0]

# ---- a claimed deployment with data ---------------------------------------
for t in ("users","integration_secrets","services","incidents","cursors","events",
          "auth_attempts","tickets","dispositions","briefs","inbox"):
    d1(f"DELETE FROM {t}")
d1("UPDATE deployment SET token_hash=NULL, claimed_at=NULL, claimed_by=NULL")
d1("UPDATE settings SET kill_switch=0, daily_brief_limit=50, log_source='auto', trace_url_template='' WHERE id=1")

SESSION={}
_, body, _ = call("/setup/claim","POST",form={"name":"API Test"},jar=SESSION)
TOKEN=(re.search(r'select-all">([A-Za-z0-9_-]{40,})', body) or [None,""])[1]
call("/setup/demo","POST",jar=SESSION)
INCIDENT=d1("SELECT id FROM incidents LIMIT 1")[0]["id"]


print("\n1. PUBLIC ROUTES NEED NOTHING")
for path in ("/health","/kumo.css","/client.js"):
    chk(f"GET {path}", status(path), 200)
chk("GET /setup/signin", status("/setup/signin"), 200)
chk("/health is JSON", call("/health")[2].get("content-type","").startswith("application/json"), True)
h=json.loads(call("/health")[1])
chk("/health names every provider role",
    sorted(h["providers"].keys()), ["diagnoser","logs","repo","slack","tickets"])
chk("/health leaks no credential", "sk-" in json.dumps(h) or "Bearer" in json.dumps(h), False)


print("\n2. READING INCIDENTS REQUIRES A SESSION")
for path in ("/", "/metrics", "/services", f"/incident/{INCIDENT}", f"/preview/{INCIDENT}"):
    chk(f"anonymous GET {path[:22]}", status(path), 302)
    chk(f"  signed in", status(path, jar=SESSION), 200)


print("\n3. THE ADMIN API REQUIRES A BEARER TOKEN")
ADMIN=[("/admin/ingest",None),("/admin/reset",None),("/admin/verify",None),
       ("/admin/services",{"name":"x","repo":"a/b","slack_channel":"#c"}),
       ("/admin/settings",{}),("/dev/ingest",None),("/dev/reset",None)]
for path,payload in ADMIN:
    chk(f"anonymous POST {path[:20]}", status(path,"POST",body=payload or {}), 401)
    chk(f"  wrong token", status(path,"POST",body=payload or {},token="nope"), 401)
chk("a valid token is accepted", status("/admin/settings","POST",body={},token=TOKEN), 200)
chk("a session also works", status("/admin/settings","POST",body={},jar=SESSION), 200)


print("\n4. VALIDATION AND ERROR SHAPES")
chk("unknown route, JSON client", status("/nope"), 404)
chk("unknown route, browser", status("/nope",headers={"Accept":"text/html"}), 404)
chk("  ...and it is a real page",
    "<html" in call("/nope",headers={"Accept":"text/html"})[1].lower(), True)
chk("unknown incident", status("/incident/does-not-exist",jar=SESSION), 404)
chk("preview of unknown incident", status("/preview/does-not-exist",jar=SESSION), 404)
chk("services POST missing fields",
    status("/admin/services","POST",body={"name":"only"},token=TOKEN), 400)
chk("  ...error is JSON",
    "error" in json.loads(call("/admin/services","POST",body={"name":"only"},token=TOKEN)[1]), True)
chk("resolve with a bad value",
    status(f"/incident/{INCIDENT}/resolve","POST",form={"resolution":"maybe"},jar=SESSION), 400)
chk("dismiss with a bad kind",
    status(f"/incident/{INCIDENT}/dismiss","POST",form={"kind":"whatever"},jar=SESSION), 400)
chk("unknown secret name is refused",
    "error" in call("/setup/secrets","POST",form={"name":"NOT_A_SECRET","value":"x"},jar=SESSION)[2].get("location",""), True)


print("\n5. THE PUSH ENDPOINT")
chk("unconfigured, no token", status("/ingest","POST",body=[]), 503)
call("/setup/secrets","POST",form={"name":"INGEST_TOKEN","value":"api-test-key"},jar=SESSION)
chk("configured, no token", status("/ingest","POST",body=[]), 401)
chk("configured, wrong token", status("/ingest","POST",body=[],token="wrong"), 401)
chk("admin token is not an ingest token", status("/ingest","POST",body=[],token=TOKEN), 401)
chk("correct token, empty batch", status("/ingest","POST",body=[],token="api-test-key"), 200)
chk("malformed JSON", status("/ingest","POST",raw="{not json",token="api-test-key"), 400)
chk("a single object is accepted",
    status("/ingest","POST",body={"service":"s","stackTrace":""},token="api-test-key"), 200)
chk("over 100 events is refused",
    status("/ingest","POST",body=[{"service":"s"}]*101,token="api-test-key"), 413)
chk("exactly 100 is accepted",
    status("/ingest","POST",body=[{"service":"s"}]*100,token="api-test-key"), 200)
call("/setup/secrets/delete","POST",form={"name":"INGEST_TOKEN"},jar=SESSION)


print("\n6. SLACK WEBHOOK AUTHENTICATES BY SIGNATURE")
chk("unsigned is rejected", status("/slack/actions","POST",raw="payload=%7B%7D"), 401)
chk("garbage signature is rejected",
    status("/slack/actions","POST",raw="payload=%7B%7D",
           headers={"X-Slack-Request-Timestamp":"1","X-Slack-Signature":"v0=bad",
                    "Content-Type":"application/x-www-form-urlencoded"}), 401)


print("\n7. SECURITY HEADERS ON EVERY PAGE")
hdr = call("/", jar=SESSION)[2]
for name in ("content-security-policy","x-content-type-options","x-frame-options","referrer-policy"):
    chk(f"{name}", name in hdr, True)
chk("frame-ancestors none", "frame-ancestors 'none'" in hdr.get("content-security-policy",""), True)
chk("assets are immutable", "immutable" in call("/kumo.css")[2].get("cache-control",""), True)
cookie = call("/setup/signin","POST",form={"token":TOKEN},jar={})[2].get("set-cookie","")
chk("session cookie is HttpOnly", "HttpOnly" in cookie, True)
chk("session cookie is SameSite=Strict", "SameSite=Strict" in cookie, True)
chk("session cookie is not the token", TOKEN not in cookie, True)


print("\n8. SETUP ROUTES REQUIRE A SESSION")
for path in ("/setup","/setup/demo","/setup/demo/clear","/setup/ingest","/setup/kill",
             "/setup/services","/setup/users","/setup/secrets","/setup/verify"):
    method = "GET" if path == "/setup" else "POST"
    chk(f"anonymous {method} {path[:20]}", status(path, method), 302)


print("\n9. VERIFICATION REPORTS PER CONNECTION")
r = json.loads(call("/admin/verify","POST",token=TOKEN)[1])
chk("returns a check per provider", len(r["checks"]) >= 8, True)
chk("nothing configured means ok is null",
    all(c["ok"] is None for c in r["checks"] if not c["configured"]), True)
chk("every check names its role",
    all(c["role"] in ("logs","repo","tickets","briefs","slack") for c in r["checks"]), True)
chk("a summary is returned", len(r["summary"]) > 0, True)
chk("it is audited", d1("SELECT COUNT(*) n FROM events WHERE kind='connections_verified'")[0]["n"] > 0, True)

# A wrong credential must come back as one readable line, not a raw JSON body:
# this detail is rendered into a banner. Makes a real call to the provider.
call("/setup/secrets","POST",form={"name":"GITHUB_TOKEN","value":"ghp_not_a_real_token"},jar=SESSION)
r = json.loads(call("/admin/verify","POST",token=TOKEN)[1])
gh = next(c for c in r["checks"] if c["name"] == "GitHub")
chk("a wrong credential is reported as failing", gh["ok"], False)
chk("...with a single-line detail", "\n" not in gh["detail"], True)
chk("...kept short enough for a banner", len(gh["detail"]) < 160, True)
chk("...naming the provider's own reason", "credential" in gh["detail"].lower(), True)
chk("the summary counts the failure", "1 of" in r["summary"], True)
chk("overall ok is false", r["ok"], False)
call("/setup/secrets/delete","POST",form={"name":"GITHUB_TOKEN"},jar=SESSION)


print("\n" + "=" * 72)
print(f"  {ok} passed, {fail} failed")
print("=" * 72)
raise SystemExit(1 if fail else 0)
