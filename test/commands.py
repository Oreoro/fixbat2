"""Configuring FixBat from Slack.

The command surface changes what the product does and spends, so the contract
that matters is the gate: a request Slack did not sign is refused, and a person
Slack will not confirm as an admin is refused. Both must fail closed.
"""
import hashlib, hmac, io, json, os, re, subprocess, time, urllib.parse, urllib.request, urllib.error
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def _dbname():
    try:
        s = io.open(os.path.join(ROOT, "wrangler.jsonc"), encoding="utf-8").read()
        m = re.search(r'"database_name"\s*:\s*"([^"]+)"', s)
        if m: return m.group(1)
    except OSError: pass
    return "fixbat"

def _signing_secret():
    """Whatever .dev.vars puts in force — a Worker secret always wins."""
    try:
        s = io.open(os.path.join(ROOT, ".dev.vars"), encoding="utf-8").read()
        m = re.search(r'^SLACK_SIGNING_SECRET=(.+)$', s, re.M)
        if m: return m.group(1).strip()
    except OSError: pass
    return ""

DB=_dbname(); B=os.environ.get("FIXBAT_URL","http://localhost:8787")
SECRET=_signing_secret().encode(); ok=fail=0

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

def command(text, signed=True, user="U098NU6DYUV"):
    """Returns (status, reply text)."""
    body = urllib.parse.urlencode({
        "command": "/fixbat", "text": text, "user_id": user, "user_name": "tester",
        "channel_id": "C0TEST", "response_url": "https://hooks.slack.test/none",
        "trigger_id": "1.2.3"})
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    if signed:
        ts = str(int(time.time()))
        headers["X-Slack-Request-Timestamp"] = ts
        headers["X-Slack-Signature"] = "v0=" + hmac.new(
            SECRET, f"v0:{ts}:{body}".encode(), hashlib.sha256).hexdigest()
    r = urllib.request.Request(B + "/slack/commands", data=body.encode(),
                               headers=headers, method="POST")
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, (json.loads(resp.read().decode()).get("text") or "")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

if not SECRET:
    raise SystemExit("no SLACK_SIGNING_SECRET in .dev.vars — cannot sign test requests")

for t in ("users","integration_secrets","services","incidents","cursors","events",
          "auth_attempts","tickets","dispositions","briefs","inbox"):
    d1(f"DELETE FROM {t}")
d1("UPDATE settings SET kill_switch=0, daily_brief_limit=50, log_source='auto' WHERE id=1")


print("\n1. ONLY SLACK CAN CALL THIS")
chk("an unsigned command is refused", command("status", signed=False)[0], 401)
body = urllib.parse.urlencode({"command":"/fixbat","text":"pause"})
r = urllib.request.Request(B+"/slack/commands", data=body.encode(), method="POST",
    headers={"Content-Type":"application/x-www-form-urlencoded",
             "X-Slack-Request-Timestamp":str(int(time.time())),
             "X-Slack-Signature":"v0="+"0"*64})
try:
    with urllib.request.urlopen(r) as resp: forged = resp.status
except urllib.error.HTTPError as e: forged = e.code
chk("a forged signature is refused", forged, 401)
chk("a correctly signed one is accepted", command("help")[0], 200)


print("\n2. READING IS OPEN, CHANGING IS NOT")
chk("help needs no privilege", "FixBat" in command("help")[1], True)
chk("an empty command shows help", "/fixbat status" in command("")[1], True)
status = command("status")[1]
chk("status needs no privilege", "Running" in status or "Paused" in status, True)
chk("...and reports what is connected", "briefs `" in status, True)


print("\n3. THE ADMIN GATE FAILS CLOSED")
# Slack is simulated in tests, so isWorkspaceAdmin cannot confirm anyone. Every
# command that changes something must refuse — never default to allowing it.
for verb in ("pause", "resume", "limit 10", "source http",
             "watch svc a/b #c", "unwatch svc", "verify", "run", "services"):
    reply = command(verb)[1]
    chk(f"`{verb[:18]}` is refused", "workspace admins" in reply, True)

chk("nothing was paused", d1("SELECT kill_switch k FROM settings")[0]["k"], 0)
chk("no service was created", d1("SELECT COUNT(*) n FROM services")[0]["n"], 0)
chk("the cap is untouched", d1("SELECT daily_brief_limit l FROM settings")[0]["l"], 50)
chk("the log source is untouched", d1("SELECT log_source s FROM settings")[0]["s"], "auto")


print("\n4. AN UNKNOWN COMMAND SAYS SO")
reply = command("frobnicate")[1]
chk("it names what was not understood", "frobnicate" in reply, True)
chk("...and shows the usage", "/fixbat status" in reply, True)


print("\n" + "=" * 72)
print(f"  {ok} passed, {fail} failed")
print("=" * 72)
raise SystemExit(1 if fail else 0)
