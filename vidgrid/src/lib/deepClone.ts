import { produce } from "immer";

/**
 * Deep-clones an Immer proxy (or plain object) into a new plain object.
 *
 * `JSON.parse(JSON.stringify(value))` was previously used as a workaround
 * because `structuredClone` cannot copy Immer proxies.  That approach has
 * two problems:
 *  1. Non-JSON types (Date, Blob, Map, Set) are silently corrupted.
 *  2. It's a code smell that signals "I don't trust my data shape".
 *
 * `immer.produce` with an identity recipe walks the proxy and returns a
 * hard-copy plain object — safe for any serializable data shape.
 *
 * @param value - An Immer draft/proxy or a plain object.
 * @returns A deep-cloned plain object.
 */
export function deepClone<T>(value: T): T {
  return produce(value, () => {});
}
