-- stream-signup schema
CREATE TABLE IF NOT EXISTS players (
  email        TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  rating       REAL NOT NULL DEFAULT 1500,
  rd           REAL NOT NULL DEFAULT 350,
  volatility   REAL NOT NULL DEFAULT 0.06,
  games        INTEGER NOT NULL DEFAULT 0,
  wins         INTEGER NOT NULL DEFAULT 0,
  kills        INTEGER NOT NULL DEFAULT 0,
  last_played  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tokens (
  token    TEXT PRIMARY KEY,
  email    TEXT NOT NULL,
  purpose  TEXT NOT NULL, -- 'signup'
  expires  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_players_rating ON players(rating DESC);
-- screen names are unique ignoring case. On a database that predates this
-- index, de-duplicate first (SELECT lower(name), count(*) FROM players GROUP BY 1
-- HAVING count(*) > 1), otherwise the CREATE fails.
CREATE UNIQUE INDEX IF NOT EXISTS idx_players_name_ci ON players(lower(name));
