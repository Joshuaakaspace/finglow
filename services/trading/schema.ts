export const TRADING_SCHEMA = `
CREATE TABLE IF NOT EXISTS instruments (
  symbol TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  delisted_at INTEGER
);

CREATE TABLE IF NOT EXISTS price_bars (
  symbol TEXT NOT NULL,
  ts INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL,
  PRIMARY KEY (symbol, ts)
);

CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  base_currency TEXT NOT NULL DEFAULT 'USD'
);
CREATE INDEX IF NOT EXISTS books_project ON books(project_id);

CREATE TABLE IF NOT EXISTS positions (
  book_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  quantity REAL NOT NULL,
  avg_price REAL NOT NULL,
  PRIMARY KEY (book_id, symbol)
);

CREATE TABLE IF NOT EXISTS custodian_positions (
  book_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  quantity REAL NOT NULL,
  as_of INTEGER NOT NULL,
  PRIMARY KEY (book_id, symbol)
);

CREATE TABLE IF NOT EXISTS risk_limits (
  book_id TEXT PRIMARY KEY,
  max_gross_exposure REAL NOT NULL,
  max_position_pct REAL NOT NULL,
  max_symbols INTEGER NOT NULL
);
`;
