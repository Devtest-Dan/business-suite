/**
 * A copy of Customers' card guard (apps never import each other's code).
 * Card numbers must never be stored here (payment card data belongs with the
 * payment provider, never in a CRM). This finds anything in a text that looks
 * like a payment card number: 13 to 19 digits, optionally split by spaces or
 * dashes, starting like a card scheme does (2 to 6), and passing the Luhn
 * check card numbers carry. Phone numbers written with "+" are left alone.
 * Pure, so the browser and the server share it.
 */

const CANDIDATE = /(?<![\d+])(?:\d[ -]?){12,18}\d(?!\d)/g;

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function looksLikeCardNumber(text: string): boolean {
  if (!text) return false;
  for (const match of text.matchAll(CANDIDATE)) {
    const digits = match[0].replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    if (!/^[2-6]/.test(digits)) continue;
    if (/^(\d)\1+$/.test(digits)) continue;
    if (luhnValid(digits)) return true;
  }
  return false;
}

export const CARD_MESSAGE =
  "This looks like a payment card number. Card numbers must not be sent or stored here: remove it and try again (card details belong with a payment provider).";
