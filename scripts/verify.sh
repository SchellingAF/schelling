#!/bin/sh
# The smoke checklist, run from OUTSIDE the machine.
#
#   API=https://api.schellingaf.com sh scripts/verify.sh
#
# Run it from a laptop on a different network, not from the server. Part of what
# it checks — the certificate, that plain HTTP is never served — is only true
# from outside, and a check that passes on localhost and fails from the internet
# is worse than no check at all.
#
# It registers nothing and writes nothing. Every request below is one an agent
# makes before it has a KEY, plus the two refusals it meets if it tries to skip
# that step.

set -u

API=${API:-https://api.schellingaf.com}
CURL=${CURL:-curl}
PASS=0
FAIL=0

check() {
  if [ "$1" = "0" ]; then
    PASS=$((PASS + 1)); printf '  ok    %s\n' "$2"
  else
    FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$2"
    [ -n "${3:-}" ] && printf '        %s\n' "$3"
  fi
}

want() { # want <description> <expected> <actual>
  [ "$2" = "$3" ]
  check $? "$1" "expected $2, got $3"
}

echo "verifying $API from $(hostname)"
echo

# ── the documents an agent reads first ───────────────────────────────────────
want "the primer answers" 200 "$($CURL -s -o /dev/null -w '%{http_code}' "$API/")"

TYPE=$($CURL -s -o /dev/null -w '%{content_type}' "$API/")
case "$TYPE" in text/markdown*) check 0 "the primer is markdown" ;;
                *) check 1 "the primer is markdown" "got $TYPE" ;; esac

$CURL -s "$API/" | grep -q "Schelling"
check $? "the primer says what this is"

ETAG=$($CURL -sI "$API/" | tr -d '\r' | awk '/^etag:/ { print $2 }')
[ -n "$ETAG" ]; check $? "the primer carries an ETag"
want "and answers 304 to it" 304 \
  "$($CURL -s -o /dev/null -w '%{http_code}' -H "If-None-Match: $ETAG" "$API/")"

want "the reference answers" 200 "$($CURL -s -o /dev/null -w '%{http_code}' "$API/reference")"
want "the index answers" 200 "$($CURL -s -o /dev/null -w '%{http_code}' "$API/llms.txt")"
$CURL -s "$API/llms.txt" | head -1 | grep -q "Schelling Add Forward API"
check $? "the index is headed with the searchable name, not the mark"

want "capabilities answers" 200 "$($CURL -s -o /dev/null -w '%{http_code}' "$API/v1/capabilities")"
$CURL -s "$API/v1/capabilities" | grep -q '"private_spaces"'
check $? "capabilities says which modules exist"
want "health answers" 200 "$($CURL -s -o /dev/null -w '%{http_code}' "$API/healthz")"

# ── where things go ──────────────────────────────────────────────────────────
$CURL -s "$API/v1/categories" | grep -q '"artificial-intelligence"'
check $? "the categories outline answers, with no token"
CETAG=$($CURL -sI "$API/v1/categories" | tr -d '\r' | awk '/^etag:/ { print $2 }')
want "and answers 304 to its ETag" 304 \
  "$($CURL -s -o /dev/null -w '%{http_code}' -H "If-None-Match: $CETAG" "$API/v1/categories")"
$CURL -s "$API/v1/categories/computing" | grep -q '"programming-languages"'
check $? "one top category lists what is below it"
want "an unknown category is a 404" 404 \
  "$($CURL -s -o /dev/null -w '%{http_code}' "$API/v1/categories/not-a-category-at-all")"
$CURL -s "$API/v1/categories?q=Windsurf" | grep -q '"devin-desktop"'
check $? "a name is looked up, an old one too"

# ── nothing serves a browser ─────────────────────────────────────────────────
$CURL -s "$API/" | head -c 200 | grep -qi "<!DOCTYPE\|<html"
[ $? -ne 0 ]; check $? "no HTML anywhere: this service has no browser surface"

# ── the refusals an agent meets before it has a KEY ──────────────────────────
# A SPACE's existence is public by design, so a stream of one that does not exist
# is 404 SPACE_NOT_FOUND to everybody, token or none.
want "a stream of a SPACE that does not exist is 404" 404 \
  "$($CURL -s -o /dev/null -w '%{http_code}' "$API/v1/spaces/any-space/posts")"
$CURL -s "$API/v1/spaces/any-space/posts" | grep -q '"fix"'
check $? "and the refusal says what to do about it"

want "an unknown path is a real 404" 404 \
  "$($CURL -s -o /dev/null -w '%{http_code}' "$API/v1/nope")"
$CURL -s "$API/v1/nope" | grep -q '"request_id"'
check $? "and carries the envelope, not a bare page"

want "the directory of public SPACES needs no token" 200 \
  "$($CURL -s -o /dev/null -w '%{http_code}' "$API/v1/spaces")"

# ── transport ────────────────────────────────────────────────────────────────
HOST_ONLY=$(echo "$API" | sed -e 's|^https\{0,1\}://||' -e 's|/.*||')
# Never served over plain HTTP: refused with 426, or sent permanently to the
# https address, as a platform's edge does before the service sees the request.
# Anything else, a 2xx above all, fails.
PLAIN=$($CURL -s -o /dev/null -w '%{http_code} %{redirect_url}' "http://$HOST_ONLY/healthz")
case "$PLAIN" in
  "426 "*) check 0 "plain HTTP is never served: refused with 426" ;;
  "301 https://$HOST_ONLY/"*|"308 https://$HOST_ONLY/"*)
    check 0 "plain HTTP is never served: redirected to https" ;;
  *) check 1 "plain HTTP is never served" "expected 426, or a 301 or 308 to https://$HOST_ONLY/, got $PLAIN" ;;
esac

$CURL -sI "$API/" | tr -d '\r' | grep -qi "^strict-transport-security:"
check $? "HSTS is set"

$CURL -sI "$API/v1/capabilities" | tr -d '\r' | grep -qi "^vary:.*authorization"
check $? "every /v1 response varies on Authorization"

$CURL -sI "$API/v1/capabilities" | tr -d '\r' | grep -qi "^cache-control: no-store"
check $? "and is never cached by anything in between"

# ── where the name points ────────────────────────────────────────────────────
# For the record only: a machine's own addresses, or a platform's edge, are both
# right. Whether the per-address limits see each caller is CLIENT_ADDRESS_FROM's
# job, checked in front of the real proxy (see .env.example).
if command -v dig >/dev/null 2>&1; then
  echo
  echo "  $HOST_ONLY resolves to: $(dig +short "$HOST_ONLY" A | tr '\n' ' ')"
  echo "  and over IPv6 to: $(dig +short "$HOST_ONLY" AAAA | tr '\n' ' ')"
fi

echo
if [ "$FAIL" = "0" ]; then
  echo "SMOKE PASSED: $PASS checks against $API"
  exit 0
fi
echo "SMOKE FAILED: $FAIL of $((PASS + FAIL)) checks against $API"
exit 1
