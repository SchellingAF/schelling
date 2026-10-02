#!/usr/bin/env bash
# A second signer for test/fixtures/object-vectors.json, sharing no code with
# this repository: OpenSSL 3 does the SHA-256 and the Ed25519, and Python's own
# json module writes the canonical bytes. If this agrees with src/domain, two
# implementations written apart agree.
#
#   scripts/second-signer.sh                     # exit 0: agrees; 1: differs; 77: cannot run here
#   OPENSSL=/opt/homebrew/opt/openssl@3/bin/openssl scripts/second-signer.sh
#
# macOS ships LibreSSL as `openssl`, which has no Ed25519. Homebrew's openssl@3 does.
set -euo pipefail
cd "$(dirname "$0")/.."
VECTORS="${1:-test/fixtures/object-vectors.json}"
OPENSSL="${OPENSSL:-openssl}"
if ! "$OPENSSL" version 2>/dev/null | grep -q '^OpenSSL 3'; then
  for candidate in /opt/homebrew/opt/openssl@3/bin/openssl /usr/local/opt/openssl@3/bin/openssl; do
    if [ -x "$candidate" ] && "$candidate" version | grep -q '^OpenSSL 3'; then OPENSSL="$candidate"; break; fi
  done
fi
if ! "$OPENSSL" version 2>/dev/null | grep -q '^OpenSSL 3'; then
  echo "skip: needs OpenSSL 3; $OPENSSL is $("$OPENSSL" version 2>/dev/null || echo missing)" >&2
  exit 77
fi
command -v python3 >/dev/null || { echo "skip: needs python3" >&2; exit 77; }

python3 - "$VECTORS" "$OPENSSL" <<'PY'
import base64, json, struct, subprocess, sys, tempfile, uuid

vectors = json.load(open(sys.argv[1], encoding="utf-8"))
openssl = sys.argv[2]
NUL = bytes([0])
failures = []

def sha256(data):
    return subprocess.run([openssl, "dgst", "-sha256", "-binary"], input=data, capture_output=True, check=True).stdout

def labelled(label, *parts):
    return sha256(label.encode("utf-8") + NUL + b"".join(parts))

def canonical(value):
    # Python's json writes RFC 8785 for these vectors: integers, strings and
    # ASCII member names only, which is where the two writers agree exactly.
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")

def check(name, got, want):
    if got != want:
        failures.append(f"{name}: got {got} want {want}")
    else:
        print(f"ok  {name}")

obj = vectors["object"]
space = uuid.UUID(vectors["space_id"]).bytes

check("canonical bytes", canonical(json.loads(obj["canonical_utf8"])).decode(), obj["canonical_utf8"])
check("private bytes", canonical(json.loads(obj["private_utf8"])).decode(), obj["private_utf8"])
digest = labelled("agent-state:object-private:v1", obj["private_utf8"].encode("utf-8")).hex()
check("private_digest", digest, obj["private_digest"])
check("private_digest inside the object", json.loads(obj["canonical_utf8"])["private_digest"], digest)
object_id = labelled("agent-state:object:v1", obj["canonical_utf8"].encode("utf-8"))
check("object_id", object_id.hex(), obj["object_id"])
preimage = "agent-state:object-signature:v1".encode("utf-8") + NUL + object_id
check("signature preimage", preimage.hex(), obj["signature_preimage_hex"])
check("passkey challenge", sha256(preimage).hex(), obj["passkey_challenge_hex"])

seed = bytes.fromhex(json.load(open("test/fixtures/protocol-v1-vectors.json"))["test_private_seed_hex"])
der = bytes.fromhex("302e020100300506032b657004220420") + seed
pem = "-----BEGIN PRIVATE KEY-----\n" + base64.b64encode(der).decode() + "\n-----END PRIVATE KEY-----\n"
with tempfile.NamedTemporaryFile("w", suffix=".pem") as key, tempfile.NamedTemporaryFile("wb", suffix=".bin") as msg:
    key.write(pem); key.flush()
    msg.write(preimage); msg.flush()
    signature = subprocess.run([openssl, "pkeyutl", "-sign", "-inkey", key.name, "-rawin", "-in", msg.name],
                               capture_output=True, check=True).stdout
check("ed25519 signature", signature.hex(), obj["ed25519_signature_hex"])

control = vectors["control"]
command = labelled("agent-state:control:v1", control["canonical_utf8"].encode("utf-8"))
check("command_id", command.hex(), control["command_id"])
genesis = labelled("agent-state:control-genesis:v1", space)
check("control genesis", genesis.hex(), control["genesis_hash"])
control_link = labelled("agent-state:control-chain:v1", space, struct.pack(">q", 1), genesis, command)
check("control link", control_link.hex(), control["chain_hash"])

chain = vectors["chain"]
admission = labelled("agent-state:object-admission:v1", struct.pack(">q", 1), control_link)
check("admission", admission.hex(), chain["admission"])
object_genesis = labelled("agent-state:object-genesis:v1", space)
check("object genesis", object_genesis.hex(), chain["genesis_hash"])
link = labelled("agent-state:object-chain:v1", space, struct.pack(">q", 1), admission, object_genesis, object_id)
check("object link", link.hex(), chain["chain_hash"])
leaf = sha256(NUL + "agent-state:checkpoint-object:v1".encode("utf-8") + NUL + space + struct.pack(">q", 1) + object_id + link)
check("checkpoint leaf", leaf.hex(), vectors["checkpoint_leaf"])
check("one-leaf root", leaf.hex(), vectors["merkle_root_one_leaf"])

if failures:
    print("\n".join(failures), file=sys.stderr)
    sys.exit(1)
print("second signer agrees")
PY
