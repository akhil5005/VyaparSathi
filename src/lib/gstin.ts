/**
 * GSTIN validation and place-of-supply derivation.
 *
 * A GSTIN is 15 characters: SS PPPPPP PPPP E Z C
 *   [0:2]   state code            (Punjab = 03)
 *   [2:12]  PAN of the entity
 *   [12]    entity number for that PAN within the state
 *   [13]    'Z' by default
 *   [14]    checksum
 *
 * Getting the state code right is not cosmetic — it decides whether the
 * invoice carries CGST+SGST or IGST, and a wrong split is a filing error.
 */

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

const CHECKSUM_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

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
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
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

/**
 * Modulus-36 checksum used by the GSTN.
 *
 * Each of the first 14 characters is mapped to its index in the alphabet and
 * multiplied by an alternating factor of 1 and 2, starting at 1. Products are
 * folded (quotient + remainder over 36) and summed; the check digit is whatever
 * brings the total up to the next multiple of 36.
 */
export function computeGstinChecksum(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = CHECKSUM_ALPHABET.indexOf(first14[i]!);
    if (value === -1) return '';
    const factor = i % 2 === 0 ? 1 : 2;
    const product = value * factor;
    sum += Math.floor(product / 36) + (product % 36);
  }
  const checkIndex = (36 - (sum % 36)) % 36;
  return CHECKSUM_ALPHABET[checkIndex]!;
}

export interface GstinValidation {
  valid: boolean;
  reason?: string;
  stateCode?: string;
  stateName?: string;
  pan?: string;
}

export function validateGstin(raw: string): GstinValidation {
  const gstin = raw.trim().toUpperCase();

  if (gstin.length !== 15) {
    return { valid: false, reason: 'GSTIN must be exactly 15 characters' };
  }
  if (!GSTIN_REGEX.test(gstin)) {
    return { valid: false, reason: 'GSTIN format is invalid' };
  }

  const stateCode = gstin.slice(0, 2);
  const stateName = STATE_CODES[stateCode];
  if (!stateName) {
    return { valid: false, reason: `Unknown state code "${stateCode}"` };
  }

  if (computeGstinChecksum(gstin.slice(0, 14)) !== gstin[14]) {
    return { valid: false, reason: 'GSTIN checksum does not match — check for a typo' };
  }

  return { valid: true, stateCode, stateName, pan: gstin.slice(2, 12) };
}

export const stateCodeFromGstin = (gstin: string): string => gstin.trim().slice(0, 2);

/**
 * The single decision that drives the whole tax split. Never ask the user for
 * this — a mistake here puts the wrong tax heads on a filed return.
 */
export function resolveSupplyType(
  businessStateCode: string,
  placeOfSupplyStateCode: string,
): 'INTRA_STATE' | 'INTER_STATE' {
  return businessStateCode === placeOfSupplyStateCode ? 'INTRA_STATE' : 'INTER_STATE';
}
