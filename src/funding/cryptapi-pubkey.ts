// The public key CryptAPI signs its callbacks with, as GET https://api.cryptapi.io/pubkey/
// answered on 8 October 2026. In live mode callbacks are checked with this key alone,
// whatever CRYPTAPI_PUBKEY_FILE says. A key CryptAPI changes is a change to this file.

export const CRYPTAPI_PUBKEY_PEM = [
  "-----BEGIN PUBLIC KEY-----",
  "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC3FT0Ym8b3myVxhQW7ESuuu6lo",
  "dGAsUJs4fq+Ey//jm27jQ7HHHDmP1YJO7XE7Jf/0DTEJgcw4EZhJFVwsk6d3+4fy",
  "Bsn0tKeyGMiaE6cVkX0cy6Y85o8zgc/CwZKc0uw6d5siAo++xl2zl+RGMXCELQVE",
  "ox7pp208zTvown577wIDAQAB",
  "-----END PUBLIC KEY-----",
].join("\n");
