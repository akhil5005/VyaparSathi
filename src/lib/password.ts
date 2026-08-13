import argon2 from 'argon2';

// Argon2id — memory-hard, so a stolen hash dump is expensive to attack on GPUs
// in a way bcrypt no longer is. These are the OWASP-recommended parameters.
const OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export const hashPassword = (plain: string): Promise<string> => argon2.hash(plain, OPTIONS);

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    // A malformed hash in the DB should read as "wrong password", not a 500.
    return false;
  }
}

/// True when the stored hash was produced with weaker parameters than we now
/// use — lets us transparently upgrade a user's hash on their next login.
export const needsRehash = (hash: string): boolean => argon2.needsRehash(hash, OPTIONS);
