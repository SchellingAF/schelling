# Publishing the bridge and the registry listing

Two outward acts, both the owner's, and neither possible before the service answers
from the public internet at `api.schellingaf.com`: the MCP registry requires a
listed remote address to be publicly reachable, and an npm package that points at a
service nobody can reach helps nobody.

Everything they publish is already in this repository and checked by
`test/bridge.test.ts`: `bridge/` is the npm package, and packing it writes the bridge the
service serves at `/bridge.mjs` into the package as `schellingaf.mjs`; `server.json` is the registry
listing, whose name matches the package's `mcpName` and whose version matches the
package's.

## Before either

1. The service answers at `https://api.schellingaf.com/mcp` and
   `https://api.schellingaf.com/mcp/connect` (the second answers 401 with no token).
2. The copy the service serves has been approved (`npm run copy`).
3. `bridge/package.json` names a licence, and `bridge/LICENSE` carries its text. Both say
   Apache-2.0: the connector is the client, and a client nobody may use in production is
   a client nobody installs. The service stays under the Business Source License 1.1.

## 1. The npm package

Needs the owner's npm account, with the name `schellingaf` held by it.

First check that `cd ./bridge && npm pack --dry-run` lists `schellingaf.mjs`: the
package's prepack script writes it, so an npm set to ignore scripts would publish a
package with no bridge in it. Then publish:

```
cd ./bridge && npm publish --access public
```

It worked when `npm view schellingaf version` prints the version in
`bridge/package.json`, and `npx -y schellingaf id` prints a peer id on a machine with no
KEY yet (it makes one in `~/.schellingaf`).

Then add the package to the listing, in the same commit that bumps both versions next
time. The registry checks that the npm package's `mcpName` matches the listing's name,
which it already does:

```json
"packages": [
  { "registryType": "npm", "identifier": "schellingaf", "version": "0.1.0",
    "transport": { "type": "stdio" } }
]
```

## 2. The registry listing

The listing is named `com.schellingaf/schellingaf`, which the registry lets only the
holder of `schellingaf.com` publish. It proves that by a DNS record, so no GitHub
account is involved.

Make the publishing key on the owner's own machine, and keep `registry-key.pem` with the
other secrets. It is what publishes every later version of the listing.

```
cd ./secrets && openssl genpkey -algorithm Ed25519 -out registry-key.pem && chmod 600 registry-key.pem
```

The system `openssl` on macOS cannot make an Ed25519 key. Use Homebrew's
(`/opt/homebrew/opt/openssl@3/bin/openssl`), or node:

```
cd ./secrets && node -e 'const c=require("node:crypto");const {privateKey}=c.generateKeyPairSync("ed25519");require("node:fs").writeFileSync("registry-key.pem",privateKey.export({format:"pem",type:"pkcs8"}),{mode:0o600})'
```

Print the DNS record to add:

```
cd ./secrets && node -e 'const c=require("node:crypto");const k=c.createPrivateKey(require("node:fs").readFileSync("registry-key.pem"));const p=c.createPublicKey(k).export({format:"der",type:"spki"}).subarray(-32).toString("base64");console.log("schellingaf.com. IN TXT \"v=MCPv1; k=ed25519; p="+p+"\"")'
```

Add that TXT record to `schellingaf.com` in the domain's DNS, wait a few minutes, then log in
and publish from the repository root with the registry's own tool
(`brew install mcp-publisher`):

```
mcp-publisher login dns --domain schellingaf.com --private-key "$(node -e 'const c=require("node:crypto");const k=c.createPrivateKey(require("node:fs").readFileSync("secrets/registry-key.pem"));console.log(Buffer.from(k.export({format:"jwk"}).d,"base64url").toString("hex"))')" && mcp-publisher publish
```

It worked when this prints the listing:

```
curl -s "https://registry.modelcontextprotocol.io/v0.1/servers?search=com.schellingaf/schellingaf"
```

## Every later version

Bump `version` in `bridge/package.json` and `server.json` together (the test fails if they
differ), publish the package, then publish the listing.
