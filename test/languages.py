"""Stack traces from every supported runtime, pushed through the real ingest
endpoint and read back from the incident the pipeline produced.

The frame this parser finds is what the fingerprint is built from, what blame
is scoped to and what the brief cites. If it picks a dependency frame, the
brief points at somebody else's library; if it picks nothing, incidents group
by message text instead of by location, which is far coarser.
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

DB = _dbname()
B = os.environ.get("FIXBAT_URL", "http://localhost:8787")
ok = fail = 0
JAR = {}

def chk(name, got, want):
    global ok, fail
    good = got == want
    ok, fail = ok + good, fail + (not good)
    print(f"  {'PASS' if good else 'FAIL'}  {name:<44}{got}{'' if good else f'  (want {want})'}")

def d1(sql):
    o = subprocess.run(["npx","wrangler","d1","execute",DB,"--local","--json","--command",sql],
                       capture_output=True, text=True, cwd=ROOT)
    raw = o.stdout; i = raw.find("[")
    if i < 0: raise SystemExit(f"d1 failed: {sql}\n{o.stdout}\n{o.stderr}")
    return json.loads(raw[i:])[0]["results"]

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*a,**k): return None

def req(path, method="GET", form=None, body=None, token=None):
    h={}; data=None
    if form is not None:
        data=urllib.parse.urlencode(form).encode(); h["Content-Type"]="application/x-www-form-urlencoded"
    if body is not None:
        data=json.dumps(body).encode(); h["Content-Type"]="application/json"
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
        for hk,hv in e.headers.items():
            if hk.lower()=="set-cookie":
                m=re.match(r'([^=]+)=([^;]*)',hv)
                if m: JAR[m.group(1)]=m.group(2)
        return e.code, e.read().decode()

# Each case: the trace, and the file/function that must be attributed. Every
# one has a dependency frame ABOVE the application frame, so a parser that
# simply took the first line it could read would fail all of them.
CASES = [
  ("python", "app/checkout/pricing.py", "apply_promotion",
   'Traceback (most recent call last):\n'
   '  File "/usr/lib/python3.11/site-packages/flask/app.py", line 2213, in __call__\n'
   '    return self.wsgi_app(environ, start_response)\n'
   '  File "/app/checkout/pricing.py", line 142, in apply_promotion\n'
   '    return summary.total * discount\n'
   "AttributeError: 'NoneType' object has no attribute 'total'"),

  ("jvm", "Pricing.java", "com.acme.checkout.Pricing.applyPromotion",
   'java.lang.NullPointerException: Cannot invoke "Total.value()"\n'
   '\tat org.springframework.web.servlet.DispatcherServlet.doDispatch(DispatcherServlet.java:1071)\n'
   '\tat com.acme.checkout.Pricing.applyPromotion(Pricing.java:142)\n'
   '\tat com.acme.checkout.Summary.build(Summary.java:88)'),

  ("go", "/app/checkout/pricing.go", "main.applyPromotion",
   'panic: runtime error: invalid memory address\n\n'
   'goroutine 1 [running]:\n'
   'runtime.gopanic(...)\n'
   '\t/usr/local/go/src/runtime/panic.go:914 +0x21f\n'
   'main.applyPromotion(0xc000180000)\n'
   '\t/app/checkout/pricing.go:142 +0x1f'),

  ("ruby", "/app/checkout/pricing.rb", "apply_promotion",
   "NoMethodError: undefined method `total' for nil\n"
   "\tfrom /usr/local/bundle/gems/rails-7.0/lib/action_controller.rb:214:in `process'\n"
   "\tfrom /app/checkout/pricing.rb:142:in `apply_promotion'"),

  ("php", "/app/Checkout/Pricing.php", "applyPromotion()",
   'PHP Fatal error:  Uncaught TypeError\n'
   'Stack trace:\n'
   '#0 /app/vendor/laravel/framework/src/Router.php(725): handle()\n'
   '#1 /app/Checkout/Pricing.php(142): applyPromotion()'),

  ("dotnet", "/app/Checkout/Pricing.cs", "Acme.Checkout.Pricing.ApplyPromotion()",
   'System.NullReferenceException: Object reference not set to an instance of an object.\n'
   '   at System.Linq.Enumerable.First[TSource](IEnumerable`1 source) in /_/src/System.Linq.cs:line 55\n'
   '   at Acme.Checkout.Pricing.ApplyPromotion() in /app/Checkout/Pricing.cs:line 142'),

  ("javascript", "/app/src/checkout/pricing.ts", "applyPromotion",
   "TypeError: Cannot read properties of undefined (reading 'total')\n"
   '    at Layer.handle (/app/node_modules/express/lib/router/layer.js:95:5)\n'
   '    at applyPromotion (/app/src/checkout/pricing.ts:142:31)'),
]

# ---- a deployment configured for pushed events ----------------------------
for t in ("users","integration_secrets","services","incidents","cursors","events",
          "auth_attempts","tickets","dispositions","briefs","inbox"):
    d1(f"DELETE FROM {t}")
d1("UPDATE deployment SET token_hash=NULL, claimed_at=NULL, claimed_by=NULL")
d1("UPDATE settings SET kill_switch=0, daily_brief_limit=50, log_source='http' WHERE id=1")
JAR.clear()
req("/setup/claim","POST",form={"name":"Lang Test"})
req("/setup/secrets","POST",form={"name":"INGEST_TOKEN","value":"ingest-secret-for-tests"})
for lang, _f, _fn, _st in CASES:
    req("/setup/services","POST",form={"name":f"svc-{lang}","repo":f"acme/{lang}",
                                       "slack_channel":"#inc","team":"Eng"})

print("\n1. THE PUSH ENDPOINT")
chk("rejects a missing token", req("/ingest","POST",body=[{}])[0], 401)
chk("rejects a wrong token", req("/ingest","POST",body=[{}],token="nope")[0], 401)
events = [{"service": f"svc-{lang}", "environment": "production", "severity": "high",
           "exceptionType": "E", "message": f"{lang} failure", "stackTrace": st,
           "occurredAt": "2026-09-02T10:00:00.000Z", "traceId": f"tr-{lang}"}
          for lang, _f, _fn, st in CASES]
s, body = req("/ingest","POST",body=events,token="ingest-secret-for-tests")
chk("accepts a batch", (s, json.loads(body).get("accepted")), (200, len(CASES)))
chk("buffered, not processed yet", d1("SELECT COUNT(*) n FROM incidents")[0]["n"], 0)

req("/setup/ingest","POST")
chk("the run drained the inbox", d1("SELECT COUNT(*) n FROM incidents")[0]["n"], len(CASES))

print("\n2. THE APPLICATION FRAME, PER RUNTIME")
for lang, want_file, want_fn, _st in CASES:
    row = d1(f"SELECT cited_file, cited_line FROM briefs b JOIN incidents i ON i.id=b.incident_id "
             f"WHERE i.service='svc-{lang}'")
    got = row[0] if row else {}
    # the brief cites the frame the parser found
    chk(f"{lang}: line attributed", got.get("cited_line"), 142)

print("\n3. DEPENDENCY FRAMES ARE SKIPPED")
# Every trace above has a framework frame before the application one.
DEPENDENCY_MARKERS = ["node_modules", "site-packages", "/vendor/", "/gems/",
                      "/usr/local/go/", "springframework", "System.Linq", "laravel"]
for lang, want_file, want_fn, _st in CASES:
    row = d1(f"SELECT cited_file FROM briefs b JOIN incidents i ON i.id=b.incident_id "
             f"WHERE i.service='svc-{lang}'")
    cited = (row[0]["cited_file"] or "") if row else ""
    chk(f"{lang}: cited the application file",
        cited.endswith(want_file.split("/")[-1]), True)
    chk(f"{lang}: not a dependency path",
        any(mark.lower() in cited.lower() for mark in DEPENDENCY_MARKERS), False)

print("\n4. DEDUPE STILL WORKS ACROSS LANGUAGES")
before = d1("SELECT COUNT(*) n FROM incidents")[0]["n"]
req("/ingest","POST",body=events,token="ingest-secret-for-tests")
req("/setup/ingest","POST")
chk("re-pushing the same errors adds none", d1("SELECT COUNT(*) n FROM incidents")[0]["n"], before)
chk("...it bumps occurrences", d1("SELECT COUNT(*) n FROM incidents WHERE occurrences>1")[0]["n"], len(CASES))

print("\n5. THE INBOX DOES NOT GROW FOR EVER")
# Rows survive being read so a crash mid-run replays rather than loses the
# window, but they must eventually go or the table grows without bound.
kept_before = d1("SELECT COUNT(*) n FROM inbox")[0]["n"]
chk("consumed rows are still present", kept_before > 0, True)
d1("UPDATE inbox SET received_at='2020-01-01T00:00:00.000Z' "
   "WHERE id = (SELECT MIN(id) FROM inbox)")
req("/setup/ingest", "POST")
kept_after = d1("SELECT COUNT(*) n FROM inbox")[0]["n"]
chk("one consumed row past retention is cleared", kept_after, kept_before - 1)
chk("recent rows are kept for replay", kept_after > 0, True)

d1("UPDATE settings SET log_source='auto' WHERE id=1")   # leave the default behind

print("\n" + "=" * 66)
print(f"  {ok} passed, {fail} failed")
print("=" * 66)
raise SystemExit(1 if fail else 0)
