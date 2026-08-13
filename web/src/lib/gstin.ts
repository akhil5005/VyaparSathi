/**
 * GSTIN validation, mirrored from the server's `src/lib/gstin.ts`.
 *
 * Duplicated deliberately. The server validates on every write and is the
 * authority; this copy exists so a typo is caught while the cursor is still in
 * the box, rather than after a round trip. A GSTIN is 15 characters that
 * somebody reads off a card and types, so the error rate is high and the
 * feedback needs to be immediate.
 *
 * If the two ever disagree, the server wins — the worst case here is that a
 * genuinely valid GSTIN is warned about and still submits fine.
 */

/// 2-digit state code -> state name. Also decides CGST+SGST vs IGST.
export const STATE_CODES: Record<string, string> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '25': 'Daman and Diu',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '28': 'Andhra Pradesh (old)',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
};

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * The 15th character, computed from the first 14.
 *
 * Base-36 with alternating weights of 1 and 2; digits above 35 wrap, and the
 * check character is whatever brings the total to a multiple of 36.
 */
export function computeGstinChecksum(first14: string): string {
  let sum = 0;
  for (let i = 0; i < first14.length; i++) {
    const value = ALPHABET.indexOf(first14[i]!);
    if (value < 0) return '';
    const weighted = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(weighted / 36) + (weighted % 36);
  }
  return ALPHABET[(36 - (sum % 36)) % 36]!;
}

export interface GstinCheck {
  valid: boolean;
  reason?: string;
  stateCode?: string;
  stateName?: string;
}

const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function validateGstin(input: string): GstinCheck {
  const gstin = input.trim().toUpperCase();

  if (gstin.length !== 15) {
    return { valid: false, reason: 'A GSTIN is exactly 15 characters' };
  }
  if (!GSTIN_PATTERN.test(gstin)) {
    return { valid: false, reason: "That doesn't look like a GSTIN — check for a typo" };
  }

  const stateCode = gstin.slice(0, 2);
  const stateName = STATE_CODES[stateCode];
  if (!stateName) {
    return { valid: false, reason: `${stateCode} is not a valid state code` };
  }

  if (computeGstinChecksum(gstin.slice(0, 14)) !== gstin[14]) {
    // The check digit is the whole point — it catches single-character typos,
    // which is exactly how these get entered wrong.
    return { valid: false, reason: 'The check digit is wrong — one character is mistyped' };
  }

  return { valid: true, stateCode, stateName };
}

/// The PAN sits inside the GSTIN, characters 3–12. Useful to show back as
/// confirmation that the right number was typed.
export const panFromGstin = (gstin: string): string => gstin.trim().toUpperCase().slice(2, 12);
