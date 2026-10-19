#!/usr/bin/env bash
# Seed a "shop" demo database (tablemax_demo) into the test containers and a SQLite file,
# then register one TableMax connection per engine. Usage: demo-db.sh [--no-register]
# Re-running drops and recreates the demo data. Requires: docker, sqlite3, test-dbs.sh up.
set -euo pipefail

cd "$(dirname "$0")/.."
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/dev.tablemax.app"
SQLITE_FILE="$DATA_DIR/demo/shop.sqlite"
APP_DB="$DATA_DIR/app.db"
# Same overrides as scripts/test-dbs.sh.
PROJECT="${TABLEMAX_TEST_PROJECT:-tablemax-test}"
PG_PORT="${TABLEMAX_TEST_PG_PORT:-54321}"
MYSQL_PORT="${TABLEMAX_TEST_MYSQL_PORT:-33061}"
MARIADB_PORT="${TABLEMAX_TEST_MARIADB_PORT:-33062}"

bash scripts/test-dbs.sh up

echo "seeding postgres 16…"
docker exec "$PROJECT-pg16-1" psql -U postgres -q \
  -c "DROP DATABASE IF EXISTS tablemax_demo" -c "CREATE DATABASE tablemax_demo" 2>&1 | grep -v NOTICE || true
docker exec -i "$PROJECT-pg16-1" psql -U postgres -d tablemax_demo -q -v ON_ERROR_STOP=1 \
  < scripts/demo/postgres.sql

for svc in mysql8:mysql mariadb11:mariadb; do
  container="$PROJECT-${svc%%:*}-1"
  cli="${svc##*:}"
  echo "seeding ${svc%%:*}…"
  docker exec "$container" "$cli" -uroot -ptablemax \
    -e "DROP DATABASE IF EXISTS tablemax_demo; CREATE DATABASE tablemax_demo CHARACTER SET utf8mb4" \
    2>&1 | grep -v "Using a password" || true
  docker exec -i "$container" "$cli" --default-character-set=utf8mb4 -uroot -ptablemax tablemax_demo \
    < scripts/demo/mysql.sql 2>&1 | grep -v "Using a password" || true
done

echo "seeding sqlite → $SQLITE_FILE"
mkdir -p "$(dirname "$SQLITE_FILE")"
rm -f "$SQLITE_FILE"
sqlite3 -bail "$SQLITE_FILE" < scripts/demo/sqlite.sql

if [[ "${1:-}" == "--no-register" ]]; then
  exit 0
fi
if pgrep -x tablemax >/dev/null; then
  echo "TableMax is running: close it, then re-run to register the demo connections." >&2
  exit 1
fi
if [[ ! -f "$APP_DB" ]]; then
  echo "No $APP_DB yet: launch TableMax once, close it, then re-run." >&2
  exit 1
fi

# Passwords are never stored: the server connections use "ask" (password: tablemax).
conn() { # id name color env kind port user database sqlite_path password_mode
  local db sqlite
  db=$([[ -n "$8" ]] && echo "\"$8\"" || echo null)
  sqlite=$([[ -n "$9" ]] && echo "\"$9\"" || echo null)
  local host=$([[ "$5" == sqlite ]] && echo "" || echo 127.0.0.1)
  local json="{\"id\":\"$1\",\"name\":\"$2\",\"color\":\"$3\",\"envTag\":\"$4\",\"kind\":\"$5\",\"host\":\"$host\",\"port\":$6,\"user\":\"$7\",\"database\":$db,\"sqlitePath\":$sqlite,\"passwordMode\":\"${10}\",\"group\":\"Demo\"}"
  sqlite3 "$APP_DB" "INSERT OR REPLACE INTO connections (id, name, config_json) VALUES ('$1', '$2', '$json')"
}
conn demo-sqlite  "Demo · SQLite"      swatch-2 local   sqlite  0     ""       ""              "$SQLITE_FILE" none
conn demo-pg      "Demo · Postgres 16" swatch-1 dev     postgres "$PG_PORT" postgres tablemax_demo ""             ask
conn demo-mysql   "Demo · MySQL 8"     swatch-3 staging mySql   "$MYSQL_PORT" root     tablemax_demo   ""             ask
conn demo-mariadb "Demo · MariaDB 11"  swatch-5 prod    mariaDb "$MARIADB_PORT" root     tablemax_demo   ""             ask
echo "registered 4 demo connections (server password: tablemax)"
