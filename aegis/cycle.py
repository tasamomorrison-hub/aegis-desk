"""One engine cycle, for scheduled runs (GitHub Actions): mark, evaluate if due, save, exit.

    python aegis/cycle.py [--action cycle|evaluate|pause|resume|reset] [--out DIR]

Persists state in state/paper_state.json (committed back to the repo by the workflow) and writes
the dashboard's data files to --out (default: state/).
"""
import argparse, json, os, sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from aegis import live as L
from aegis import strategy as S
from aegis.data import live_quotes

STATE_DIR = os.path.join(ROOT, "state")
L.STATE_PATH = os.path.join(STATE_DIR, "paper_state.json")


def session_today(st, now):
    """True when SPY has printed today, i.e. today is a trading day (handles exchange holidays)."""
    t = st["quotes"].get("SPY", {}).get("time")
    return bool(t) and datetime.fromtimestamp(t, L.ET).date() == now.date()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--action", default="cycle", choices=["cycle", "evaluate", "pause", "resume", "reset"])
    ap.add_argument("--out", default=STATE_DIR)
    a = ap.parse_args()
    os.makedirs(STATE_DIR, exist_ok=True)
    st = L.load_state()
    now = datetime.now(L.ET)

    if a.action == "reset":
        st = L.fresh_state(); L.log_event(st, "Paper account reset to $100,000")
    elif a.action == "pause":
        st["paused"] = True; L.log_event(st, "Engine paused by operator")
    elif a.action == "resume":
        st["paused"] = False; L.log_event(st, "Engine resumed by operator")

    if not st.get("paused") and a.action != "pause":
        L.mark(st, live_quotes(S.UNIVERSE))
        due = (session_today(st, now) and (now.hour, now.minute) >= L.EVAL_AT
               and st["last_eval_date"] != str(now.date()))
        if a.action == "evaluate":
            L.evaluate(st, "manual")
        elif due or not st["positions"]:
            L.evaluate(st, "daily close" if due else "initial allocation")

    L.save_state(st)
    pub = L.public_state(st)
    pub["static"] = True
    pub["updated"] = int(datetime.now().timestamp())
    repo = os.environ.get("GITHUB_REPOSITORY")
    if repo:
        pub["controls_url"] = f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{repo}/actions/workflows/aegis.yml"
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "state.json"), "w") as f:
        json.dump(pub, f)
    print(f"{now:%Y-%m-%d %H:%M} ET  equity ${pub['equity']:,.2f}  positions {len(st['positions'])}  {st.get('message', '')}")


if __name__ == "__main__":
    main()
