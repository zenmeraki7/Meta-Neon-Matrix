import fs from "node:fs";
import path from "node:path";

const FIXTURE_PATH = process.env.LARGE_MERCHANT_FIXTURE_PATH
  || path.resolve(process.cwd(), "perf/fixtures/large-merchant.fixture.json");

const profile = process.env.NETWORK_PROFILE || "throttled-4g";
const cpuThrottle = Number(process.env.CPU_THROTTLE || 4);

const MIN_PRODUCTS = Number(process.env.PERF_MIN_PRODUCTS || 50000);
const MIN_VARIANTS = Number(process.env.PERF_MIN_VARIANTS || 150000);

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!fs.existsSync(FIXTURE_PATH)) {
  fail(`Large merchant fixture not found: ${FIXTURE_PATH}`);
}

const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
const products = Number(fixture.productCount || 0);
const variants = Number(fixture.variantCount || 0);

if (products < MIN_PRODUCTS) {
  fail(`Fixture products too small: ${products} < ${MIN_PRODUCTS}`);
}

if (variants < MIN_VARIANTS) {
  fail(`Fixture variants too small: ${variants} < ${MIN_VARIANTS}`);
}

if (!Number.isFinite(cpuThrottle) || cpuThrottle < 1) {
  fail(`Invalid CPU_THROTTLE: ${process.env.CPU_THROTTLE}`);
}

console.log(`Perf matrix fixture validated.`);
console.log(`Fixture: ${FIXTURE_PATH}`);
console.log(`Products: ${products}, Variants: ${variants}`);
console.log(`Network profile: ${profile}, CPU throttle: ${cpuThrottle}x`);

