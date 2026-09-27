"""AEGIS live paper-trading engine + dashboard server.

Real prices, simulated money. Marks to market every minute; evaluates the strategy once per
trading day at 15:45 ET (or on demand) and fills at the live price plus slippage.
Run:  .venv/bin/python aegis/live.py   then open http://localhost:8787
"""
import json, os, sys, threading, time, traceback
from datetime import datetime
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from zoneinfo import ZoneInfo

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from aegis import strategy as S
from aegis.data import load_universe, live_quotes, DATA_DIR

ET = ZoneInfo("America/New_York")
STATE_PATH = os.path.join(DATA_DIR, "paper_state.json")
START_CASH = 100_000.0
SLIPPAGE = 0.0005
EVAL_AT = (15, 45)
PORT = int(os.environ.get("AEGIS_PORT", 8787))

lock = threading.Lock()


def market_status(now=None):
    now = now or datetime.now(ET)
    open_ = now.replace(hour=9, minute=30, second=0, microsecond=0)
    close = now.replace(hour=16, minute=0, second=0, microsecond=0)
    is_open = now.weekday() < 5 and open_ <= now < close  # exchange holidays show as open-but-flat
    return dict(open=is_open, now=now.isoformat(), weekday=now.weekday())


def fresh_state():
    return dict(cash=START_CASH, positions={}, equity_log=[], trades=[], peak=START_CASH,
                mr_state={}, rot_w={}, last_month=None, dd_state={"tripped": False},
                last_eval_date=None, paused=False, created=datetime.now(ET).isoformat(),
                signals={}, governor={}, target={}, quotes={}, message="Initialising", events=[])


def load_state():
    if os.path.exists(STATE_PATH):
        with open(STATE_PATH) as f:
            return json.load(f)
    return fresh_state()


def save_state(st):
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f)
    os.replace(tmp, STATE_PATH)


def log_event(st, msg):
    st["events"] = (st.get("events", []) + [[datetime.now(ET).isoformat(timespec="seconds"), msg]])[-60:]
    st["message"] = msg


def equity(st):
    return st["cash"] + sum(sh * st["quotes"].get(s, {}).get("price", 0) for s, sh in st["positions"].items())


def mark(st, q=None):
    q = q if q is not None else live_quotes(S.UNIVERSE)
    good = {s: v for s, v in q.items() if "price" in v}
    st["quotes"].update(good)
    eq = equity(st)
    st["peak"] = max(st["peak"], eq)
    st["equity_log"] = (st["equity_log"] + [[int(time.time()), round(eq, 2)]])[-5000:]
    return eq


