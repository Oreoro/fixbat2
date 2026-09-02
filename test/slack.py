"""The Slack message — the surface a developer actually reads.

Multi-host support broke this quietly: the "Where" link and the filed-issue
line were built as github.com URLs whatever the client's code host or tracker
was, so a GitLab shop got a dead link on the one element that says where to
look. The preview endpoint renders exactly what Slack receives, so these assert
against the real blocks.
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
    shown = got if not isinstance(got,str) or len(got)<46 else got[:46]+"…"
    print(f"  {'PASS' if good else 'FAIL'}  {name:<48}{shown}{'' if good else f'  (want {want})'}")

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

def blocks(iid):
    return json.loads(req(f"/preview/{iid}")[1])["blocks"]

def where_block(bs):
    """The *Where* section in full — its link sits on the line after the label."""
    for b in bs:
        t = b.get("text")
        if isinstance(t, dict) and t.get("text", "").startswith("*Where*"):
            return t["text"]
    return ""

def flat(bs):
    """All the text in a message, however it is nested."""
    out=[]
    for b in bs:
        t=b.get("text")
        if isinstance(t,dict): out.append(t.get("text",""))
        for e in b.get("elements",[]):
            if isinstance(e,dict) and isinstance(e.get("text"),str): out.append(e["text"])
            elif isinstance(e,dict) and isinstance(e.get("text"),dict): out.append(e["text"].get("text",""))
    return "\n".join(out)

for t in ("users","integration_secrets","services","incidents","cursors","events",
          "auth_attempts","tickets","dispositions","briefs","inbox"):
    d1(f"DELETE FROM {t}")
d1("UPDATE deployment SET token_hash=NULL, claimed_at=NULL, claimed_by=NULL")
d1("UPDATE settings SET kill_switch=0, log_source='auto', base_url='' WHERE id=1")
JAR.clear()
req("/setup/claim","POST",form={"name":"Slack Test"})


print("\n1. THE DEPLOYMENT LEARNS ITS OWN ADDRESS")
chk("unknown before anyone opens setup", d1("SELECT base_url FROM settings")[0]["base_url"], "")
req("/setup")
chk("recorded from the first visit", d1("SELECT base_url FROM settings")[0]["base_url"], B)

req("/setup/demo","POST")
traced = d1("SELECT id FROM incidents WHERE trace_id IS NOT NULL LIMIT 1")[0]["id"]
plain  = d1("SELECT id FROM incidents WHERE trace_id IS NULL LIMIT 1")
text = flat(blocks(traced))


print("\n2. THE MESSAGE LEADS BACK TO THE INCIDENT")
# Whether the cause was right is recorded on the incident page, and that is the
# product's precision metric. Without this there was no route to it.
chk("links to this deployment's incident page", f"{B}/incident/{traced}" in text, True)
chk("...and says what is there", "whether this cause was right" in text, True)


print("\n3. CORRELATION IS CARRIED ACROSS")
trace = d1(f"SELECT trace_id FROM incidents WHERE id='{traced}'")[0]["trace_id"]
chk("the trace id is in the message", trace in text, True)
if plain:
    chk("an incident without one says nothing",
        "trace `" in flat(blocks(plain[0]["id"])), False)


print("\n4. LINKS FOLLOW THE CLIENT'S CODE HOST")
chk("simulated demo links github-style", "https://github.com/acme/" in text, True)
req("/setup/secrets","POST",form={"name":"GITLAB_TOKEN","value":"glpat-test"})
gl = flat(blocks(traced))
where = where_block(blocks(traced))
chk("with GitLab configured, the link is GitLab's", "gitlab.com/acme/" in where and "/-/blob/" in where, True)
# Only the Where link is rebuilt per host. Commit URLs were captured at
# diagnosis time and are deliberately historical — changing a token later must
# not rewrite what was already reviewed.
chk("...and the Where link is no longer github.com", "https://github.com/" in where, False)
req("/setup/secrets/delete","POST",form={"name":"GITLAB_TOKEN"})


print("\n5. A CHANNEL CAN BE A NAME OR AN ID")
# Slack accepts #name or a raw id, and an id is the only way to reach a private
# channel or a DM. Prefixing everything with # made those unreachable.
req("/setup/services","POST",form={"name":"by-name","repo":"a/b",
                                   "slack_channel":"eng-alerts","team":"E"})
req("/setup/services","POST",form={"name":"by-id","repo":"a/b",
                                   "slack_channel":"D0BU7EV6B3P","team":"E"})
req("/setup/services","POST",form={"name":"already-hashed","repo":"a/b",
                                   "slack_channel":"#ops","team":"E"})
got = {r["name"]: r["slack_channel"] for r in d1("SELECT name, slack_channel FROM services")}
chk("a bare name gains its #", got.get("by-name"), "#eng-alerts")
chk("a channel id is left alone", got.get("by-id"), "D0BU7EV6B3P")
chk("an existing # is not doubled", got.get("already-hashed"), "#ops")


print("\n6. A FILED ISSUE NAMES THE TRACKER THAT HAS IT")
d1(f"""INSERT INTO tickets (id,incident_id,provider,external_id,url,created_by,created_at)
       VALUES ('t-slack','{traced}','jira','OPS-42','https://acme.atlassian.net/browse/OPS-42','t',datetime('now'))""")
filed = flat(blocks(traced))
chk("the ticket link is shown", "OPS-42" in filed, True)
chk("...named as jira, not GitHub", "view in jira" in filed, True)
chk("...and the buttons are gone", "file_issue" in json.dumps(blocks(traced)), False)


print("\n" + "=" * 70)
print(f"  {ok} passed, {fail} failed")
print("=" * 70)
raise SystemExit(1 if fail else 0)
