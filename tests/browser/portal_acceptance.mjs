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
  page.on('pageerror', (error) => {
    const message = error?.stack || error?.message;
    const text = message ? String(message) : '';
    if (text && text !== 'Object' && text !== '[object Object]') pageErrors.push(text);
  });
  await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return { context, page };
}

async function waitCard(page, selector) {
  const card = page.locator(selector);
  await card.waitFor({ state: 'visible', timeout: 30000 });
  return card;
}

async function waitUsers(page, include, exclude) {
  const users = page.locator('building-admin-card #people, building-admin-table-card #people');
  const deadline = Date.now() + 20000;
  let actual = '';
  try {
    while (Date.now() < deadline) {
      actual = await users.innerText().catch(() => '');
      if (include.every((value) => actual.includes(value)) && exclude.every((value) => !actual.includes(value))) return;
      await page.waitForTimeout(100);
    }
    throw new Error('timeout');
  } catch (error) {
    throw new Error(`users wait failed; include=${include}; exclude=${exclude}; actual=${actual}`, { cause: error });
  }
}

let rootContext;
let adminContext;
let root;
let adminPage;
try {
  // Root client switching: A -> B -> A must update the People list atomically.
  ({ context: rootContext, page: root } = await openPage(state.root, '/energy-admin/people'));
  const rootCard = await waitCard(root, 'building-admin-table-card');
  await rootCard.getByRole('heading', { level: 1, name: 'People' }).waitFor();
  const clientSwitch = rootCard.locator('#clientSwitch');
  await clientSwitch.waitFor();
  if ((await clientSwitch.inputValue()) !== state.client_a) {
    await clientSwitch.selectOption(state.client_a);
  }
  await waitUsers(root, ['Browser Admin A', 'Browser User A'], ['Browser Admin B', 'Browser User B']);
  await clientSwitch.selectOption(state.client_b);
  await waitUsers(root, ['Browser Admin B', 'Browser User B'], ['Browser Admin A', 'Browser User A']);
  await clientSwitch.selectOption(state.client_a);
  await waitUsers(root, ['Browser Admin A', 'Browser User A'], ['Browser Admin B', 'Browser User B']);

  // The HA administrator gets the command centre rather than the client pages.
  for (const [path, title] of [['/energy-admin/clients', 'Clients'], ['/energy-admin/locations', 'Locations'], ['/energy-admin/devices', 'Devices']]) {
    await root.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
    const card = await waitCard(root, 'building-admin-table-card');
    await card.getByRole('heading', { level: 1, name: title }).waitFor({ timeout: 30000 });
  }
  await root.goto(`${base}/energy-admin/clients`, { waitUntil: 'domcontentloaded' });
  const overviewAgain = await waitCard(root, 'building-admin-table-card');
  await root.locator('dialog-http-pending-config').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
  await root.waitForTimeout(500);
  await overviewAgain.getByRole('button', { name: 'Preview' }).first().dispatchEvent('click');
  await root.waitForURL(`${base}/energy-home/home`, { timeout: 30000 });

  // Client-admin login and location surface.
  ({ context: adminContext, page: adminPage } = await openPage(state.admin_a, '/energy-locations/start'));
  await adminPage.getByText(state.client_a_name).first().waitFor({ timeout: 30000 });
  assert.equal(await adminPage.getByText(state.client_b_name).count(), 0, 'Client B name leaked to Client A');
  const clientDefault = await openPage(state.admin_a, '/energy-admin/clients');
  await clientDefault.page.waitForURL(`${base}/energy-locations/start`, { timeout: 30000 });
  await clientDefault.context.close();
  await adminPage.goto(`${base}/energy-setup/people`, { waitUntil: 'domcontentloaded' });
  const adminCard = await waitCard(adminPage, 'building-admin-table-card');
  await adminCard.getByRole('heading', { level: 1, name: 'People' }).waitFor({ timeout: 30000 });
  assert.equal(await adminCard.locator('#clientSwitch').count(), 0, 'client administrator saw the root client switcher');
  assert.equal(await adminPage.getByText('Settings', { exact: true }).count(), 0, 'client administrator saw HA Settings');
  await waitUsers(adminPage, ['Browser Admin A', 'Browser User A'], ['Browser Admin B', 'Browser User B']);
  const adminUsers = await adminCard.locator('#people').innerText();
  assert.match(adminUsers, /Browser Admin A/);
  assert.match(adminUsers, /Browser User A/);
  assert.doesNotMatch(adminUsers, /Browser Admin B|Browser User B/);
  const locationText = await adminCard.locator('#locationmap').innerText();
  assert.match(locationText, /Browser A North/);
  assert.match(locationText, /Browser A West/);

  // Create, disable, enable, move, and delete a location-scoped user.
  await adminCard.locator('[data-new-person]').click();
  await adminCard.locator('#editorName').fill('Browser Created User');
  await adminCard.locator('#editorUsername').fill(state.created_user.username);
  await adminCard.locator('#editorPassword').fill(state.created_user.password);
  await adminCard.locator('#editorLocations').selectOption([state.location_a_west]);
  await adminCard.locator('[data-save-editor]').click();
  await waitUsers(adminPage, ['Browser Created User'], []);
  let createdRow = adminCard.locator('#people tbody tr').filter({ hasText: 'Browser Created User' });
  await createdRow.waitFor();
  const createdId = await createdRow.locator('[data-toggle]').getAttribute('data-toggle');
  assert.ok(createdId, 'created user has no id');

  await createdRow.locator('[data-toggle]').click();
  createdRow = adminCard.locator('#people tbody tr').filter({ hasText: 'Browser Created User' });
  await createdRow.getByText('Disabled', { exact: true }).waitFor({ timeout: 20000 });
  await createdRow.locator('[data-toggle]').click();
  createdRow = adminCard.locator('#people tbody tr').filter({ hasText: 'Browser Created User' });
  await createdRow.locator('[data-toggle]').filter({ hasText: 'Disable' }).waitFor({ timeout: 20000 });

  await createdRow.locator('[data-edit-person]').click();
  await adminCard.locator('#editorLocations').selectOption([state.location_a_north]);
  await adminCard.locator('[data-save-editor]').click();
  const moveDeadline = Date.now() + 20000;
  while (Date.now() < moveDeadline) {
    createdRow = adminCard.locator('#people tbody tr').filter({ hasText: 'Browser Created User' });
    if ((await createdRow.innerText().catch(() => '')).includes('Browser A North')) break;
    await adminPage.waitForTimeout(100);
  }
  assert.match(await createdRow.innerText(), /Browser A North/, 'user location edit did not persist');

  // A one-location ordinary user lands in its workspace and has no Locations tab.
  const oneLocation = await openPage(state.user_a, '/energy-locations/start');
  await oneLocation.page.waitForURL(`${base}/energy-home/home`, { timeout: 30000 });
  assert.equal(await oneLocation.page.getByRole('link', { name: 'Locations' }).count(), 0, 'single-location user saw the Locations tab');
  await oneLocation.context.close();

  // Checked tree/price editing through the client-admin UI.
  await adminPage.goto(`${base}/energy-setup/structure`, { waitUntil: 'domcontentloaded' });
  const manage = await waitCard(adminPage, 'building-manage-card');
  await manage.getByText('Price per kWh').waitFor({ timeout: 30000 });
  const fixed = manage.locator(`[data-price-mode="fixed"][data-loc="${state.location_a_north}"]`);
  await fixed.click();
  await manage.locator('#typed').fill('0.31');
  await manage.locator(`[data-type-save="${state.location_a_north}"]`).click();
  await manage.getByText('€ 0.310').first().waitFor({ timeout: 20000 });
  await manage.locator(`select[data-main-for="${state.location_a_north}"]`).selectOption(state.virtual_main);
  await adminPage.waitForTimeout(500);
  await adminPage.reload({ waitUntil: 'domcontentloaded' });
  const manageReloaded = await waitCard(adminPage, 'building-manage-card');
  await manageReloaded.getByText('Price per kWh').waitFor({ timeout: 30000 });
  await manageReloaded.getByText('€ 0.310').first().waitFor({ timeout: 20000 });
  assert.equal(
    await manageReloaded.locator(`select[data-main-for="${state.location_a_north}"]`).inputValue(),
    state.virtual_main,
    'main-device tree edit did not persist',
  );

  // Clean up the browser-created user through the same UI.
  await adminPage.goto(`${base}/energy-setup/people`, { waitUntil: 'domcontentloaded' });
  const peopleAgain = await waitCard(adminPage, 'building-admin-table-card');
  await peopleAgain.getByRole('heading', { level: 1, name: 'People' }).waitFor({ timeout: 30000 });
  let deleteRow = peopleAgain.locator('#people tbody tr').filter({ hasText: 'Browser Created User' });
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
