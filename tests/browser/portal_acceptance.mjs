import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';

const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const base = state.base_url;
const browser = await chromium.launch({ headless: true });
const pageErrors = [];

async function openPage(session, path) {
  const context = await browser.newContext({ locale: 'en-GB' });
  await context.addInitScript(({ hassUrl, tokens }) => {
    const stored = {
      ...tokens,
      hassUrl,
      clientId: `${hassUrl}/`,
      expires: Date.now() + Number(tokens.expires_in || 1800) * 1000,
    };
    localStorage.setItem('hassTokens', JSON.stringify(stored));
    localStorage.setItem('hassUrl', hassUrl);
  }, { hassUrl: base, tokens: session.tokens });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return { context, page };
}

async function waitCard(page, selector) {
  const card = page.locator(selector);
  await card.waitFor({ state: 'visible', timeout: 30000 });
  return card;
}

async function waitUsers(page, include, exclude) {
  await page.waitForFunction(
    ({ include, exclude }) => {
      const card = document.querySelector('building-tenant-admin-card');
      const text = card?.shadowRoot?.querySelector('#users')?.textContent || '';
      return include.every((value) => text.includes(value)) && exclude.every((value) => !text.includes(value));
    },
    { include, exclude },
    { timeout: 20000 },
  );
}

