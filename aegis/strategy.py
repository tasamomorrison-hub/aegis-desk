"""AEGIS target-weight logic. Every parameter is a textbook default, chosen before looking at results.

Sleeve A  Dual momentum rotation (Antonacci / Faber): monthly, rank by blended 1/3/6/12m return,
          hold top 3 with positive momentum AND price > 200d SMA, inverse-vol weighted.
Sleeve B  RSI(2) mean reversion (Connors): buy SPY/QQQ when RSI2 < 10 above 200d SMA,
          exit on close > 5d SMA or after 10 days.
Governor  Scale risky exposure to 12% annualised portfolio vol (never levered); halve risk in a
          >15% drawdown until it recovers to <8%. Unused capital parks in SHY.
"""
import numpy as np
import pandas as pd

ROTATION = ["SPY", "QQQ", "IWM", "EFA", "EEM", "TLT", "IEF", "GLD", "DBC", "VNQ"]
MEANREV = ["SPY", "QQQ"]
SAFE = "SHY"
UNIVERSE = sorted(set(ROTATION + MEANREV + [SAFE]))

P = dict(top_n=3, lookbacks=(21, 63, 126, 252), sma_long=200, vol_win=63,
         sleeve_a=0.80, sleeve_b=0.20, rsi_entry=10, sma_exit=5, max_hold=10,
         target_vol=0.12, dd_trip=0.15, dd_reset=0.08, dd_cut=0.5)

DESCRIPTIONS = {
    "SPY": "US large cap", "QQQ": "Nasdaq 100", "IWM": "US small cap", "EFA": "Intl developed",
    "EEM": "Emerging mkts", "TLT": "20y Treasury", "IEF": "7-10y Treasury", "GLD": "Gold",
    "DBC": "Commodities", "VNQ": "Real estate", "SHY": "1-3y Treasury (safe)",
}


def rsi(series, n=2):
    d = series.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return 100 - 100 / (1 + up / dn.replace(0, np.nan))


def indicators(px):
    rets = px.pct_change()
    mom = sum(px / px.shift(lb) - 1 for lb in P["lookbacks"]) / len(P["lookbacks"])
    return dict(
        rets=rets,
        mom=mom,
        sma200=px.rolling(P["sma_long"]).mean(),
        sma5=px.rolling(P["sma_exit"]).mean(),
        vol=rets.rolling(P["vol_win"]).std() * np.sqrt(252),
        rsi2=px.apply(rsi),
    )


def rotation_weights(ind, px, t):
    """Sleeve A picks on day index t. Returns (weights dict, per-asset diagnostics)."""
    mom, sma, vol = ind["mom"].iloc[t], ind["sma200"].iloc[t], ind["vol"].iloc[t]
    diag = {}
    for s in ROTATION:
        diag[s] = dict(mom=float(mom[s]), trend=bool(px[s].iloc[t] > sma[s]), vol=float(vol[s]))
    eligible = [s for s in ROTATION if mom[s] > 0 and px[s].iloc[t] > sma[s]]
    picks = sorted(eligible, key=lambda s: mom[s], reverse=True)[: P["top_n"]]
    w = {}
    if picks:
        inv = {s: 1 / max(vol[s], 1e-4) for s in picks}
        tot = sum(inv.values())
        slot_share = len(picks) / P["top_n"]  # empty slots go to safety
        for s in picks:
            w[s] = inv[s] / tot * slot_share
    return w, diag


def meanrev_step(ind, px, t, state):
    """Sleeve B: updates state {sym: days_held} in place, returns weights within sleeve."""
    for s in MEANREV:
        p = px[s].iloc[t]
        if s in state:
            state[s] += 1
            if p > ind["sma5"][s].iloc[t] or state[s] >= P["max_hold"]:
                del state[s]
        elif ind["rsi2"][s].iloc[t] < P["rsi_entry"] and p > ind["sma200"][s].iloc[t]:
            state[s] = 0
    return {s: 1 / len(MEANREV) for s in state}


def governor(weights, ind, t, drawdown, dd_state):
    """Vol-target the risky book and apply the drawdown breaker. Returns (weights, scale, info)."""
    risky = {s: w for s, w in weights.items() if s != SAFE and w > 0}
    scale = 1.0
    port_vol = 0.0
    if risky:
        names = list(risky)
        r = ind["rets"][names].iloc[max(0, t - P["vol_win"]):t + 1]
        cov = r.cov().values * 252
        wv = np.array([risky[n] for n in names])
        port_vol = float(np.sqrt(max(wv @ cov @ wv, 0)))
        if port_vol > P["target_vol"]:
            scale = P["target_vol"] / port_vol
    if drawdown <= -P["dd_trip"]:
        dd_state["tripped"] = True
    elif drawdown > -P["dd_reset"]:
        dd_state["tripped"] = False
    if dd_state["tripped"]:
        scale *= P["dd_cut"]
    out = {s: w * scale for s, w in risky.items()}
    out[SAFE] = max(0.0, 1 - sum(out.values()))
    return out, scale, dict(port_vol=port_vol, breaker=dd_state["tripped"])