def evaluate(st, reason):
    """Run the full AEGIS decision stack on history + today's live prices, then trade to target."""
    px = load_universe(S.UNIVERSE)
    today = pd.Timestamp(datetime.now(ET).date())
    live_row = {s: st["quotes"][s]["price"] for s in S.UNIVERSE if s in st["quotes"]}
    if len(live_row) == len(S.UNIVERSE):
        px.loc[today] = pd.Series(live_row)
    px = px[~px.index.duplicated(keep="last")].sort_index()
    ind = S.indicators(px)
    t = len(px) - 1

    month = int(px.index[t].month)
    rot_w, diag = S.rotation_weights(ind, px, t)
    if st["last_month"] != month or not st["rot_w"]:
        st["rot_w"] = rot_w
        st["last_month"] = month
    mr_state = dict(st["mr_state"])
    if st["last_eval_date"] != str(today.date()):
        S.meanrev_step(ind, px, t, mr_state)  # advances holding clocks once per day
        st["mr_state"] = mr_state
    mr_w = {s: 1 / len(S.MEANREV) for s in st["mr_state"]}

    combined = {}
    for s, w in st["rot_w"].items():
        combined[s] = combined.get(s, 0) + w * S.P["sleeve_a"]
    for s, w in mr_w.items():
        combined[s] = combined.get(s, 0) + w * S.P["sleeve_b"]
    eq = equity(st)
    dd = eq / st["peak"] - 1
    target, scale, gov = S.governor(combined, ind, t, dd, st["dd_state"])

    st["signals"] = {
        "rotation": {s: {**diag[s], "picked": s in st["rot_w"], "desc": S.DESCRIPTIONS[s]} for s in S.ROTATION},
        "meanrev": {s: {"rsi2": float(ind["rsi2"][s].iloc[t]), "above200": bool(px[s].iloc[t] > ind["sma200"][s].iloc[t]),
                        "in_trade": s in st["mr_state"], "days": st["mr_state"].get(s)} for s in S.MEANREV},
        "asof": str(px.index[t].date()),
    }
    st["governor"] = {**gov, "scale": scale, "drawdown": dd, "target_vol": S.P["target_vol"]}
    st["target"] = target

    # trade to target (skip tiny rebalances, same 5% drift rule as the backtest)
    cur = {s: sh * st["quotes"][s]["price"] / eq for s, sh in st["positions"].items()}
    drift = sum(abs(target.get(s, 0) - cur.get(s, 0)) for s in set(target) | set(cur))
    n = 0
    if drift > 0.05 or not st["positions"]:
        # sells first to free cash
        for s in sorted(set(target) | set(cur), key=lambda s: target.get(s, 0) - cur.get(s, 0)):
            price = st["quotes"][s]["price"]
            want = int(target.get(s, 0) * eq / price)
            have = st["positions"].get(s, 0)
            d = want - have
            if d == 0:
                continue
            fill = price * (1 + SLIPPAGE if d > 0 else 1 - SLIPPAGE)
            if d > 0:
                d = min(d, int(st["cash"] / fill))
                if d <= 0:
                    continue
            st["cash"] -= d * fill
            st["positions"][s] = have + d
            if st["positions"][s] == 0:
                del st["positions"][s]
            st["trades"].append(dict(time=datetime.now(ET).isoformat(timespec="seconds"), sym=s,
                                     side="BUY" if d > 0 else "SELL", qty=abs(d), price=round(fill, 2),
                                     value=round(abs(d) * fill, 2), reason=reason,
                                     sleeve="MR" if s in st["mr_state"] and s not in st["rot_w"] else ("SAFE" if s == S.SAFE else "ROT")))
            n += 1
        st["trades"] = st["trades"][-500:]
    st["last_eval_date"] = str(today.date())
    log_event(st, f"Evaluated ({reason}): drift {drift:.1%}, {n} fills, risk scale {scale:.2f}")


def engine_loop():
    while True:
        try:
            q = live_quotes(S.UNIVERSE)  # network outside the lock so the dashboard never stalls
            with lock:
                st = load_state()
                if not st.get("paused"):
                    mark(st, q)
                    now = datetime.now(ET)
                    due = (market_status(now)["open"] and (now.hour, now.minute) >= EVAL_AT
                           and st["last_eval_date"] != str(now.date()))
                    if due or not st["positions"]:
                        evaluate(st, "daily close" if due else "initial allocation")
                    save_state(st)
        except Exception as e:
            traceback.print_exc()
            with lock:
                st = load_state(); log_event(st, f"Engine error: {e}"); save_state(st)
        time.sleep(60)


def public_state(st):
    """State plus the derived fields the dashboard reads."""
    st = dict(st)
    st["equity"] = equity(st) if st["quotes"] else START_CASH
    st["start_cash"] = START_CASH
    st["market"] = market_status()
    st["descriptions"] = S.DESCRIPTIONS
    st["params"] = S.P
    return st


def backtest_summary():
    p = os.path.join(DATA_DIR, "backtest.json")
    if os.path.exists(p):
        with open(p) as f:
            return json.load(f)
    return None


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=os.path.join(ROOT, "web"), **kw)

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # wall display always picks up new builds
        super().end_headers()

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        # /data/*.json mirrors the file layout of the static (GitHub Pages) build
        if self.path.startswith(("/api/state", "/data/state.json")):
            with lock:
                st = load_state()
            return self._json(public_state(st))
        if self.path.startswith(("/api/backtest", "/data/backtest.json")):
            return self._json(backtest_summary())
        return super().do_GET()

    def do_POST(self):
        action = self.path.rsplit("/", 1)[-1]
        with lock:
            st = load_state()
            if action == "pause":
                st["paused"] = True; log_event(st, "Engine paused by operator")
            elif action == "resume":
                st["paused"] = False; log_event(st, "Engine resumed by operator")
            elif action == "rebalance":
                try:
                    mark(st); evaluate(st, "manual")
                except Exception as e:
                    log_event(st, f"Manual evaluation failed: {e}")
            elif action == "reset":
                st = fresh_state(); log_event(st, "Paper account reset to $100,000")
            else:
                return self._json({"error": "unknown action"}, 404)
            save_state(st)
        return self._json({"ok": True, "message": st["message"]})


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(STATE_PATH):
        save_state(fresh_state())
    threading.Thread(target=engine_loop, daemon=True).start()
    print(f"AEGIS paper engine running  ->  http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
