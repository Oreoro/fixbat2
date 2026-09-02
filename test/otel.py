"""Reading OpenTelemetry-shaped data out of Elasticsearch.

`logs-*` holds two document shapes. ECS is what Beats and Elastic Agent write.
OTLP-native is what arrives at Elastic's OTLP endpoint — how the OpenTelemetry
demo ships, and increasingly how everyone does.

Matching only ECS finds nothing in an OTel deployment, and finds it *silently*:
an empty result is indistinguishable from a quiet hour. So this asserts both
shapes are read, and that the fields a brief depends on survive the trip.
"""
import json, os, re, socket, subprocess, time, urllib.parse, urllib.request, urllib.error, io
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def _dbname():
    try:
        s = io.open(os.path.join(ROOT, "wrangler.jsonc"), encoding="utf-8").read()
        m = re.search(r'"database_name"\s*:\s*"([^"]+)"', s)
        if m: return m.group(1)
    except OSError: pass
    return "fixbat"

def _start_mock():
    def up():
        with socket.socket() as sock:
            sock.settimeout(0.3)
            return sock.connect_ex(("127.0.0.1", 9299)) == 0
    if up(): return
    subprocess.Popen(["python3", os.path.join(os.path.dirname(os.path.abspath(__file__)), "mockes.py")],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        if up(): return
        time.sleep(0.1)
    raise SystemExit("could not start test/mockes.py on port 9299")

_start_mock()
DB=_dbname(); B=os.environ.get("FIXBAT_URL","http://localhost:8787")
ES=os.environ.get("MOCK_ES_URL","http://127.0.0.1:9299"); ok=fail=0; JAR={}

def chk(name, got, want):
    global ok, fail
    good = (want(got) if callable(want) else got == want)
    ok, fail = ok+good, fail+(not good)
    shown = got if not isinstance(got,str) or len(got)<44 else got[:44]+"…"
    print(f"  {'PASS' if good else 'FAIL'}  {name:<52}{shown}{'' if good else f'  (want {want})'}")

def d1(sql):
    o=subprocess.run(["npx","wrangler","d1","execute",DB,"--local","--json","--command",sql],
                     capture_output=True,text=True,cwd=ROOT)
    raw=o.stdout; i=raw.find("[")
    if i<0: raise SystemExit(f"d1 returned no JSON for: {sql}\n{o.stdout}\n{o.stderr}")
    return json.loads(raw[i:])[0]["results"]

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*a,**k): return None

def req(path, method="GET", form=None):
    h={}; data=None
    if form is not None:
        data=urllib.parse.urlencode(form).encode(); h["Content-Type"]="application/x-www-form-urlencoded"
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

for t in ("users","integration_secrets","services","incidents","cursors","events",
          "auth_attempts","tickets","dispositions","briefs","inbox"):
    d1(f"DELETE FROM {t}")
d1("UPDATE deployment SET token_hash=NULL, claimed_at=NULL, claimed_by=NULL")
d1("UPDATE settings SET kill_switch=0, daily_brief_limit=50, log_source='auto' WHERE id=1")
JAR.clear()
req("/setup/claim","POST",form={"name":"OTel Test"})
req("/setup/secrets","POST",form={"name":"ELASTICSEARCH_URL","value":ES})
req("/setup/secrets","POST",form={"name":"ELASTICSEARCH_API_KEY","value":"mock-key"})

# The demo's services, so nothing is skipped as unmapped.
for name in ("payment","cartservice","checkout"):
    req("/setup/services","POST",form={"name":name,"repo":"open-telemetry/opentelemetry-demo",
                                       "slack_channel":"#otel","team":"Demo"})


print("\n1. ELASTICSEARCH IS SELECTED")
chk("with a URL and key, it is the source",
    json.loads(req("/health")[1])["providers"]["logs"], "elasticsearch")

req("/setup/ingest","POST")
rows = {r["service"]: r for r in d1("SELECT service, exception_type, severity, trace_id, stack_trace FROM incidents")}


print("\n2. BOTH DOCUMENT SHAPES ARE READ")
chk("an ECS document becomes an incident", "payment" in rows, True)
chk("an OTLP-native one does too", "cartservice" in rows, True)
chk("...and one graded only by severity_number", "checkout" in rows, True)
chk("nothing else was invented", len(rows), 3)


print("\n3. THE FIELDS A BRIEF DEPENDS ON SURVIVE")
ecs = rows.get("payment", {})
chk("ECS exception type", ecs.get("exception_type"), "PaymentDeclined")
chk("ECS trace id", ecs.get("trace_id"), "ecs0000000000000000000000000001")

otel = rows.get("cartservice", {})
# These live under attributes.exception.* and resource.attributes.*, nowhere
# near where ECS puts them.
chk("OTel exception type", otel.get("exception_type"), "RedisConnectionException")
chk("OTel trace id", otel.get("trace_id"), "otel0000000000000000000000000002")
chk("OTel stack trace is carried", "RedisCartStore.cs" in (otel.get("stack_trace") or ""), True)


print("\n4. SEVERITY COMES FROM EITHER SPELLING")
chk("severity_text ERROR is high", otel.get("severity"), "high")
# 21 is FATAL in OpenTelemetry; there is no textual level on that document.
chk("severity_number 21 is critical", rows.get("checkout",{}).get("severity"), "critical")


print("\n5. THE FAULTING FRAME IS STILL FOUND")
b = d1("""SELECT b.cited_file f FROM briefs b JOIN incidents i ON i.id=b.incident_id
          WHERE i.service='cartservice'""")
# The demo's cartservice is C#. Assert the actual path — an earlier version of
# this allowed "none" to pass, which hid a fixture using a .NET format that
# does not exist.
chk("a C# frame from an OTel document is attributed",
    (b[0]["f"] if b else "no brief"), "src/cartstore/RedisCartStore.cs")

j = d1("""SELECT b.cited_file f, b.cited_line l FROM briefs b JOIN incidents i ON i.id=b.incident_id
          WHERE i.service='checkout'""")
chk("...and a Java frame too", (j[0]["f"] if j else "no brief"), "Main.java")

d1("DELETE FROM integration_secrets")


print("\n" + "=" * 72)
print(f"  {ok} passed, {fail} failed")
print("=" * 72)
raise SystemExit(1 if fail else 0)
