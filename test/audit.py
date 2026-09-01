"""Full product audit: a brand-new client, from empty deployment to daily use."""
import hashlib, hmac, json, re, subprocess, time, urllib.parse, urllib.request, urllib.error, io
import os, re as _re
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def _dbname():
    """Read the database name from wrangler.jsonc so a rename cannot drift."""
    try:
        s = io.open(os.path.join(ROOT, "wrangler.jsonc"), encoding="utf-8").read()
        m = _re.search(r'"database_name"\s*:\s*"([^"]+)"', s)
        if m: return m.group(1)
    except OSError:
        pass
    return "fixbat"

DB = _dbname()

B=os.environ.get("FIXBAT_URL", "http://localhost:8787"); SECRET=b"test_signing_secret_local_only"
ok=fail=0; JAR={}

def chk(name, got, want):
    global ok, fail
    good = got == want
    ok, fail = ok+good, fail+(not good)
    print(f"  {'PASS' if good else 'FAIL'}  {name:<48}{got}{'' if good else f'  (want {want})'}")

def d1(sql):
    o=subprocess.run(["npx","wrangler","d1","execute",DB,"--local","--json","--command",sql],
                     capture_output=True,text=True,cwd=ROOT)
    return json.loads(o.stdout)[0]["results"]

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*a,**k): return None

def req(path, method="GET", form=None, body=None, token=None, follow=False, headers=None):
    h=dict(headers or {}); data=None
    if form is not None:
        data=urllib.parse.urlencode(form).encode(); h["Content-Type"]="application/x-www-form-urlencoded"
    if body is not None:
        data=json.dumps(body).encode(); h["Content-Type"]="application/json"
    if token: h["Authorization"]="Bearer "+token
    if JAR: h["Cookie"]="; ".join(f"{k}={v}" for k,v in JAR.items())
    r=urllib.request.Request(B+path,data=data,headers=h,method=method)
    op=urllib.request.build_opener() if follow else urllib.request.build_opener(NoRedirect)
    try:
        with op.open(r) as resp:
            for _,v in resp.getheaders():
                pass
            for hk,hv in resp.getheaders():
                if hk.lower()=="set-cookie":
                    m=re.match(r'([^=]+)=([^;]*)',hv)
                    if m: JAR[m.group(1)]=m.group(2)
            return resp.status, resp.read().decode(), dict(resp.getheaders())
    except urllib.error.HTTPError as e:
        for hk,hv in e.headers.items():
            if hk.lower()=="set-cookie":
                m=re.match(r'([^=]+)=([^;]*)',hv)
                if m: JAR[m.group(1)]=m.group(2)
        return e.code, e.read().decode(), dict(e.headers)

def slack(action, iid, sign=True):
    payload={"type":"block_actions","user":{"id":"U0DEV"},"actions":[{"action_id":action,"value":iid}]}
    b=urllib.parse.urlencode({"payload":json.dumps(payload)}); ts=str(int(time.time()))
    h={"Content-Type":"application/x-www-form-urlencoded"}
    if sign:
        h["X-Slack-Request-Timestamp"]=ts
        h["X-Slack-Signature"]="v0="+hmac.new(SECRET,f"v0:{ts}:{b}".encode(),hashlib.sha256).hexdigest()
    r=urllib.request.Request(B+"/slack/actions",data=b.encode(),headers=h,method="POST")
    try:
        with urllib.request.urlopen(r) as resp: return resp.status
    except urllib.error.HTTPError as e: return e.code

# ---- reset to a genuinely fresh deployment --------------------------------
d1("DELETE FROM users"); d1("DELETE FROM integration_secrets")
d1("UPDATE deployment SET token_hash=NULL, claimed_at=NULL, claimed_by=NULL")
d1("DELETE FROM services"); d1("DELETE FROM incidents"); d1("DELETE FROM cursors")
d1("DELETE FROM events"); d1("DELETE FROM auth_attempts"); d1("DELETE FROM tickets")
d1("DELETE FROM dispositions"); d1("DELETE FROM briefs")
JAR.clear()

print("\n1. FRESH DEPLOYMENT — nothing configured")
s,_,h = req("/"); chk("incident list requires sign-in", s, 302)
chk("  ...and points at claim", "/setup/claim" in h.get("Location",""), True)
chk("/health stays open", req("/health")[0], 200)
chk("static CSS stays open", req("/kumo.css")[0], 200)
chk("admin API 409 until claimed", req("/admin/ingest","POST")[0], 409)
chk("claim page renders", "Claim this deployment" in req("/setup/claim")[1], True)

print("\n2. CLAIM")
s,body,_ = req("/setup/claim","POST",form={"name":"Audit Owner"})
m = re.search(r'select-all">([A-Za-z0-9_-]{40,})', body)
TOKEN = m.group(1) if m else ""
chk("token issued", len(TOKEN), 43)
chk("only the hash is stored", len(d1("SELECT token_hash FROM users")[0]["token_hash"]), 64)
chk("signed in automatically", "fixbat_session" in JAR, True)
chk("incident list now reachable", req("/")[0], 200)
chk("claim is one-time", req("/setup/claim","POST",form={"name":"Interloper"})[2].get("Location","").endswith("/setup/signin"), True)

