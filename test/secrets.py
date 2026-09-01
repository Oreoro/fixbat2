"""Credentials entered through the UI: stored encrypted, and actually used."""
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
    print(f"  {'PASS' if good else 'FAIL'}  {n:<50}{g}{'' if good else f'  (want {w})'}")
def d1(sql):
    o=subprocess.run(["npx","wrangler","d1","execute",DB,"--local","--json","--command",sql],
                     capture_output=True,text=True,cwd=ROOT)
    return json.loads(o.stdout)[0]["results"]
class NR(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*a,**k): return None
def req(path,method="GET",form=None,jar=None):
    h={}; data=None
    if form is not None:
        data=urllib.parse.urlencode(form).encode(); h["Content-Type"]="application/x-www-form-urlencoded"
    if jar is not None and jar: h["Cookie"]="; ".join(f"{k}={v}" for k,v in jar.items())
    r=urllib.request.Request(B+path,data=data,headers=h,method=method)
    try:
        with urllib.request.build_opener(NR).open(r) as resp:
            hs=dict(resp.getheaders()); st=resp.status; body=resp.read().decode()
    except urllib.error.HTTPError as e:
        hs=dict(e.headers); st=e.code; body=e.read().decode()
    if jar is not None and "Set-Cookie" in hs:
        m=re.match(r'([^=]+)=([^;]*)', hs["Set-Cookie"])
        if m: jar[m.group(1)]=m.group(2)
    return st, body, hs

d1("DELETE FROM users"); d1("DELETE FROM integration_secrets")
d1("UPDATE deployment SET token_hash=NULL,claimed_at=NULL,claimed_by=NULL,key_material=NULL")
jar={}
_, body, _ = req("/setup/claim", "POST", form={"name": "Ops"}, jar=jar)
tok = re.search(r'select-all">([A-Za-z0-9_-]{40,})', body).group(1)

print("\n1. NO TERMINAL NEEDED")
chk("starts simulated", json.loads(req("/health")[1])["providers"]["diagnoser"], "simulated")
req("/setup/secrets","POST",form={"name":"ANTHROPIC_API_KEY","value":"sk-ant-test-abcd1234"},jar=jar)
chk("provider flips to live", json.loads(req("/health")[1])["providers"]["diagnoser"], "anthropic")

print("\n2. STORED ENCRYPTED")
row=d1("SELECT ciphertext, hint FROM integration_secrets WHERE name='ANTHROPIC_API_KEY'")[0]
chk("plaintext not in database", "sk-ant-test-abcd1234" in row["ciphertext"], False)
chk("only a tail hint is kept", row["hint"], "••••1234")
chk("hint never reveals the key", "sk-ant" in row["hint"], False)
chk("key material generated", d1("SELECT key_material FROM deployment")[0]["key_material"] is not None, True)
chk("value not echoed to the page", "sk-ant-test-abcd1234" in req("/setup",jar=jar)[1], False)
chk("hint IS shown", "••••1234" in req("/setup",jar=jar)[1], True)
chk("audit records the change, not the value",
    d1("SELECT detail FROM events WHERE kind='secret_set' ORDER BY id DESC")[0]["detail"], "ANTHROPIC_API_KEY")

print("\n3. ROUND TRIP")
req("/setup/secrets","POST",form={"name":"ELASTICSEARCH_URL","value":"https://es.example.com"},jar=jar)
chk("log source flips to live", json.loads(req("/health")[1])["providers"]["logs"], "elasticsearch")
req("/setup/secrets/delete","POST",form={"name":"ELASTICSEARCH_URL"},jar=jar)
chk("removal reverts to fixtures", json.loads(req("/health")[1])["providers"]["logs"], "fixture")

print("\n4. GUARDS")
chk("unknown name refused", "error=" in req("/setup/secrets","POST",form={"name":"AWS_KEY","value":"x"},jar=jar)[2].get("Location",""), True)
chk("empty value refused", "error=" in req("/setup/secrets","POST",form={"name":"GITHUB_TOKEN","value":"  "},jar=jar)[2].get("Location",""), True)
chk("anonymous cannot set secrets", req("/setup/secrets","POST",form={"name":"GITHUB_TOKEN","value":"x"})[0], 302)
chk("anonymous did not write", len(d1("SELECT 1 FROM integration_secrets WHERE name='GITHUB_TOKEN'")), 0)

print(f"\n{'='*70}\n  {ok} passed, {fail} failed\n{'='*70}")
