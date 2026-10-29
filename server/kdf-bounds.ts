// #675: the band a client may install as a vault's Argon2 params. Rule 7: the
// default (libsodium MODERATE, 3 ops / 256 MiB) travels with the vault and is
// never changed here; a stored pair outside the band keeps working, this only
// bounds what a write may change to.
const OPS_MIN = 1;
const OPS_MAX = 10;
const MEM_MIN = 8 * 1024 * 1024;
const MEM_MAX = 1024 * 1024 * 1024;

// True for a write the server must refuse: a change outside the band. Re-sending
// the vault's own stored pair is always allowed (a change-passphrase rekey does).
export function paramsOutOfBand(
  stored: { ops: number | null; mem: number | null },
  ops: number,
  mem: number,
): boolean {
  if (stored.ops === ops && stored.mem === mem) return false;
  return !Number.isInteger(ops) || !Number.isInteger(mem) ||
    ops < OPS_MIN || ops > OPS_MAX || mem < MEM_MIN || mem > MEM_MAX;
}
