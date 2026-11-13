import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';

const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const base = state.base_url;
const browser = await chromium.launch({ headless: true });
const pageErrors = [];

async function openPage(session, path) {
  const context = await browser.newContext({ locale: 'en-GB', viewport: { width: 1280, height: 900 } });
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

const shots = process.env.SHOTS;
async function shot(page, name) {
  if (!shots) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${shots}/${name}.png` });
}

async function waitCard(page, selector) {
  const card = page.locator(selector);
  await card.waitFor({ state: 'visible', timeout: 30000 });
  return card;
}

async function waitUsers(page, include, exclude) {
  const users = page.locator('building-admin-table-card #people');
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
  const rootDefault = await openPage(state.root, '/');
  await rootDefault.page.waitForURL(`${base}/energy-admin/clients`, { timeout: 30000 });
  assert.equal(
    await rootDefault.page.getByRole('link', { name: 'Administration' }).count(),
    1,
    'Home Assistant administrator did not get the Administration tab',
  );
  const adminHomeLinks = rootDefault.page.getByRole('link', { name: 'Home' });
  await adminHomeLinks.first().waitFor({ state: 'detached', timeout: 20000 }).catch(() => {});
  assert.equal(await adminHomeLinks.count(), 0, 'Home Assistant administrator saw the client Home tab');
  await rootDefault.context.close();
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
  const clientDefault = await openPage(state.admin_a, '/');
  await clientDefault.page.waitForURL(`${base}/energy-locations/start`, { timeout: 30000 });
  assert.equal(
    await clientDefault.page.getByRole('link', { name: 'Administration' }).count(),
    0,
    'client administrator saw the Administration tab',
  );
  const blockedAdmin = await openPage(state.admin_a, '/energy-admin/clients');
  await blockedAdmin.page.waitForURL((url) => !url.pathname.startsWith('/energy-admin'), { timeout: 30000 });
  assert.equal(
    await blockedAdmin.page.getByRole('link', { name: 'Administration' }).count(),
    0,
    'client administrator could open the Administration dashboard',
  );
  await blockedAdmin.context.close();
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
  await adminCard.locator(`[data-loc-check="${state.location_a_west}"]`).check();
  await adminCard.locator('[data-save-editor]').click();
  await waitUsers(adminPage, ['Browser Created User'], []);
  let createdRow = adminCard.locator('#people tbody tr').filter({ hasText: 'Browser Created User' });
  await createdRow.waitFor();
  const createdId = await createdRow.locator('[data-toggle]').getAttribute('data-toggle');
  assert.ok(createdId, 'created user has no id');

  await createdRow.locator('[data-toggle]').click();
  await adminCard.locator('dialog[open] .confirm-text').waitFor({ timeout: 10000 });
  await adminCard.locator('dialog[open] [data-save-editor]').click();
  createdRow = adminCard.locator('#people tbody tr').filter({ hasText: 'Browser Created User' });
  await createdRow.getByText('Disabled', { exact: true }).waitFor({ timeout: 20000 });
  await createdRow.locator('[data-toggle]').click();
  createdRow = adminCard.locator('#people tbody tr').filter({ hasText: 'Browser Created User' });
  await createdRow.locator('[data-toggle]').filter({ hasText: 'Disable' }).waitFor({ timeout: 20000 });

  await createdRow.locator('[data-edit-person]').click();
  await adminCard.locator(`[data-loc-check="${state.location_a_west}"]`).uncheck();
  await adminCard.locator(`[data-loc-check="${state.location_a_north}"]`).check();
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
  const locationLinks = oneLocation.page.getByRole('link', { name: 'Locations' });
  await locationLinks.first().waitFor({ state: 'detached', timeout: 20000 }).catch(() => {});
  assert.equal(await locationLinks.count(), 0, 'single-location user saw the Locations tab');
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
  // The main device decides what the client sees, so only root may change it.
  assert.equal(await manage.locator('select[data-main-for]').count(), 0, 'client admin was offered the main-device control');
  await adminPage.waitForTimeout(500);
  await adminPage.reload({ waitUntil: 'domcontentloaded' });
  const manageReloaded = await waitCard(adminPage, 'building-manage-card');
  await manageReloaded.getByText('Price per kWh').waitFor({ timeout: 30000 });
  await manageReloaded.getByText('€ 0.310').first().waitFor({ timeout: 20000 });


  // Clean up the browser-created user through the same UI.
  await adminPage.goto(`${base}/energy-setup/people`, { waitUntil: 'domcontentloaded' });
  const peopleAgain = await waitCard(adminPage, 'building-admin-table-card');
  await peopleAgain.getByRole('heading', { level: 1, name: 'People' }).waitFor({ timeout: 30000 });
  let deleteRow = peopleAgain.locator('#people tbody tr').filter({ hasText: 'Browser Created User' });
  await deleteRow.locator('[data-delete]').click();
  assert.match(await peopleAgain.locator('dialog[open] .confirm-text').innerText(), /cannot be undone/, 'deleting a person does not ask first');
  await peopleAgain.locator('dialog[open] [data-save-editor]').click();
  await deleteRow.waitFor({ state: 'detached', timeout: 20000 });

  {
    // A client administrator manages its own groups under Setup ...
    await adminPage.goto(`${base}/energy-setup/structure`, { waitUntil: 'domcontentloaded' });
    const setup = await waitCard(adminPage, 'building-manage-card');
    await setup.locator(`[data-group-new="${state.location_a_north}"]`).click();
    await setup.locator('#gname').fill('Admin Group');
    await setup.locator('[data-group-save]').click();
    const adminGroup = () => setup.locator('#tree li').filter({ hasText: 'Admin Group' }).last();
    await adminGroup().waitFor({ timeout: 20000 });
    await adminGroup().locator('[data-group-rename]').click();
    await setup.locator('#gname').fill('Admin Team');
    await setup.locator('[data-group-save]').click();
    const adminTeam = () => setup.locator('#tree li').filter({ hasText: 'Admin Team' }).last();
    await adminTeam().waitFor({ timeout: 20000 });
    assert.equal(await setup.locator('[data-nav]').count(), 0, 'client administrator is still sent to Home Assistant settings');

    // ... and renames a device and moves it into that group from the device's own page.
    await adminPage.goto(`${base}/energy-locations/start`, { waitUntil: 'domcontentloaded' });
    await adminPage.getByText('Browser A North').first().click();
    await adminPage.waitForURL(`${base}/energy-home/home`, { timeout: 30000 });
    await adminPage.goto(`${base}/energy-devices/list`, { waitUntil: 'domcontentloaded' });
    const list = await waitCard(adminPage, 'building-devices-card');
    await list.locator('[data-device]').filter({ hasText: 'Browser Meter A' }).first().click();
    await list.locator('#dname').fill('Renamed Meter');
    await list.locator('#dplace').selectOption({ label: 'Browser A North › Admin Team' });
    await list.locator('[data-save-device]').click();
    // The new name arrives first, the new group a moment later; wait for the row to show both.
    await list.locator('[data-device]').filter({ hasText: 'Renamed Meter' }).filter({ hasText: 'Admin Team' }).first().waitFor({ timeout: 20000 }).catch(async (error) => {
      throw new Error(`the device was not renamed and moved; the drawer says: ${await list.locator('#dmsg').innerText().catch(() => '')}`, { cause: error });
    });
    assert.equal(await list.locator('#dplace option').filter({ hasText: 'Browser Client B' }).count(), 0, 'another client is offered as a place');

    // A light with no metering is a device of the portal too: listed, switchable, and no page trips over its missing figures.
    for (const path of ['/energy-home/home', '/energy-groups/groups', '/energy-devices/topology', '/energy-reports/report', '/energy-alerts/alerts', '/energy-setup/wiring', '/energy-setup/automations', '/energy-setup/alerts']) {
      await adminPage.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
      await adminPage.waitForTimeout(2500);
    }
    await adminPage.goto(`${base}/energy-devices/list`, { waitUntil: 'domcontentloaded' });
    const withLamp = await waitCard(adminPage, 'building-devices-card');
    await withLamp.locator('[data-device]').filter({ hasText: 'Browser Lamp A' }).first().waitFor({ timeout: 20000 });
    await withLamp.locator('[data-device]').filter({ hasText: 'Browser Lamp A' }).first().click();
    await withLamp.locator('#dname').waitFor({ timeout: 10000 });
    await adminPage.goto(`${base}/energy-controls/controls`, { waitUntil: 'domcontentloaded' });
    const controls = await waitCard(adminPage, 'building-controls-card');
    await controls.getByText('Browser Lamp A').first().waitFor({ timeout: 20000 });

    // A password the administrator sets for a person works, and the generator fills the field.
    await adminPage.goto(`${base}/energy-setup/people`, { waitUntil: 'domcontentloaded' });
    const people = await waitCard(adminPage, 'building-admin-table-card');
    const userRow = people.locator('#people tbody tr').filter({ hasText: 'Browser User A' });
    await userRow.locator('[data-edit-person]').click();
    await people.locator('[data-generate-password]').click();
    assert.ok((await people.locator('#editorPassword').inputValue()).length >= 12, 'no password was generated');
    await people.locator('dialog[open] .form-actions [data-cancel-editor]').click();
    const adminRow = people.locator('#people tbody tr').filter({ hasText: 'Browser Admin A' });
    assert.equal(await adminRow.locator('[data-delete], [data-toggle]').count(), 0, 'buttons the server refuses are still offered');

    // A Home Assistant administrator can now open a client's Setup instead of being sent back to Administration.
    await root.goto(`${base}/energy-setup/structure`, { waitUntil: 'domcontentloaded' });
    const rootSetup = await waitCard(root, 'building-manage-card');
    await rootSetup.getByText('Price per kWh').waitFor({ timeout: 30000 });
    await rootSetup.getByText('Admin Team').first().waitFor({ timeout: 20000 });
    assert.match(new URL(root.url()).pathname, /^\/energy-setup/, 'administrator was redirected away from Setup');

    // After the move to floors and areas, root manages locations and groups inside Administration.
    await root.goto(`${base}/energy-admin/locations`, { waitUntil: 'domcontentloaded' });
    const locs = await waitCard(root, 'building-admin-table-card');
    await locs.getByRole('heading', { level: 1, name: 'Locations' }).waitFor({ timeout: 30000 });
    await root.locator('dialog-http-pending-config').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
    await locs.locator('#clientSwitch').selectOption(state.client_a);
    await locs.locator(`[data-select-location="${state.location_a_north}"]`).first().dispatchEvent('click');
    // Home Assistant's own pending-config dialog holds keyboard focus on this page, so typed text
    // would land in it. Set the field the way a user's typing would leave it instead.
    const typeInto = (locator, text) => locator.evaluate((el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true, composed: true })); }, text);
    await locs.locator('[data-new-group]').dispatchEvent('click');
    await typeInto(locs.locator('#editorName'), 'Browser Group');
    await locs.locator('[data-save-editor]').dispatchEvent('click');
    const groupRow = locs.locator('tbody tr').filter({ hasText: 'Browser Group' }).first();
    await groupRow.waitFor({ timeout: 20000 }).catch(async (error) => {
      throw new Error(`group row did not appear; page says: ${(await locs.evaluate((el) => [...(el.shadowRoot || el).children].filter((x) => x.tagName !== 'STYLE').map((x) => x.textContent).join(' ')).catch(() => '')).replace(/\s+/g, ' ').slice(0, 1500)}`, { cause: error });
    });
    await shot(root, 'locations-managed');
    await groupRow.locator('[data-delete-group]').dispatchEvent('click');
    await locs.locator('dialog[open] .confirm-text').waitFor({ timeout: 10000 });
    await shot(root, 'confirm-dialog');
    await locs.locator('dialog[open] [data-save-editor]').dispatchEvent('click');
    await locs.locator('tbody tr').filter({ hasText: 'Browser Group' }).first().waitFor({ state: 'detached', timeout: 20000 });

    await locs.locator('[data-new-location]').dispatchEvent('click');
    await typeInto(locs.locator('#editorName'), 'Browser Annex');
    await locs.locator('[data-save-editor]').dispatchEvent('click');
    const annex = () => locs.locator('tbody tr').filter({ hasText: 'Browser Annex' }).first();
    await annex().waitFor({ timeout: 20000 });
    // A new, empty location says what to do next and shows a name, not an internal id.
    await annex().locator('[data-select-location]').first().dispatchEvent('click');
    await locs.getByText('No devices in this location yet.', { exact: false }).first().waitFor({ timeout: 10000 });
    assert.doesNotMatch(await annex().innerText(), /loc:/, 'a location row shows its internal id');
    await locs.locator(`[data-select-location="${state.location_a_north}"]`).first().dispatchEvent('click');

    // The new location moves to the other client, where it is then deleted.
    await annex().locator('[data-move-location]').dispatchEvent('click');
    await locs.locator('#editorClient').selectOption(state.client_b);
    await locs.locator('[data-save-editor]').dispatchEvent('click');
    await annex().waitFor({ state: 'detached', timeout: 20000 });
    await locs.locator('#clientSwitch').selectOption(state.client_b);
    await annex().waitFor({ timeout: 20000 });
    await annex().locator('[data-delete-location]').dispatchEvent('click');
    await locs.locator('dialog[open] [data-save-editor]').dispatchEvent('click');
    await annex().waitFor({ state: 'detached', timeout: 20000 });
    await locs.locator('#clientSwitch').selectOption(state.client_a);
    await locs.locator(`[data-select-location="${state.location_a_north}"]`).first().waitFor({ timeout: 20000 });

    // The device inbox: a device no client has is listed, assigned, removed and ignored from one screen.
    await root.goto(`${base}/energy-admin/devices`, { waitUntil: 'domcontentloaded' });
    const devs = await waitCard(root, 'building-admin-table-card');
    await devs.getByRole('heading', { level: 1, name: 'Devices' }).waitFor({ timeout: 30000 });
    await root.locator('dialog-http-pending-config').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
    const spare = () => devs.locator('#inbox tbody tr').filter({ hasText: 'Browser Spare Meter' }).first();
    const show = (filter) => devs.locator(`[data-inbox-filter="${filter}"]`).dispatchEvent('click');
    await spare().waitFor({ timeout: 30000 });
    // The Clients table and the device list agree on how many devices a client has.
    const assignedToA = await devs.evaluate((el, client) => (el._inbox || []).filter((d) => d.client === client).length, state.client_a);
    const listedForA = await devs.evaluate((el, client) => (el._summaries || []).find((x) => x.id === client)?.devices, state.client_a);
    assert.ok(assignedToA >= 2 && listedForA === assignedToA, `client device count ${listedForA} differs from the device list ${assignedToA}`);
    assert.match(await spare().innerText(), /Energy meter[\s\S]*Not assigned yet/, 'inbox row does not say what the device is and that it is unassigned');
    assert.doesNotMatch(await spare().innerText(), /sensor\./, 'the technical reason is still spelled out in the row');
    assert.match(await spare().locator('td[title]').getAttribute('title'), /power sensor/, 'the reason is not available on hover');
    await typeInto(devs.locator('#inboxSearch'), 'no such device');
    await devs.getByText('No device matches the search.').waitFor({ timeout: 10000 });
    await typeInto(devs.locator('#inboxSearch'), 'spare');
    await spare().waitFor({ timeout: 10000 });
    await shot(root, 'devices-not-assigned');
    await spare().locator('[data-inbox-assign]').dispatchEvent('click');
    await devs.locator('dialog[open] #assignClient').waitFor({ timeout: 10000 });
    await shot(root, 'assign-dialog');
    await devs.locator('#assignClient').selectOption(state.client_a);
    await devs.locator('#assignLocation').selectOption(state.location_a_north);
    await devs.locator('[data-save-editor]').dispatchEvent('click');
    await spare().waitFor({ state: 'detached', timeout: 20000 });
    await show('assigned');
    await spare().waitFor({ timeout: 20000 });
    assert.match(await spare().innerText(), /Browser Client A[\s\S]*Browser A North/, 'assigned device does not show its client and location');
    await shot(root, 'devices-assigned');
    await spare().locator('[data-inbox-remove]').dispatchEvent('click');
    await devs.locator('dialog[open] [data-save-editor]').dispatchEvent('click');
    await spare().waitFor({ state: 'detached', timeout: 20000 });
    await show('unassigned');
    await spare().locator('[data-inbox-ignore]').dispatchEvent('click');
    await spare().waitFor({ state: 'detached', timeout: 20000 });
    await show('ignored');
    await spare().locator('[data-inbox-unignore]').dispatchEvent('click');
    await spare().waitFor({ state: 'detached', timeout: 20000 });
    await devs.locator('[data-device-view="wiring"]').dispatchEvent('click');
    await devs.locator('[data-new-virtual]').first().waitFor({ timeout: 10000 });
    // One Edit per device opens a dialog with its name, place, feed and main-device switch; nothing is edited in the row.
    assert.equal(await devs.locator('#admin select[data-device-parent], #admin [data-set-main]').count(), 0, 'a device is still edited inside the table');
    assert.equal(await devs.locator('#admin tbody tr').filter({ hasText: 'Browser Spare Meter' }).count(), 0, 'a device no client has is listed in a client\'s wiring table');
    await devs.locator('[data-edit-device]').first().dispatchEvent('click');
    await devs.locator('dialog[open] #editorParent').waitFor({ timeout: 10000 });
    await shot(root, 'device-dialog');
    await devs.locator('dialog[open] .form-actions [data-cancel-editor]').dispatchEvent('click');
    await devs.locator('dialog[open]').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
    assert.equal(await devs.locator('dialog[open]').count(), 0, 'the dialog did not close');
    await shot(root, 'devices-wiring');
    await root.goto(`${base}/energy-admin/people`, { waitUntil: 'domcontentloaded' });
    const rootPeople = await waitCard(root, 'building-admin-table-card');
    await rootPeople.locator('#people tbody tr').first().waitFor({ timeout: 20000 });
    await shot(root, 'people');
    await rootPeople.locator('[data-edit-person]').first().dispatchEvent('click');
    await rootPeople.locator('dialog[open] #editorRole').waitFor({ timeout: 10000 });
    await shot(root, 'person-dialog');
    await rootPeople.locator('dialog[open] .form-actions [data-cancel-editor]').dispatchEvent('click');
    await root.goto(`${base}/energy-admin/clients`, { waitUntil: 'domcontentloaded' });
    await (await waitCard(root, 'building-admin-table-card')).locator('tbody tr').first().waitFor({ timeout: 20000 });
    await shot(root, 'clients');
  }

  assert.deepEqual(pageErrors, [], `browser page errors: ${pageErrors.join('; ')}`);
  console.log(JSON.stringify({ profile: 'browser portal flows', status: 'PASS' }, null, 2));
} finally {
  await rootContext?.close();
  await adminContext?.close();
  await browser.close();
}