print("\n3. DEMO IN ONE CLICK")
chk("setup page loads", req("/setup")[0], 200)
req("/setup/demo","POST")
inc = d1("SELECT id, service, status FROM incidents")
chk("demo incidents created", len(inc), 8)
chk("demo services registered", len(d1("SELECT 1 FROM services WHERE is_demo=1")), 3)
chk("briefs written", len(d1("SELECT 1 FROM briefs")), 8)
chk("list renders them", len(set(re.findall(r'href="/incident/([a-f0-9-]+)"', req("/")[1]))), 8)

print("\n4. THE PRODUCT")
iid = inc[0]["id"]
chk("incident detail", req(f"/incident/{iid}")[0], 200)
chk("metrics", req("/metrics")[0], 200)
chk("services", req("/services")[0], 200)
chk("Block Kit preview", req(f"/preview/{iid}")[0], 200)
html = req("/")[1]
chk("filter by severity", len(set(re.findall(r'href="/incident/([a-f0-9-]+)"', req("/?severity=critical")[1]))), 2)
chk("free-text search", len(set(re.findall(r'href="/incident/([a-f0-9-]+)"', req("/?q=redis")[1]))), 1)
_s=dict(JAR)
chk("404 is a real page", "Not found" in req("/nope", headers={"Accept":"text/html"})[1], True)
JAR.clear(); JAR.update(_s)

print("\n5. DEDUPE + CURSOR")
before = d1("SELECT SUM(occurrences) n FROM incidents")[0]["n"]
req("/setup/ingest","POST")
chk("re-running changes nothing", d1("SELECT SUM(occurrences) n FROM incidents")[0]["n"], before)
chk("cursor persisted", len(d1("SELECT 1 FROM cursors")), 1)

print("\n6. SLACK BUTTONS")
chk("unsigned rejected", slack("file_issue", iid, sign=False), 401)
chk("signed accepted", slack("file_issue", iid), 200)
time.sleep(2)
chk("exactly one ticket", len(d1("SELECT 1 FROM tickets")), 1)
chk("double click is safe", (slack("file_issue", iid), time.sleep(2), len(d1("SELECT 1 FROM tickets")))[2], 1)

print("\n7. CORRECTNESS SIGNAL")
chk("resolve needs a session", (lambda: (JAR.copy(), JAR.clear(), req(f"/incident/{iid}/resolve","POST",form={"resolution":"cause_wrong"})[0], JAR.update(_saved))[2])() if (_saved:=dict(JAR)) else 0, 302)
JAR.update(_saved)
chk("resolve works signed in", req(f"/incident/{iid}/resolve","POST",form={"resolution":"cause_confirmed"})[0], 303)
chk("bad value rejected", req(f"/incident/{iid}/resolve","POST",form={"resolution":"lgtm"})[0], 400)
chk("hit rate reflects it", "100%" in req("/metrics")[1], True)

print("\n8. GUARDRAILS")
req("/setup/kill","POST",form={"kill_switch":"1"})
chk("kill switch halts", json.loads(req("/admin/ingest","POST",token=TOKEN)[1])["halted"] is not None, True)
chk("banner shown", "Paused" in req("/")[1], True)
req("/setup/kill","POST",form={"kill_switch":"0"})
req("/admin/settings","POST",body={"daily_brief_limit":2},token=TOKEN)
d1("DELETE FROM incidents WHERE 1=1"); d1("DELETE FROM cursors"); d1("DELETE FROM briefs")
r = json.loads(req("/admin/ingest","POST",token=TOKEN)[1])
chk("daily cap enforced", (r["briefed"], r["capped"]), (2, 6))
req("/admin/settings","POST",body={"daily_brief_limit":50},token=TOKEN)

print("\n9. SECURITY")
_,_,h = req("/")
for hdr in ["content-security-policy","x-content-type-options","x-frame-options","referrer-policy"]:
    chk(hdr, any(k.lower()==hdr for k in h), True)
saved=dict(JAR); JAR.clear()
for _ in range(5): req("/setup/signin","POST",form={"token":"guess"})
chk("brute force locked out", "locked=" in req("/setup/signin","POST",form={"token":TOKEN})[2].get("Location",""), True)
d1("DELETE FROM auth_attempts"); JAR.update(saved)
_s=dict(JAR); JAR.clear()
chk("admin API rejects bad bearer", req("/admin/settings","POST",body={},token="wrong")[0], 401)
JAR.update(_s)

print("\n10. AUDIT TRAIL")
before = len(d1("SELECT 1 FROM events WHERE actor IS NOT NULL"))
req("/admin/reset","POST",token=TOKEN)
chk("survives a full data reset", len(d1("SELECT 1 FROM events WHERE actor IS NOT NULL")) >= before, True)
kinds = [r["kind"] for r in d1("SELECT kind FROM events WHERE actor IS NOT NULL ORDER BY id")]
for k in ["deployment_claimed","demo_loaded","manual_ingest","paused","resumed","resolved"]:
    chk(f"logged: {k}", k in kinds, True)

print(f"\n{'='*70}\n  {ok} passed, {fail} failed\n{'='*70}")
