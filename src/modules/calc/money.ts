// Money is always an integer count of paise, carried as bigint. Never use
// Number/Float for a currency amount anywhere past this module's boundary —
// JS floats cannot represent paise exactly and will drift under repeated
// addition, which is unacceptable for numbers a founder makes decisions on.

export type Paise = bigint;

export function rupeesToPaise(rupees: number): Paise {
  return BigInt(Math.round(rupees * 100));
}

export function paiseToRupees(paise: Paise): number {
  return Number(paise) / 100;
}

export function sumPaise(values: Paise[]): Paise {
  return values.reduce((acc, v) => acc + v, 0n);
}

// For amounts that are NOT necessarily rupees. Ad platforms (Meta, Google)
// report spend in the ad account's own billing currency, which an Indian
// advertiser may well have set to USD — so those connectors must not call
// rupeesToPaise() and pretend the result is paise. Same arithmetic, different
// claim: this returns minor units *of whatever currency the caller recorded
// alongside it*, and the caller is responsible for storing that currency.
//
// Assumes a 2-decimal currency (INR/USD/EUR/GBP/AED/SGD — every currency
// plausible for this product's users). Zero-decimal (JPY, KRW) and
// three-decimal (KWD, BHD) currencies would scale differently; storing the
// currency code next to the amount is what makes that detectable later
// instead of silently wrong.
export function majorToMinorUnits(amount: number): bigint {
  return BigInt(Math.round(amount * 100));
}

export function formatInr(paise: Paise): string {
  const rupees = paiseToRupees(paise);
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(rupees);
}
