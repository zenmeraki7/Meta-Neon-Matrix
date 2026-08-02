const SCALE_DIGITS = 4;
const SCALE = 10_000n;

function roundDivide(numerator, denominator) {
  if (denominator <= 0n) throw new Error("DECIMAL_DENOMINATOR_INVALID");
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute + denominator / 2n) / denominator;
  return negative ? -rounded : rounded;
}

export function parseDecimalUnits(value) {
  const match = String(value ?? "").trim().match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error("DECIMAL_VALUE_INVALID");
  const sign = match[1] === "-" ? -1n : 1n;
  const fraction = (match[3] || "").padEnd(SCALE_DIGITS + 1, "0");
  let units = BigInt(match[2]) * SCALE + BigInt(fraction.slice(0, SCALE_DIGITS));
  if (fraction[SCALE_DIGITS] >= "5") units += 1n;
  return sign * units;
}

export function formatDecimalUnits(units) {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  return `${negative ? "-" : ""}${absolute / SCALE}.${String(absolute % SCALE).padStart(SCALE_DIGITS, "0")}`;
}

export function canonicalizeMoney(value) {
  return formatDecimalUnits(parseDecimalUnits(value));
}

export function addMoney(current, delta) {
  return formatDecimalUnits(parseDecimalUnits(current) + parseDecimalUnits(delta));
}

export function applyMoneyPercentage(current, percentage, direction = 1n) {
  const currentUnits = parseDecimalUnits(current);
  const percentageUnits = parseDecimalUnits(percentage);
  const factor = 100n * SCALE + direction * percentageUnits;
  return formatDecimalUnits(roundDivide(currentUnits * factor, 100n * SCALE));
}

export function percentageOfMoney(current, percentage) {
  return formatDecimalUnits(roundDivide(
    parseDecimalUnits(current) * parseDecimalUnits(percentage),
    100n * SCALE,
  ));
}

export function percentageToRatio(percentage) {
  const ratioUnits = parseDecimalUnits(percentage) * 100n;
  const negative = ratioUnits < 0n;
  const absolute = negative ? -ratioUnits : ratioUnits;
  return `${negative ? "-" : ""}${absolute / 100_000_000n}.${String(absolute % 100_000_000n).padStart(8, "0")}`;
}
