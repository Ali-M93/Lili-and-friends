// Experimental: obtain a Unity Personal .ulf via the manual activation website.
// Inputs: env UNITY_EMAIL, UNITY_PASSWORD, ALF_PATH, OUT_DIR
// Every step saves a screenshot + HTML into OUT_DIR (encrypted before upload).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const { UNITY_EMAIL, UNITY_PASSWORD, ALF_PATH, OUT_DIR } = process.env;
fs.mkdirSync(OUT_DIR, { recursive: true });
let step = 0;
const browser = await chromium.launch();
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 1000 } });
const page = await context.newPage();

async function snap(name) {
  step++;
  const base = path.join(OUT_DIR, `${String(step).padStart(2, '0')}-${name}`);
  try { await page.screenshot({ path: `${base}.png`, fullPage: true }); } catch {}
  try { fs.writeFileSync(`${base}.html`, await page.content()); } catch {}
  console.log(`[step ${step}] ${name} -> ${page.url().split('?')[0]}`);
}
async function firstVisible(selectors, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const s of selectors) {
      const l = page.locator(s).first();
      if (await l.count() && await l.isVisible().catch(() => false)) return l;
    }
    await page.waitForTimeout(500);
  }
  return null;
}
// Code is delivered as "<RUN_ID> <code>" in code.txt on branch ci-in.
async function waitForCode() {
  const { GITHUB_REPOSITORY, GITHUB_TOKEN, GITHUB_RUN_ID } = process.env;
  const url = `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/code.txt?ref=ci-in`;
  const end = Date.now() + 12 * 60 * 1000;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.raw', 'Cache-Control': 'no-cache' } });
      if (r.ok) {
        const [rid, code] = (await r.text()).trim().split(/\s+/);
        if (rid === GITHUB_RUN_ID && /^\d{4,8}$/.test(code || '')) { console.log('CODE_RECEIVED'); return code; }
      }
    } catch {}
    await new Promise(res => setTimeout(res, 5000));
  }
  throw new Error('timed out waiting for verification code');
}
async function clickSubmit() {
  const b = await firstVisible(['button[type=submit]', 'input[type=submit]', 'input[name=commit]'], 5000);
  if (b) await b.click(); else await page.keyboard.press('Enter');
}

try {
  await page.goto('https://license.unity3d.com/manual', { waitUntil: 'networkidle' });
  await snap('start');

  // ---- Login (single page or email-then-password) ----
  const email = await firstVisible(['input[type=email]', 'input[name="conversations_create_session_form[email]"]', 'input[name=email]', 'input[name=username]']);
  if (email) {
    await email.fill(UNITY_EMAIL);
    let pwd = await firstVisible(['input[type=password]'], 2000);
    if (!pwd) { await clickSubmit(); await page.waitForLoadState('networkidle'); await snap('after-email'); pwd = await firstVisible(['input[type=password]']); }
    if (!pwd) throw new Error('password field not found');
    await pwd.fill(UNITY_PASSWORD);
    await snap('login-filled');
    await clickSubmit();
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(4000);
    await snap('after-login');

    // ---- Verification code (new location) ----
    const codeInput = await firstVisible(['input[name*="code" i]', 'input[id*="code" i]', 'input[autocomplete="one-time-code"]', 'input[inputmode="numeric"]'], 6000);
    if (codeInput) {
      console.log('WAITING_FOR_CODE');
      const code = await waitForCode();
      await codeInput.fill(code);
      await snap('code-filled');
      await clickSubmit();
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(4000);
      await snap('after-code');
    }
  }

  // ---- Upload .alf ----
  const fileInput = page.locator('input[type=file]').first();
  await fileInput.waitFor({ state: 'attached', timeout: 30000 });
  await fileInput.setInputFiles(ALF_PATH);
  await snap('alf-selected');
  await clickSubmit();
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(3000);
  await snap('after-upload');

  // ---- Reveal and choose Personal ----
  await page.evaluate(() => {
    document.querySelectorAll('.option-personal, [class*="personal"]').forEach(e => { e.style.display = 'block'; e.style.visibility = 'visible'; });
  });
  await snap('personal-revealed');
  const personal = await firstVisible(['#type_personal', 'label[for="type_personal"]', 'input[value="personal"]', 'text=Unity Personal Edition'], 8000);
  if (!personal) throw new Error('personal option not found');
  await personal.click({ force: true });
  await page.waitForTimeout(1000);
  const notPro = await firstVisible(['label[for="option3"]', '#option3', "text=I don't use Unity in a professional capacity"], 5000);
  if (notPro) await notPro.click({ force: true });
  await snap('personal-chosen');
  const next = await firstVisible(['input.btn.mb10', 'input[value="Next"]', 'button:has-text("Next")', 'input[type=submit]'], 5000);
  if (next) await next.click(); else await clickSubmit();
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(3000);
  await snap('after-next');

  // ---- Download .ulf ----
  const dlBtn = await firstVisible(['input[value="Download license file"]', 'text=Download license file', 'input[name=commit]', 'button:has-text("Download")'], 15000);
  if (!dlBtn) throw new Error('download button not found');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), dlBtn.click()]);
  await dl.saveAs(path.join(OUT_DIR, 'Unity_lic.ulf'));
  await snap('downloaded');
  console.log('RESULT: ulf downloaded');
} catch (e) {
  console.log('RESULT: failed -', e.message);
  await snap('error');
  process.exitCode = 1;
} finally {
  await browser.close();
}
