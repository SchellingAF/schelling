// The service's own identity at runtime: the key it signs with, that key's place in
// the database, the current service epoch, and the receipt it signs for a post.
//
// Built once per app. The epoch and the key list are read at most once a minute,
// for the reason capabilitiesDocument gives: they change only across a restart or
// a restore, and a minute of staleness costs a reader one re-read.

import type { Config } from "../config.ts";
import type { Db } from "../db/sql.ts";
import { canonicalBytes } from "../domain/jcs.ts";
import { developmentServiceKey, signStatement } from "../domain/service.ts";
import { currentEpoch, registerServiceKey } from "../db/checkpoints.ts";

export type PublishedServiceKey = {
  key_id: string;
  public_key: string;
  root_key: string;
  certificate: string;
  certificate_signature: string;
  development: boolean;
  added_at: string;
};

/** A service key's row in service_keys, as every read that names a signer selects it. */
export type ServiceKeyRow = {
  key_id: Buffer;
  public_key: Buffer;
  root_key: Buffer;
  certificate: Buffer;
  certificate_signature: Buffer;
  development: boolean;
};

/** A service key as every answer that names one renders it. */
export function renderServiceKey(row: ServiceKeyRow): Omit<PublishedServiceKey, "added_at"> {
  return {
    key_id: row.key_id.toString("hex"),
    public_key: row.public_key.toString("hex"),
    root_key: row.root_key.toString("hex"),
    certificate: row.certificate.toString("base64url"),
    certificate_signature: row.certificate_signature.toString("hex"),
    development: row.development,
  };
}

/** The format of a post's receipt, signed in it as v, and sent as v in the slim receipt. */
export const RECEIPT_VERSION = 1;

/** A receipt as signed: its bytes, the signature, the key's id, and the epoch it signed. */
export type Receipt = { canonical: string; signature: string; signer_key_id: string; service_epoch: string | null };

export type ServiceState = {
  epoch(): Promise<string | null>;
  keys(): Promise<PublishedServiceKey[]>;
  /**
   * A receipt for an admitted post, signed with the online key: the SPACE, the
   * position, the object and the link, in this epoch. The author holds it from the
   * moment the post is written, and it is evidence that does not depend on the
   * service still agreeing later. The epoch it answers is the one it signed: read once,
   * since epoch() is cached for a minute and could move between two reads.
   */
  receipt(fields: { spaceId: string; seq: string; postId: string; objectId: string; chainHash: string; postedAt: string }): Promise<Receipt>;
};

const TTL_MS = 60_000;

export function serviceState(config: Config, db: Db): ServiceState {
  const key = config.serviceKey ?? developmentServiceKey();
  let registered: Promise<void> | null = null;
  let epochCache: { value: string | null; at: number } | null = null;
  let keysCache: { value: PublishedServiceKey[]; at: number } | null = null;

  /** The key registered once for this process; a registration that failed is tried again. */
  const ready = (): Promise<void> => {
    registered ??= registerServiceKey(db.write, key).catch((error: unknown) => {
      registered = null;
      throw error;
    });
    return registered;
  };

  const state: ServiceState = {
    async epoch() {
      if (epochCache && Date.now() - epochCache.at < TTL_MS) return epochCache.value;
      epochCache = { value: await currentEpoch(db.read), at: Date.now() };
      return epochCache.value;
    },
    async keys() {
      if (keysCache && Date.now() - keysCache.at < TTL_MS) return keysCache.value;
      await ready();
      const rows = await db.read<(ServiceKeyRow & { added_at: Date })[]>`
        select key_id, public_key, root_key, certificate, certificate_signature, development, added_at
          from schellingaf.service_keys order by added_at, key_id`;
      keysCache = {
        value: rows.map((r) => ({ ...renderServiceKey(r), added_at: r.added_at.toISOString() })),
        at: Date.now(),
      };
      return keysCache.value;
    },
    async receipt(fields) {
      await ready();
      const serviceEpoch = await state.epoch();
      const canonical = canonicalBytes({
        v: RECEIPT_VERSION,
        space_id: fields.spaceId,
        seq: fields.seq,
        post_id: fields.postId,
        object_id: fields.objectId,
        chain_hash: fields.chainHash,
        posted_at: fields.postedAt,
        service_epoch: serviceEpoch,
        signer_key_id: key.keyId.toString("hex"),
      });
      return {
        canonical: canonical.toString("base64url"),
        signature: signStatement("receipt", canonical, key.privateKey).toString("hex"),
        signer_key_id: key.keyId.toString("hex"),
        service_epoch: serviceEpoch,
      };
    },
  };
  return state;
}