let rootContext;
let adminContext;
let root;
let adminPage;
try {
  // Root client switching: A -> B -> A must update the People list atomically.
  ({ context: rootContext, page: root } = await openPage(state.root, '/energy-setup/people'));
  const rootCard = await waitCard(root, 'building-tenant-admin-card');
  await rootCard.getByText('People & clients').waitFor();
  const clientSwitch = rootCard.locator('#clientSwitch');
  await clientSwitch.waitFor();
  await root.waitForFunction(() => {
    const card = document.querySelector('building-tenant-admin-card');
    return (card?.shadowRoot?.querySelector('#clientSwitch')?.options?.length || 0) >= 2;
  });
  await clientSwitch.selectOption(state.client_a);
  await waitUsers(root, ['Browser Admin A', 'Browser User A'], ['Browser Admin B', 'Browser User B']);
  await clientSwitch.selectOption(state.client_b);
  await waitUsers(root, ['Browser Admin B', 'Browser User B'], ['Browser Admin A', 'Browser User A']);
  await clientSwitch.selectOption(state.client_a);
  await waitUsers(root, ['Browser Admin A', 'Browser User A'], ['Browser Admin B', 'Browser User B']);

  // Client-admin login and location surface.
  ({ context: adminContext, page: adminPage } = await openPage(state.admin_a, '/energy-locations/start'));
  await adminPage.getByText(state.client_a_name).first().waitFor({ timeout: 30000 });
  assert.equal(await adminPage.getByText(state.client_b_name).count(), 0, 'Client B name leaked to Client A');
  await adminPage.goto(`${base}/energy-setup/people`, { waitUntil: 'domcontentloaded' });
  const adminCard = await waitCard(adminPage, 'building-tenant-admin-card');
  await adminCard.getByText('People & clients').waitFor({ timeout: 30000 });
  assert.equal(await adminCard.locator('#clientSwitch').count(), 0, 'client administrator saw the root client switcher');
  assert.equal(await adminPage.getByText('Settings', { exact: true }).count(), 0, 'client administrator saw HA Settings');
  await waitUsers(adminPage, ['Browser Admin A', 'Browser User A'], ['Browser Admin B', 'Browser User B']);
  const adminUsers = await adminCard.locator('#users').innerText();
  assert.match(adminUsers, /Browser Admin A/);
  assert.match(adminUsers, /Browser User A/);
  assert.doesNotMatch(adminUsers, /Browser Admin B|Browser User B/);
  const locationText = await adminCard.locator('#locationmap').innerText();
  assert.match(locationText, /Browser A North/);
  assert.match(locationText, /Browser A West/);

  // Create, disable, enable, move, and delete a location-scoped user.
  await adminCard.locator('#newName').fill('Browser Created User');
  await adminCard.locator('#newUsername').fill(state.created_user.username);
  await adminCard.locator('#newPassword').fill(state.created_user.password);
  await adminCard.locator('#newLocation').selectOption(state.location_a_west);
  await adminCard.locator('[data-create-user]').click();
  await waitUsers(adminPage, ['Browser Created User'], []);
  let createdRow = adminCard.locator('.user').filter({ hasText: 'Browser Created User' });
  await createdRow.waitFor();
  const createdId = await createdRow.locator('[data-toggle]').getAttribute('data-toggle');
  assert.ok(createdId, 'created user has no id');

  await createdRow.locator('[data-toggle]').click();
  await adminPage.waitForFunction((id) => {
    const card = document.querySelector('building-tenant-admin-card');
    const row = [...(card?.shadowRoot?.querySelectorAll('.user') || [])].find((item) => item.querySelector(`[data-toggle="${id}"]`));
    return row?.textContent?.includes('disabled') || false;
  }, createdId);
  createdRow = adminCard.locator('.user').filter({ hasText: 'Browser Created User' });
  await createdRow.locator('[data-toggle]').click();
  await adminPage.waitForFunction((id) => {
    const card = document.querySelector('building-tenant-admin-card');
    const row = [...(card?.shadowRoot?.querySelectorAll('.user') || [])].find((item) => item.querySelector(`[data-toggle="${id}"]`));
    return row && !row.textContent.includes('disabled');
  }, createdId);

  createdRow = adminCard.locator('.user').filter({ hasText: 'Browser Created User' });
  await createdRow.locator('select[data-user-loc]').selectOption(state.location_a_north);
  await adminPage.waitForFunction(({ id, location }) => {
    const card = document.querySelector('building-tenant-admin-card');
    const row = [...(card?.shadowRoot?.querySelectorAll('.user') || [])].find((item) => item.querySelector(`[data-user-loc="${id}"]`));
    return row?.querySelector('select[data-user-loc]')?.value === location;
  }, { id: createdId, location: state.location_a_north });

  // Checked tree/price editing through the client-admin UI.
  await adminPage.goto(`${base}/energy-setup/structure`, { waitUntil: 'domcontentloaded' });
  const manage = await waitCard(adminPage, 'building-manage-card');
  await manage.getByText('Price per kWh').waitFor({ timeout: 30000 });
  const fixed = manage.locator(`[data-price-mode="fixed"][data-loc="${state.location_a_north}"]`);
  await fixed.click();
  await manage.locator('#typed').fill('0.31');
  await manage.locator(`[data-type-save="${state.location_a_north}"]`).click();
  await manage.getByText('€ 0.310').waitFor({ timeout: 20000 });
  await manage.locator(`select[data-main-for="${state.location_a_north}"]`).selectOption(state.virtual_main);
  await adminPage.waitForTimeout(500);
  await adminPage.reload({ waitUntil: 'domcontentloaded' });
  const manageReloaded = await waitCard(adminPage, 'building-manage-card');
  await manageReloaded.getByText('Price per kWh').waitFor({ timeout: 30000 });
  await manageReloaded.getByText('€ 0.310').waitFor({ timeout: 20000 });
  assert.equal(
    await manageReloaded.locator(`select[data-main-for="${state.location_a_north}"]`).inputValue(),
    state.virtual_main,
    'main-device tree edit did not persist',
  );

  // Clean up the browser-created user through the same UI.
  await adminPage.goto(`${base}/energy-setup/people`, { waitUntil: 'domcontentloaded' });
  const peopleAgain = await waitCard(adminPage, 'building-tenant-admin-card');
  await peopleAgain.getByText('People & clients').waitFor({ timeout: 30000 });
  let deleteRow = peopleAgain.locator('.user').filter({ hasText: 'Browser Created User' });
  await deleteRow.locator('[data-delete]').click();
  await deleteRow.locator('[data-delete]').click();
  await deleteRow.waitFor({ state: 'detached', timeout: 20000 });

  assert.deepEqual(pageErrors, [], `browser page errors: ${pageErrors.join('; ')}`);
  console.log(JSON.stringify({ profile: 'browser portal flows', status: 'PASS' }, null, 2));
} finally {
  await rootContext?.close();
  await adminContext?.close();
  await browser.close();
}
