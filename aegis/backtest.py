"""Walk-forward daily backtest. Signals on close of day t, filled at close of day t+1, with costs."""
import json, os, sys
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from aegis import strategy as S
from aegis.data import load_universe, DATA_DIR

COST = 0.0010   # 10 bps per unit traded (commission + slippage + spread), deliberately pessimistic
OOS_START = "2017-01-01"  # nothing after this date influenced any design choice


def run(px):
    ind = S.indicators(px)
    dates = px.index
    start = S.P["lookbacks"][-1] + 5
    rets = ind["rets"].fillna(0)
    equity, peak = 1.0, 1.0
    held = {S.SAFE: 1.0}
    pending = None
    mr_state, dd_state = {}, {"tripped": False}
    rot_w = {}
    last_month = None
    curve, trades, exposure = [], [], []
    for t in range(start, len(dates)):
        # 1) mark to market today's move on yesterday's holdings
        day_ret = sum(w * rets[s].iloc[t] for s, w in held.items())
        equity *= 1 + day_ret
        held = {s: w * (1 + rets[s].iloc[t]) / (1 + day_ret) for s, w in held.items()}
        # 2) fill orders decided yesterday at today's close
        if pending is not None:
            turnover = sum(abs(pending.get(s, 0) - held.get(s, 0)) for s in set(pending) | set(held))
            equity *= 1 - turnover * COST
            for s in set(pending) | set(held):
                d = pending.get(s, 0) - held.get(s, 0)
                if abs(d) > 0.01 and s != S.SAFE:
                    trades.append(dict(date=str(dates[t].date()), sym=s, side="BUY" if d > 0 else "SELL",
                                       weight=round(pending.get(s, 0), 4), delta=round(d, 4), price=round(float(px[s].iloc[t]), 2)))
            held = {s: w for s, w in pending.items() if w > 1e-6}
            pending = None
        peak = max(peak, equity)
        dd = equity / peak - 1
        curve.append((dates[t], equity, dd))
        exposure.append(1 - held.get(S.SAFE, 0))
        # 3) decide tomorrow's target
        m = dates[t].month
        if m != last_month:
            rot_w, _ = S.rotation_weights(ind, px, t)
            last_month = m
        mr_w = S.meanrev_step(ind, px, t, mr_state)
        combined = {}
        for s, w in rot_w.items():
            combined[s] = combined.get(s, 0) + w * S.P["sleeve_a"]
        for s, w in mr_w.items():
            combined[s] = combined.get(s, 0) + w * S.P["sleeve_b"]
        target, _, _ = S.governor(combined, ind, t, dd, dd_state)
        drift = sum(abs(target.get(s, 0) - held.get(s, 0)) for s in set(target) | set(held))
        if drift > 0.05:  # don't churn on tiny drifts
            pending = target
    eq = pd.DataFrame(curve, columns=["date", "equity", "dd"]).set_index("date")
    return eq, trades, float(np.mean(exposure))


def stats(eq_series):
    r = eq_series.pct_change().dropna()
    yrs = len(r) / 252
    cagr = eq_series.iloc[-1] ** (1 / yrs) - 1 if eq_series.iloc[0] == 1 else (eq_series.iloc[-1] / eq_series.iloc[0]) ** (1 / yrs) - 1
    vol = r.std() * np.sqrt(252)
    downside = r[r < 0].std() * np.sqrt(252)
    dd = (eq_series / eq_series.cummax() - 1).min()
    monthly = eq_series.resample("ME").last().pct_change().dropna()
    return dict(cagr=cagr, vol=vol, sharpe=r.mean() / r.std() * np.sqrt(252), sortino=r.mean() * 252 / downside,
                max_dd=dd, calmar=cagr / abs(dd) if dd else 0, pct_up_months=float((monthly > 0).mean()),
                best_year=None, worst_year=None)


def yearly(eq_series):
    y = eq_series.resample("YE").last()
    first = eq_series.iloc[0]
    y = pd.concat([pd.Series([first], index=[eq_series.index[0]]), y]).pct_change().dropna()
    return {str(d.year): float(v) for d, v in y.items()}


def main():
    px = load_universe(S.UNIVERSE, refresh="--refresh" in sys.argv)
    eq, trades, avg_exp = run(px)
    idx = eq.index
    spy = px["SPY"].reindex(idx); spy = spy / spy.iloc[0]
    r6040 = (0.6 * px["SPY"].pct_change() + 0.4 * px["IEF"].pct_change()).reindex(idx).fillna(0)
    b6040 = (1 + r6040).cumprod(); b6040 /= b6040.iloc[0]

    def block(sl):
        out = {}
        for name, s in (("AEGIS", eq["equity"]), ("SPY buy&hold", spy), ("60/40", b6040)):
            x = s.loc[sl]; x = x / x.iloc[0]
            st = stats(x); yr = yearly(x)
            st["best_year"], st["worst_year"] = max(yr.values()), min(yr.values())
            out[name] = {k: round(float(v), 4) for k, v in st.items()}
        return out

    report = {
        "period": [str(idx[0].date()), str(idx[-1].date())],
        "oos_start": OOS_START,
        "full": block(slice(None)),
        "in_sample": block(slice(None, OOS_START)),
        "out_of_sample": block(slice(OOS_START, None)),
        "yearly": {"AEGIS": yearly(eq["equity"]), "SPY": yearly(spy)},
        "avg_exposure": round(avg_exp, 3),
        "n_trades": len(trades),
        "trades_per_year": round(len(trades) / (len(idx) / 252), 1),
        "cost_bps": COST * 1e4,
    }
    weekly = eq.resample("W-FRI").last()
    spy_w = spy.resample("W-FRI").last()
    report["curve"] = [[str(d.date()), round(float(e), 4), round(float(dd), 4), round(float(spy_w.loc[d]), 4)]
                       for d, e, dd in weekly.itertuples()]
    report["trades"] = trades[-400:]
    with open(os.path.join(DATA_DIR, "backtest.json"), "w") as f:
        json.dump(report, f)
    for k in ("full", "in_sample", "out_of_sample"):
        print(f"\n== {k.upper()} ==")
        print(pd.DataFrame(report[k]).T[["cagr", "vol", "sharpe", "sortino", "max_dd", "calmar", "pct_up_months", "worst_year"]].to_string())
    print("\nperiod", report["period"], "| avg exposure", report["avg_exposure"], "| trades/yr", report["trades_per_year"])
    print("yearly AEGIS vs SPY:")
    for y in report["yearly"]["AEGIS"]:
        print(f"  {y}: {report['yearly']['AEGIS'][y]:+.1%}  vs {report['yearly']['SPY'].get(y, float('nan')):+.1%}")


if __name__ == "__main__":
    main()
