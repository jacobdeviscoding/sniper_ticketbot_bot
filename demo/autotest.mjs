/**
 * Optional headless autotest. Requires puppeteer at runtime (not bundled):
 *   npx -p puppeteer node autotest.mjs
 * Start demo server first: npx serve -l 4180
 */
import puppeteer from "puppeteer";
import fs from "node:fs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browserCandidates = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);
const executablePath = browserCandidates.find((candidate) => fs.existsSync(candidate));

async function run(url, label) {
  const browser = await puppeteer.launch({ headless: true, executablePath, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.error(`${label} page error:`, err.message));
  await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 });
  for (let i = 0; i < 90; i++) {
    const result = await page.evaluate(() => window.__HKT_TEST_RESULT__);
    if (result) {
      console.log(`${label}:`, JSON.stringify(result));
      await browser.close();
      return result;
    }
    await wait(1000);
  }
  const logs = await page.evaluate(() => window.HKTRunner?.logs?.() || []);
  console.log(`${label} TIMEOUT`, logs.slice(0, 10));
  await browser.close();
  return { ok: false, reason: "timeout" };
}

const hkt = await run("http://localhost:4180/?autotest=1", "HKT");
const kktix = await run("http://localhost:4180/?autotest=1&platform=kktix", "KKTIX");
process.exit(hkt.ok && kktix.ok ? 0 : 1);
