# AEGIS: autonomous systematic paper-trading desk

Real market prices, simulated money. A rules-based strategy that runs by itself, plus a 3D wall display.

## Run it

```bash
python3 -m venv .venv && .venv/bin/pip install pandas numpy   # first time only
.venv/bin/python aegis/backtest.py                            # rebuild history + stats (~1 min)
.venv/bin/python aegis/live.py                                # engine + dashboard
```

Open http://localhost:8787 and press **Wall mode** (or `W`) for fullscreen with the cinematic camera.
The engine marks the account to market every minute, evaluates the strategy once a day at 3:45 pm New York time, and trades toward the target at live prices (+5 bps slippage). State lives in `data/paper_state.json`. The **Evaluate now** button forces an evaluation, and `POST /api/reset` restores $100k.

## Hosted version (free: GitHub Actions + GitHub Pages)

No server and no Mac needed. `.github/workflows/aegis.yml` runs `aegis/cycle.py` every 15 minutes on weekdays
(9:00–17:00 New York time): it marks the paper account to market, runs the daily evaluation after 3:45 pm, commits
`state/` back to the repo, and redeploys the dashboard to GitHub Pages. The backtest refreshes every Friday evening.

**One-time setup**
1. Create a new **public** repository on github.com (empty, no README).
2. Push this folder to it.
3. Repo **Settings → Pages → Source: GitHub Actions**.
4. **Actions** tab → *AEGIS engine* → **Run workflow** once. Your site is at `https://<username>.github.io/<repo>/`.

**Controls.** The public page is view-only. The **⚙ Controls** button opens the workflow page, where *Run workflow* lets you
`evaluate`, `pause`, `resume`, `reset` or refresh the `backtest`. Only people with write access to the repo can do that.

**Good to know**
- GitHub's scheduler is best-effort. Runs can arrive 5–20 minutes late, and the dashboard shows how old its snapshot is.
  A late evaluation still trades at the live (or closing) price.
- Exchange holidays are detected automatically: no SPY print today means no evaluation.
- GitHub pauses scheduled workflows in repos with no activity for 60 days. The engine's own commits count as activity,
  but if it ever stops, re-enable it in the Actions tab.
- Yahoo's free feed can occasionally rate-limit GitHub's servers. A failed run just gets retried at the next slot, and GitHub emails you about failures.
- Everything in a public repo is public: code, paper trades, and commit history.

## The strategy

| Layer | Rule | Source idea |
|---|---|---|
| Momentum rotation (80%) | Monthly: rank SPY QQQ IWM EFA EEM TLT IEF GLD DBC VNQ by avg 1/3/6/12-month return. Hold the top 3 that are also above their 200-day average, inverse-volatility weighted. Empty slots go to SHY. | Faber (2007), Antonacci dual momentum, time-series momentum (Moskowitz, Ooi, Pedersen 2012) |
| Pullback reversion (20%) | Buy SPY/QQQ when RSI(2) < 10 and above the 200-day average. Exit on close > 5-day average or after 10 days. | Connors & Alvarez |
| Risk governor | Scale the risky book to ≤ 12% forecast volatility (never leveraged). Halve risk after a 15% drawdown until back within 8%. | Volatility targeting, standard at CTAs and risk-parity funds |

All parameters are textbook defaults, fixed before any backtest ran.

## Backtest (Feb 2007 → Sep 2026, 10 bps cost per trade)

| | CAGR | Vol | Sharpe | Max drawdown | 2008 |
|---|---|---|---|---|---|
| **AEGIS** | 6.7% | 10.1% | 0.70 | −18.7% | +9.9% |
| SPY buy & hold | 10.9% | 19.6% | 0.63 | −55.2% | −36.8% |
| 60/40 | 8.4% | 11.3% | 0.77 | −31.4% | — |

Out of sample (2017 onward), AEGIS had a Sharpe of 0.72 vs 0.88 for SPY and 0.91 for 60/40. **Its edge is crash protection, not beating a bull market.**

### Sensitivity check (run after the fact; *not* applied to the live engine)

| Variant | CAGR | Sharpe | Max DD | 2017+ Sharpe |
|---|---|---|---|---|
| Baseline | 6.7% | 0.70 | −18.7% | 0.72 |
| Rotation only | 7.4% | 0.71 | −21.0% | 0.79 |
| Mean-reversion only | 1.8% | 0.33 | −11.9% | 0.29 |
| No drawdown breaker | 7.5% | 0.73 | −19.7% | 0.83 |
| Vol target 16% | 8.1% | 0.76 | −16.8% | 0.86 |

The pullback sleeve contributes little, and the 12% vol cap is conservative. Changing parameters because of this table would be curve-fitting. The honest way to test a change is to paper-trade it side by side and judge it on data it has never seen.

## Files

- `aegis/strategy.py`: all decision logic, shared by backtest and live engine
- `aegis/backtest.py`: walk-forward simulator, writes `data/backtest.json`
- `aegis/live.py`: paper engine + HTTP API (`/api/state`, `/api/backtest`, `POST /api/{pause,resume,rebalance,reset}`)
- `aegis/data.py`: Yahoo Finance daily history + live quotes (unofficial, free, can break)
- `web/`: Three.js wall display

## Limits

- Paper only. No broker is connected, and nothing here places real orders.
- Yahoo's free feed is unofficial and may be delayed or rate-limited. Exchange holidays aren't modeled (the engine just sees flat prices).
- A backtest is one path through history. Expect live results to be worse than the backtest.
