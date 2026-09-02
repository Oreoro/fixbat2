import json, re, subprocess, urllib.parse, urllib.request, urllib.error, io
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

B=os.environ.get("FIXBAT_URL", "http://localhost:8787"); ok=fail=0
def chk(n,g,w):
    global ok,fail
    good=g==w; ok,fail=ok+good,fail+(not good)
    print(f"  {'PASS' if good else 'FAIL'}  {n:<46}{g}{'' if good else f'  (want {w})'}")
def d1(sql):
    o=subprocess.run(["npx","wrangler","d1","execute",DB,"--local","--json","--command",sql],
                     capture_output=True,text=True,cwd=ROOT)
    # wrangler sometimes prints a banner (an update notice, say) before the
    # JSON, so parse from the first bracket rather than the first byte.
    raw = o.stdout
    i = raw.find("[")
    if i < 0:
        raise SystemExit(f"d1 returned no JSON for: {sql}\n{o.stdout}\n{o.stderr}")
    return json.loads(raw[i:])[0]["results"]
class NR(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*a,**k): return None
def req(path,method="GET",form=None,token=None,jar=None,follow=False):
    h={}; data=None
    if form is not None:
        data=urllib.parse.urlencode(form).encode(); h["Content-Type"]="application/x-www-form-urlencoded"
    if token: h["Authorization"]="Bearer "+token
    if jar: h["Cookie"]="; ".join(f"{k}={v}" for k,v in jar.items())
    r=urllib.request.Request(B+path,data=data,headers=h,method=method)
    op=urllib.request.build_opener() if follow else urllib.request.build_opener(NR)
    try:
        with op.open(r) as resp: hs=dict(resp.getheaders()); body=resp.read().decode(); st=resp.status
    except urllib.error.HTTPError as e: hs=dict(e.headers); body=e.read().decode(); st=e.code
    if jar is not None and "Set-Cookie" in hs:
        m=re.match(r'([^=]+)=([^;]*)',hs["Set-Cookie"])
        if m: jar[m.group(1)]=m.group(2)
    return st, body, hs

# fresh, unclaimed
d1("DELETE FROM integration_secrets"); d1("DELETE FROM users"); d1("UPDATE deployment SET token_hash=NULL,claimed_at=NULL,claimed_by=NULL")
d1("DELETE FROM events"); d1("DELETE FROM auth_attempts")

print("\n1. CLAIM NAMES AN OWNER")
owner={}
s,body,_=req("/setup/claim","POST",form={"name":"Priya Raman"},jar=owner)
m=re.search(r'select-all">([A-Za-z0-9_-]{40,})',body); PRIYA=m.group(1) if m else ""
chk("owner token issued", len(PRIYA), 43)
chk("greeted by name", "Welcome, Priya Raman" in body, True)
u=d1("SELECT name, role FROM users")
chk("owner row created", (u[0]["name"], u[0]["role"]), ("Priya Raman","owner"))
chk("only hash stored", len(d1("SELECT token_hash FROM users")[0]["token_hash"]), 64)
chk("claim attributed to person", d1("SELECT actor FROM events WHERE kind='deployment_claimed'")[0]["actor"], "Priya Raman")

print("\n2. ADDING A SECOND ADMIN")
s,_,h=req("/setup/users","POST",form={"name":"Tomas Lindqvist"},jar=owner)
TOMAS=urllib.parse.unquote(re.search(r'token=([^&]+)',h.get("Location","")).group(1))
chk("second token issued", len(TOMAS), 43)
chk("two people now", len(d1("SELECT 1 FROM users")), 2)
chk("creator recorded", d1("SELECT created_by FROM users WHERE name='Tomas Lindqvist'")[0]["created_by"], "Priya Raman")
chk("duplicate name refused", "error=" in req("/setup/users","POST",form={"name":"Tomas Lindqvist"},jar=owner)[2].get("Location",""), True)

print("\n3. EACH PERSON IS ATTRIBUTED")
tomas={}
req("/setup/signin","POST",form={"token":TOMAS},jar=tomas)
chk("Tomas can sign in", "fixbat_session" in tomas, True)
req("/setup/demo","POST",jar=tomas)
chk("demo attributed to Tomas", d1("SELECT actor FROM events WHERE kind='demo_loaded' ORDER BY id DESC")[0]["actor"], "Tomas Lindqvist")
req("/setup/kill","POST",form={"kill_switch":"1"},jar=owner)
chk("pause attributed to Priya", d1("SELECT actor FROM events WHERE kind='paused' ORDER BY id DESC")[0]["actor"], "Priya Raman")
req("/setup/kill","POST",form={"kill_switch":"0"},jar=owner)
chk("bearer token attributed", (req("/admin/ingest","POST",token=TOMAS), d1("SELECT actor FROM events WHERE kind IS NOT NULL AND actor='Tomas Lindqvist'"))[1] != [], True)
chk("last_seen recorded", d1("SELECT last_seen_at FROM users WHERE name='Tomas Lindqvist'")[0]["last_seen_at"] is not None, True)

print("\n4. REVOKING ONE PERSON")
tid=d1("SELECT id FROM users WHERE name='Tomas Lindqvist'")[0]["id"]
req("/setup/users/toggle","POST",form={"id":tid,"name":"Tomas Lindqvist","disabled":"1"},jar=owner)
chk("Tomas disabled", d1("SELECT disabled FROM users WHERE name='Tomas Lindqvist'")[0]["disabled"], 1)
chk("his bearer token now fails", req("/admin/ingest","POST",token=TOMAS)[0], 401)
chk("his session now fails", req("/setup",jar=tomas)[0], 302)
chk("Priya is unaffected", req("/setup",jar=owner)[0], 200)
chk("audit still names him", d1("SELECT COUNT(*) n FROM events WHERE actor='Tomas Lindqvist'")[0]["n"] > 0, True)

print("\n5. THE LAST OWNER CANNOT LOCK EVERYONE OUT")
pid=d1("SELECT id FROM users WHERE role='owner'")[0]["id"]
s,_,h=req("/setup/users/toggle","POST",form={"id":pid,"name":"Priya Raman","disabled":"1"},jar=owner)
chk("refused", "last active owner" in urllib.parse.unquote(h.get("Location","")), True)
chk("still active", d1("SELECT disabled FROM users WHERE role='owner'")[0]["disabled"], 0)

print(f"\n{'='*66}\n  {ok} passed, {fail} failed\n{'='*66}")
