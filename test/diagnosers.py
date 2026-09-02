"""Who writes the brief, and whether the guarantees hold whoever it is.

The model is the one optional part of this product: everything else — the
fingerprint, the frame, blame, delivery — is deterministic. So a deployment
must be able to choose Anthropic, any OpenAI-compatible endpoint (GLM,
DeepSeek, a self-hosted vLLM), or nothing at all, and get the same checks
applied to what comes back.

Runs against a mock OpenAI-compatible server so the real paths are exercised
without a paid key.
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

DB=_dbname(); B=os.environ.get("FIXBAT_URL","http://localhost:8787")
MOCK=os.environ.get("MOCK_AI_URL","http://127.0.0.1:8899/v1")
ok=fail=0; JAR={}

def chk(name, got, want):
    global ok, fail
    good = got == want
    ok, fail = ok+good, fail+(not good)
    shown = got if not isinstance(got,str) or len(got)<44 else got[:44]+"…"
    print(f"  {'PASS' if good else 'FAIL'}  {name:<50}{shown}{'' if good else f'  (want {want})'}")

def d1(sql):
    o=subprocess.run(["npx","wrangler","d1","execute",DB,"--local","--json","--command",sql],
                     capture_output=True,text=True,cwd=ROOT)
    raw=o.stdout; i=raw.find("[")
    if i<0: raise SystemExit(f"d1 returned no JSON for: {sql}\n{o.stdout}\n{o.stderr}")
    return json.loads(raw[i:])[0]["results"]

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*a,**k): return None

def req(path, method="GET", form=None, token=None):
    h={}; data=None
    if form is not None:
        data=urllib.parse.urlencode(form).encode(); h["Content-Type"]="application/x-www-form-urlencoded"
    if token: h["Authorization"]="Bearer "+token
    if JAR: h["Cookie"]="; ".join(f"{k}={v}" for k,v in JAR.items())
    r=urllib.request.Request(B+path,data=data,headers=h,method=method)
    try:
        with urllib.request.build_opener(NoRedirect).open(r) as resp:
            for hk,hv in resp.getheaders():
                if hk.lower()=="set-cookie":
                    m=re.match(r'([^=]+)=([^;]*)',hv)
                    if m: JAR[m.group(1)]=m.group(2)
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

def put(n,v): req("/setup/secrets","POST",form={"name":n,"value":v})
def drop(n):  req("/setup/secrets/delete","POST",form={"name":n})
def diagnoser(): return json.loads(req("/health")[1])["providers"]["diagnoser"]

def count_where(cond):
    return d1(f"SELECT COUNT(*) n FROM briefs WHERE {cond}")[0]["n"]

def fresh():
    for t in ("incidents","cursors","events","tickets","dispositions","briefs"):
        d1(f"DELETE FROM {t}")

def run_once():
    d1("DELETE FROM cursors")
    req("/setup/ingest","POST")

for t in ("users","integration_secrets","services","incidents","cursors","events",
          "auth_attempts","tickets","dispositions","briefs","inbox"):
    d1(f"DELETE FROM {t}")
d1("UPDATE deployment SET token_hash=NULL, claimed_at=NULL, claimed_by=NULL")
d1("UPDATE settings SET kill_switch=0, daily_brief_limit=50, log_source='auto' WHERE id=1")
JAR.clear()
req("/setup/claim","POST",form={"name":"Diagnoser Test"})
req("/setup/demo","POST")


print("\n1. THE MODEL IS OPTIONAL")
chk("with no key at all, briefs are canned", diagnoser(), "simulated")
chk("...and the pipeline still delivered", d1("SELECT COUNT(*) n FROM briefs")[0]["n"] > 0, True)


print("\n2. AN OPENAI-COMPATIBLE ENDPOINT IS USED WHEN CONFIGURED")
put("OPENAI_BASE_URL", MOCK); put("OPENAI_API_KEY", "mock-key"); put("OPENAI_MODEL", "mock-good")
chk("the diagnoser switches", diagnoser(), "openai-compatible")
fresh(); run_once()
row = d1("SELECT source, model, summary, spend_usd FROM briefs LIMIT 1")
chk("it wrote a brief", len(row), 1)
chk("...attributed to the endpoint", row[0]["source"], "openai-compatible")
chk("...naming the model", row[0]["model"], "mock-good")
chk("...with the returned summary", row[0]["summary"].startswith("Order confirmation throws"), True)


print("\n3. THE SAME GUARDS APPLY WHOEVER ANSWERS")
# The mock cites deadbee, which is not among the commits it was given. The
# filter that drops invented commits matters more with a cheaper model, not less.
cited = json.loads(d1("SELECT cited_commits c FROM briefs LIMIT 1")[0]["c"])
shas = [c.get("shortSha") for c in cited]
chk("an invented commit is dropped", "deadbee" in shas, False)


print("\n4. UNPRICED SPEND IS ZERO, NOT A GUESS")
chk("no price configured means zero", row[0]["spend_usd"], 0)
put("OPENAI_PRICE_IN", "1"); put("OPENAI_PRICE_OUT", "5")
fresh(); run_once()
# 2400 prompt + 600 completion at $1/$5 per million = $0.0054
chk("with prices, spend is computed",
    round(d1("SELECT spend_usd s FROM briefs LIMIT 1")[0]["s"], 6), 0.0054)


print("\n5. ENDPOINTS THAT DIFFER STILL WORK")
put("OPENAI_MODEL", "mock-fenced"); fresh(); run_once()
chk("JSON wrapped in prose and fences is read",
    d1("SELECT COUNT(*) n FROM briefs")[0]["n"] > 0, True)

put("OPENAI_MODEL", "mock-no-schema"); fresh(); run_once()
chk("a server without json_schema falls back",
    d1("SELECT COUNT(*) n FROM briefs")[0]["n"] > 0, True)

put("OPENAI_MODEL", "mock-truncated"); fresh(); run_once()
chk("a truncated answer is refused, not stored", d1("SELECT COUNT(*) n FROM briefs")[0]["n"], 0)
chk("...and reported", d1("SELECT COUNT(*) n FROM events WHERE kind='pipeline_error'")[0]["n"] > 0, True)


print("\n6. A CITATION IS A PATH, NOT A SENTENCE")
# cited_file is fed straight into the code host's URL builder, so prose there
# produces a link to a path that cannot exist. A real glm-5.3-flash response
# returned exactly this, with the line number left null.
put("OPENAI_MODEL", "mock-prose-citation"); fresh(); run_once()
cite = d1("SELECT cited_file f, cited_line l FROM briefs LIMIT 1")[0]
chk("the path is extracted from the prose", cite["f"], "src/payments/idempotency.ts")
chk("...the runtime app/ prefix is stripped", cite["f"].startswith("app/"), False)
chk("...and the line is recovered from it", cite["l"], 33)


# A basename alone reads correctly but links to a path that does not exist.
# The evidence already carried the full path, so prefer it.
put("OPENAI_MODEL", "mock-basename-citation"); fresh(); run_once()
# The mock cites "pricing.ts" for every incident, so only the incident whose
# own frame is pricing.ts can resolve it — pick that one deliberately.
# The mock cites the bare "pricing.ts" for every incident. Assert on the set
# rather than trying to pin one row: several fixtures mention that file
# somewhere in their trace, and only the ones that actually failed in it should
# be resolved.
resolved = count_where("cited_file = 'src/checkout/pricing.ts'")
left = count_where("cited_file = 'pricing.ts'")
chk("it resolves where the frame agrees", resolved >= 1, True)
chk("...and leaves it alone everywhere else", left >= 1, True)
chk("...never inventing a third form",
    count_where("cited_file NOT IN ('pricing.ts','src/checkout/pricing.ts')"), 0)


print("\n7. ANTHROPIC REMAINS THE DEFAULT")
put("OPENAI_MODEL", "mock-good")
put("ANTHROPIC_API_KEY", "sk-ant-not-real")
chk("with both configured, Anthropic wins", diagnoser(), "anthropic")
drop("ANTHROPIC_API_KEY")
chk("removing it falls back to the endpoint", diagnoser(), "openai-compatible")
for n in ("OPENAI_BASE_URL","OPENAI_API_KEY","OPENAI_MODEL","OPENAI_PRICE_IN","OPENAI_PRICE_OUT"):
    drop(n)
chk("removing everything returns to canned briefs", diagnoser(), "simulated")

print("\n" + "=" * 72)
print(f"  {ok} passed, {fail} failed")
print("=" * 72)
raise SystemExit(1 if fail else 0)
