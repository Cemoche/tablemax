#!/usr/bin/env bash
# Tests scripts/github-bootstrap.sh against a fake `gh` that keeps the repository state in
# files: a dry run writes nothing, a first run creates everything, a second run creates
# nothing. Never talks to GitHub. Usage: bash scripts/test-github-bootstrap.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
failures=0
ok() { echo "ok   - $1"; }
fail() { echo "FAIL - $1"; failures=$((failures + 1)); }

export FAKE_GH_STATE="$TMP/state"
mkdir -p "$FAKE_GH_STATE" "$TMP/bin"
: >"$FAKE_GH_STATE/issues"; : >"$FAKE_GH_STATE/milestones"; : >"$FAKE_GH_STATE/writes"
echo "good first issue" >"$FAKE_GH_STATE/labels" # GitHub creates it with every repo

cat >"$TMP/bin/gh" <<'EOF'
#!/usr/bin/env bash
# Fake gh: answers the calls github-bootstrap.sh makes; anything else is recorded and fails.
S="$FAKE_GH_STATE"
case "$1 $2" in
  "label list") cat "$S/labels" ;;
  "issue list") cat "$S/issues" ;;
  "api --paginate") cat "$S/milestones" ;;
  "label create")
    echo "$3" >>"$S/labels"
    echo "label|$3" >>"$S/writes" ;;
  "api -X")
    for a in "$@"; do [[ $a == title=* ]] && t="${a#title=}"; done
    echo "$t" >>"$S/milestones"
    echo "milestone|$t" >>"$S/writes" ;;
  "issue create")
    [[ -z ${FAKE_GH_FAIL_CREATE:-} ]] || { echo "HTTP 422: could not add label" >&2; exit 1; }
    shift 2
    title="" milestone="" assignee="" labels=()
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --title) title="$2"; shift ;;
        --milestone) milestone="$2"; shift ;;
        --assignee) assignee="$2"; shift ;;
        --label) labels+=("$2"); shift ;;
        --body-file) [[ $2 == - ]] || { echo "bad body-file" >&2; exit 1; }; shift ;;
      esac
      shift
    done
    body="$(cat)"
    [[ -n $body ]] || { echo "empty body for $title" >>"$S/unexpected"; exit 1; }
    echo "$title" >>"$S/issues"
    joined="$(IFS=','; echo "${labels[*]}")"
    echo "issue|$title|$joined|$milestone|$assignee" >>"$S/writes"
    echo "https://github.com/o/r/issues/$(wc -l <"$S/issues")" ;;
  "auth status") echo "" ;;
  *) echo "$*" >>"$S/unexpected"; exit 1 ;;
esac
EOF
chmod +x "$TMP/bin/gh"
run() { PATH="$TMP/bin:$PATH" bash "$ROOT/scripts/github-bootstrap.sh" "$@" >"$TMP/out" 2>&1; code=$?; }
writes() { grep -c "^$1|" "$FAKE_GH_STATE/writes"; }

# 1. dry run
run --dry-run
if [[ $code -eq 0 && ! -s $FAKE_GH_STATE/writes ]] && grep -q "would create issue" "$TMP/out"; then
  ok "dry run lists the work and writes nothing"
else fail "dry run (code=$code, writes: $(wc -l <"$FAKE_GH_STATE/writes"))"; cat "$TMP/out"; fi

# 2. first run
run
labels="$(writes label)"; milestones="$(writes milestone)"; issues="$(writes issue)"
if [[ $code -eq 0 && $labels -eq 21 && $milestones -eq 4 && $issues -eq 34 ]]; then
  ok "first run creates 21 labels, 4 milestones, 34 issues"
else fail "first run (code=$code labels=$labels milestones=$milestones issues=$issues)"; tail -5 "$TMP/out"; fi

if grep -q '^label|good first issue$' "$FAKE_GH_STATE/writes"; then fail "existing label re-created"
else ok "an existing label is not re-created"; fi

if grep -Fq 'issue|[Epic] Plan 3 — Data|type:epic,plan:3,status:in-progress,area:frontend,area:backend|Plan 3 — Data|Cemoche' "$FAKE_GH_STATE/writes" \
  && grep -Fq 'issue|SSH config parsing edge cases|type:task,status:ready,good first issue,size:S,area:backend||' "$FAKE_GH_STATE/writes"; then
  ok "issues carry their labels (with spaces), milestone and assignee"
else fail "issue arguments"; grep '^issue|' "$FAKE_GH_STATE/writes" | head -3; fi

# 3. second run
: >"$FAKE_GH_STATE/writes"
run
if [[ $code -eq 0 && ! -s $FAKE_GH_STATE/writes ]] && grep -q "0 item(s) created" "$TMP/out"; then
  ok "second run creates nothing"
else fail "second run (code=$code, writes: $(wc -l <"$FAKE_GH_STATE/writes"))"; fi

# 4. a failing issue creation stops the run instead of being reported as created
: >"$FAKE_GH_STATE/issues"
FAKE_GH_FAIL_CREATE=1 run
if [[ $code -ne 0 ]] && ! grep -q "created issue" "$TMP/out"; then
  ok "a failed issue creation stops the run"
else fail "failed creation (code=$code)"; grep "created issue" "$TMP/out" | head -2; fi

if [[ -s $FAKE_GH_STATE/unexpected ]]; then
  fail "unexpected gh calls:"; cat "$FAKE_GH_STATE/unexpected"
else ok "no unexpected gh call"; fi

echo
if [[ $failures -gt 0 ]]; then echo "$failures bootstrap test(s) failed"; exit 1; fi
echo "all bootstrap tests passed"
