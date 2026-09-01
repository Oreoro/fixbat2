"""Which provider is live, and why.

Clients mix these: code on GitHub, work in Jira, errors in Sentry. The
selection has to be predictable, independent per role, and overridable — a
client with several configured should never have to guess which one is running.
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

DB=_dbname(); B=os.environ.get("FIXBAT_URL","http://localhost:8787"); ok=fail=0; JAR={}

def chk(name, got, want):
    global ok, fail
    good = got == want
    ok, fail = ok+good, fail+(not good)
    print(f"  {'PASS' if good else 'FAIL'}  {name:<46}{got}{'' if good else f'  (want {want})'}")

def d1(sql):
    o=subprocess.run(["npx","wrangler","d1","execute",DB,"--local","--json","--command",sql],
                     capture_output=True,text=True,cwd=ROOT)
    raw=o.stdout; i=raw.find("[")
    if i<0: raise SystemExit(f"d1 failed: {sql}\n{o.stdout}\n{o.stderr}")
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
        for hk,hv in e.headers.items():
            if hk.lower()=="set-cookie":
                m=re.match(r'([^=]+)=([^;]*)',hv)
                if m: JAR[m.group(1)]=m.group(2)
        return e.code, e.read().decode()

def providers():
    return json.loads(req("/health")[1])["providers"]

def put(name, value): req("/setup/secrets","POST",form={"name":name,"value":value})
def drop(name):       req("/setup/secrets/delete","POST",form={"name":name})

for t in ("users","integration_secrets","services","incidents","cursors","events",
          "auth_attempts","tickets","dispositions","briefs","inbox"):
    d1(f"DELETE FROM {t}")
d1("UPDATE deployment SET token_hash=NULL, claimed_at=NULL, claimed_by=NULL")
d1("UPDATE settings SET kill_switch=0, log_source='auto' WHERE id=1")
JAR.clear()
req("/setup/claim","POST",form={"name":"Provider Test"})


print("\n1. NOTHING CONFIGURED")
p = providers()
chk("logs are the bundled samples", p["logs"], "fixture")
chk("repo is simulated", p["repo"], "simulated")
chk("tickets are simulated", p["tickets"], "simulated")


print("\n2. LOG SOURCES, MOST SPECIFIC FIRST")
put("ELASTICSEARCH_URL","https://es.example.invalid")
chk("elasticsearch when only it is set", providers()["logs"], "elasticsearch")
put("DATADOG_API_KEY","dd"); put("DATADOG_APP_KEY","app")
chk("datadog outranks elasticsearch", providers()["logs"], "datadog")
put("SENTRY_TOKEN","t"); put("SENTRY_ORG","acme"); put("SENTRY_PROJECT","web")
chk("sentry outranks datadog", providers()["logs"], "sentry")

# Precedence is a default, not a cage.
d1("UPDATE settings SET log_source='elasticsearch' WHERE id=1")
chk("an explicit choice overrides all of it", providers()["logs"], "elasticsearch")
d1("UPDATE settings SET log_source='auto' WHERE id=1")

for n in ("SENTRY_TOKEN","SENTRY_ORG","SENTRY_PROJECT","DATADOG_API_KEY",
          "DATADOG_APP_KEY","ELASTICSEARCH_URL"):
    drop(n)
chk("removing them reverts to samples", providers()["logs"], "fixture")


print("\n3. CODE HOSTS")
put("GITLAB_TOKEN","gl")
chk("gitlab when only it is set", providers()["repo"], "gitlab")
put("GITHUB_TOKEN","gh")
chk("github takes precedence", providers()["repo"], "github")
chk("...and brings its own issues", providers()["tickets"], "github")
drop("GITHUB_TOKEN")
chk("without github, gitlab issues", providers()["tickets"], "gitlab")
drop("GITLAB_TOKEN")

put("AZDO_TOKEN","t"); put("AZDO_ORG","acme"); put("AZDO_PROJECT","platform")
chk("azure devops repo", providers()["repo"], "azuredevops")
chk("...and its work items", providers()["tickets"], "azuredevops")


print("\n4. THE TRACKER IS INDEPENDENT OF THE CODE HOST")
# The common real case: code in one place, work in another.
put("GITHUB_TOKEN","gh")
put("JIRA_URL","https://acme.atlassian.net"); put("JIRA_TOKEN","t"); put("JIRA_PROJECT_KEY","OPS")
chk("code stays on github", providers()["repo"], "github")
chk("...while work goes to jira", providers()["tickets"], "jira")

drop("JIRA_URL"); drop("JIRA_TOKEN"); drop("JIRA_PROJECT_KEY")
put("LINEAR_TOKEN","lin"); put("LINEAR_TEAM_ID","team_123")
chk("linear is chosen the same way", providers()["tickets"], "linear")
chk("...code host unaffected", providers()["repo"], "github")

drop("LINEAR_TOKEN"); drop("LINEAR_TEAM_ID")
chk("falling back to the host's own issues", providers()["tickets"], "github")

for n in ("GITHUB_TOKEN","AZDO_TOKEN","AZDO_ORG","AZDO_PROJECT"):
    drop(n)
chk("all removed, everything simulated again",
    (providers()["repo"], providers()["tickets"]), ("simulated","simulated"))

print("\n" + "=" * 68)
print(f"  {ok} passed, {fail} failed")
print("=" * 68)
raise SystemExit(1 if fail else 0)
