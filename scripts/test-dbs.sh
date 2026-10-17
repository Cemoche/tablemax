#!/usr/bin/env bash
# Manage the test databases and the test sshd. Usage: test-dbs.sh up|down|env
# To add a DB version: one service in docker-compose.test.yml + one URL below.
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE=(docker compose -f docker-compose.test.yml)

PG_URLS="postgres://postgres:tablemax@127.0.0.1:54321/tablemax_test"
MYSQL_URLS="mysql://root:tablemax@127.0.0.1:33061/tablemax_test,mysql://root:tablemax@127.0.0.1:33062/tablemax_test"

case "${1:-}" in
  up)
    bash scripts/test-secrets.sh
    "${COMPOSE[@]}" up -d --wait --build
    # Client-certificate login role (see tests/docker/pg-ssl.sh); idempotent.
    "${COMPOSE[@]}" exec -T pg16 psql -q -U postgres -d postgres -c \
      "DO \$\$ BEGIN CREATE ROLE certuser LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END \$\$"
    ;;
  down)
    "${COMPOSE[@]}" down -v
    ;;
  env)
    echo "export TABLEMAX_TEST_PG_URLS=${PG_URLS}"
    echo "export TABLEMAX_TEST_MYSQL_URLS=${MYSQL_URLS}"
    echo "export TABLEMAX_TEST_TLS_DIR=$(pwd)/.test-secrets/tls"
    echo "export TABLEMAX_TEST_SSH=127.0.0.1:2222"
    echo "export TABLEMAX_TEST_SSH_DIR=$(pwd)/.test-secrets/ssh"
    ;;
  *)
    echo "usage: $0 up|down|env" >&2
    exit 2
    ;;
esac
