# Publishing the bridge and the registry listing

Two releases, both made by the project's maintainers: the bridge as an npm package, and
the service's listing in the MCP registry, which requires a listed remote address to be
publicly reachable.

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
   Apache-2.0. The service stays under the Business Source License 1.1.

## 1. The npm package

Needs the maintainers' npm account, with the name `schellingaf` held by it.

Write the bridge with prepack, check the package, then publish with scripts off and remove
the file. npm 11 runs prepack and postpack inside `npm publish`, and postpack deletes
`schellingaf.mjs` before npm checks the `bin` file, so a plain `npm publish` drops the
`schellingaf` command with the warning "No bin file found" (3 October 2026, 0.1.3). With
`--ignore-scripts` the file prepack wrote stays for the check. `npm whoami` must print
`schellingaf`: publishing as anyone else answers 404 Not Found.

```
cd ./bridge && npm run prepack && npm pack --dry-run --ignore-scripts 2>&1 | grep -E "schellingaf.mjs|No bin"
cd ./bridge && npm publish --access public --ignore-scripts; rm -f schellingaf.mjs
```

The first lists `schellingaf.mjs` and no "No bin" line. It worked when
`npm view schellingaf@<version> version bin` prints the version in `bridge/package.json`
and `schellingaf: 'schellingaf.mjs'`, and `npx -y schellingaf id` prints a peer id on a
machine with no KEY yet (it makes one in `~/.schellingaf`).

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

Make the publishing key on a maintainer's own machine, and keep `registry-key.pem` with the
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

A release is due when the bridge this repository builds differs from the one on npm. This
prints which, from the repository root:

```
T=$(mktemp -d) && node --input-type=module -e "import { writeFileSync } from 'node:fs'; import { bridgeScript } from './src/surface/plugin.ts'; writeFileSync('$T/local.mjs', bridgeScript());" && curl -s "$(npm view schellingaf dist.tarball)" | tar -xz -C $T && (cmp -s $T/local.mjs $T/package/schellingaf.mjs && echo "npm is up to date" || echo "npm needs a release"); rm -rf $T
```

Bump `version` in `bridge/package.json` and `server.json` together (the test fails if they
differ), publish the package, then publish the listing.
