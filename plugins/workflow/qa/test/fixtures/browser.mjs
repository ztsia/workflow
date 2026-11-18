// The reason a test that needs a browser cannot run here, or null when one starts: playwright-core (installed on
// first use) launching a Chromium, the installed one or /opt/pw-browsers/chromium. A test uses it as `{ skip }`.
import fs from 'node:fs';
import { loadPlaywright } from '../../scripts/lib/playwright.mjs';
import { FALLBACK_CHROMIUM } from '../../scripts/lib/capture.mjs';

export async function browserSkip() {
  let pw;
  try {
    pw = loadPlaywright(process.cwd());
  } catch (e) {
    return `no browser here: playwright-core could not be installed (${String(e?.message ?? e).split('\n')[0]})`;
  }
  for (const options of [{ headless: true }, ...(fs.existsSync(FALLBACK_CHROMIUM) ? [{ headless: true, executablePath: FALLBACK_CHROMIUM }] : [])]) {
    try {
      await (await pw.chromium.launch(options)).close();
      return false;
    } catch { /* try the next */ }
  }
  return 'no browser here: no Chromium starts (install one, or put it at /opt/pw-browsers/chromium)';
}
