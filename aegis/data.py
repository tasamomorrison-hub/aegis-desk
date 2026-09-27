"""Market data: daily adjusted bars + live quotes from Yahoo's public chart API, cached to CSV."""
import json, os, time, urllib.request
import pandas as pd

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
UA = {"User-Agent": "Mozilla/5.0 (Macintosh) AEGIS/1.0"}


def _get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def fetch_daily(symbol, refresh=False):
    """Full daily history of dividend/split-adjusted closes."""
    path = os.path.join(DATA_DIR, f"{symbol}.csv")
    if not refresh and os.path.exists(path) and time.time() - os.path.getmtime(path) < 6 * 3600:
        return pd.read_csv(path, index_col=0, parse_dates=True)["close"]
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?period1=946684800&period2={int(time.time())}&interval=1d&events=div%2Csplit"
    res = _get(url)["chart"]["result"][0]
    idx = pd.to_datetime(res["timestamp"], unit="s").normalize()
    adj = res["indicators"]["adjclose"][0]["adjclose"]
    s = pd.Series(adj, index=idx, name="close").dropna()
    s = s[~s.index.duplicated(keep="last")]
    os.makedirs(DATA_DIR, exist_ok=True)
    s.to_frame().to_csv(path)
    return s


def load_universe(symbols, refresh=False):
    frames = {s: fetch_daily(s, refresh) for s in symbols}
    return pd.DataFrame(frames).dropna()


def live_quotes(symbols):
    """Latest trade price per symbol (regular or extended session)."""
    out = {}
    for s in symbols:
        try:
            meta = _get(f"https://query1.finance.yahoo.com/v8/finance/chart/{s}?range=1d&interval=1m")["chart"]["result"][0]["meta"]
            out[s] = {"price": meta["regularMarketPrice"], "prev": meta.get("chartPreviousClose") or meta.get("previousClose"),
                      "time": meta.get("regularMarketTime")}
        except Exception as e:  # keep going on a single bad symbol
            out[s] = {"error": str(e)}
    return out
