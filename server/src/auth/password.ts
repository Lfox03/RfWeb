// Password hashing — scrypt (node:crypto), memory-hard KDF.
//
// Why not Argon2id: it would add another native dependency
// (argon2 via node-gyp); scrypt is just as suitable (memory-hard, standard)
// and available in the Node standard library. The storage format
// includes the algorithm and parameters to allow a later transparent
// migration:
//
//   scrypt$N$r$p$<salt base64>$<hash base64>
//
// Hashes not starting with « scrypt$ » (the Phase 2 placeholder,
// prefixed with « ! ») are refused at verification — never by a login.

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const ALGORITHM = "scrypt";
const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        scrypt(password, salt, KEY_LENGTH, { N, r: R, p: P }, (err, derived) => {
            if (err) reject(err);
            else resolve(derived);
        });
    });
}

export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(SALT_LENGTH);
    const hash = await scryptAsync(password, salt);
    return [ALGORITHM, N, R, P, salt.toString("base64"), hash.toString("base64")].join("$");
}

// Returns false for any unreadable or legacy (placeholder) hash: verification
// must never throw on stored data.
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== ALGORITHM) return false;
    const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
    try {
        const salt = Buffer.from(saltB64, "base64");
        const expected = Buffer.from(hashB64, "base64");
        if (salt.length === 0 || expected.length !== KEY_LENGTH) return false;
        if (Number(nStr) !== N || Number(rStr) !== R || Number(pStr) !== P) {
            // Parameters different from today's: unsupported (honestly refused).
            return false;
        }
        const derived = await scryptAsync(password, salt);
        return timingSafeEqual(derived, expected);
    } catch {
        return false;
    }
}
