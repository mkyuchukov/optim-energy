// Run: node test_schedule.js
const assert = require('assert');
const { scheduleConfig, daysText } = require('../../custom_components/optim_energy/frontend/building-cards.js');
const days = ['mon', 'tue', 'wed', 'thu', 'fri'];
const fresh = scheduleConfig(null, { alias: 'A', how: 'on', at: '07:30', days, switches: ['switch.a'] });
assert.deepStrictEqual(fresh.triggers, [{ trigger: 'time', at: '07:30:00' }]);
assert.deepStrictEqual(fresh.conditions, [{ condition: 'time', weekday: days }]);
assert.deepStrictEqual(fresh.actions, [{ action: 'switch.turn_on', target: { entity_id: ['switch.a'] } }]);
// Editing sets exactly the switches chosen and keeps anything else in the automation.
const base = { id: 'x', alias: 'Old', description: 'Copied', mode: 'single', actions: [{ action: 'switch.turn_off', target: { entity_id: ['switch.keep'] } }, { delay: 5 }, { action: 'switch.turn_off', target: { entity_id: ['switch.second'] } }] };
const edit = scheduleConfig(base, { alias: 'Old', how: 'on', at: '18:30', days: ['mon','tue','wed','thu','fri','sat','sun'], switches: ['switch.a', 'switch.b'] });
assert.deepStrictEqual(edit.conditions, []);
assert.strictEqual(edit.id, 'x'); assert.strictEqual(edit.description, 'Copied');
assert.deepStrictEqual(edit.actions, [{ action: 'switch.turn_on', target: { entity_id: ['switch.a', 'switch.b'] } }, { delay: 5 }]);
assert.strictEqual(daysText(undefined), 'Every day');
assert.strictEqual(daysText(days), 'Mon to Fri');
assert.strictEqual(daysText(['sat', 'sun']), 'Weekends');
assert.strictEqual(daysText(['mon', 'wed']), 'Mon, Wed');
console.log('ok');
// A kept device stays out of what a group's tile and All off act on, and is still in its group.
const m = require('../../custom_components/optim_energy/frontend/building-cards.js');

// Administration can see an unassigned portal device, but not service pseudo-devices or channel children.
const adminCatalog = m.adminDeviceCatalog(
  [
    { id: 'placed', labels: [] },
    { id: 'bridge_child', labels: [], via_device_id: 'bridge' },
    { id: 'unassigned', labels: ['light'], entry_type: null },
    { id: 'platform', labels: [], entry_type: null },
    { id: 'child', labels: [], via_device_id: 'placed' },
    { id: 'service', labels: [], entry_type: 'service' },
  ],
  [
    { device_id: 'placed', platform: 'shelly', entity_id: 'sensor.parent_power' },
    { device_id: 'bridge_child', platform: 'mqtt', entity_id: 'sensor.office_power' },
    { device_id: 'platform', platform: 'shelly', entity_id: 'sensor.load_power' },
  ],
  { placed: 'loc:a' },
);
assert.deepStrictEqual(adminCatalog.map((d) => d.id), ['placed', 'bridge_child', 'unassigned', 'platform']);
console.log('admin devices ok');
m.setTree({ places: [{ id: 'loc', name: 'L', kind: 'location' }], placed: {}, kinds: { a: 'lights', w: 'relay' }, kept: ['w'] });
m.setLocation('loc');
m.DEVICES.push({ id: 'a', name: 'A', switch: 'switch.a', place: 'loc' }, { id: 'w', name: 'W', switch: 'switch.w', place: 'loc' });
const sp = { id: 'loc', level: 'all' };
assert.deepStrictEqual(m.groupSwitches(sp).map((d) => d.id), ['a']);
assert.deepStrictEqual(m.liveSwitches(sp, { 'switch.a': { state: 'unavailable' }, 'switch.w': { state: 'on' } }), []);
console.log('kept ok');
// Until an admin saves a choice, a name that is plainly not a light is kept out of All off.
m.setTree({ places: [{ id: 'loc', name: 'L', kind: 'location' }], placed: {} });
assert.strictEqual(m.isKept({ id: 'x', name: 'ACME Water machine', switch: 's' }), true);
assert.strictEqual(m.isKept({ id: 'y', name: 'ACME Hallway NE', switch: 's' }), true, 'an untyped switch is never treated as a light');
m.setTree({ places: [{ id: 'loc', name: 'L', kind: 'location' }], placed: {}, kinds: { x: 'lights' } });
assert.strictEqual(m.isKept({ id: 'x', name: 'ACME Water machine', switch: 's' }), false, 'an admin choice wins over the name');
// What Home Assistant says decides before the name does.
const hk = { devices: { d: { id: 'd' } }, entities: { 'switch.s': { entity_id: 'switch.s', device_id: 'd' } }, states: { 'switch.s': { state: 'on', attributes: { device_class: 'outlet' } } } };
assert.strictEqual(m.guessControls(hk, 'd', 'switch.s', 'Hall'), 'socket');
assert.strictEqual(m.guessControls({ ...hk, entities: { ...hk.entities, 'climate.a': { entity_id: 'climate.a', device_id: 'd' } } }, 'd', 'switch.s', 'Hall'), 'ac');
assert.strictEqual(m.guessControls({ ...hk, states: {} }, 'd', 'switch.s', 'Boiler'), 'relay');
assert.strictEqual(m.guessControls({ ...hk, states: {} }, 'd', 'switch.s', 'Hall NE'), 'relay', 'a switch needs a light entity or an explicit Light label');
assert.strictEqual(m.guessControls({ ...hk, entities: { ...hk.entities, 'light.hall': { entity_id: 'light.hall', device_id: 'd' } }, states: {} }, 'd', 'switch.s', 'Hall'), 'lights', 'a real light entity is still a light');
assert.strictEqual(m.guessControls(hk, 'd', undefined, 'Meter'), 'meter');
assert.strictEqual(m.kindOf({ id: 'z', name: 'Hall', switch: 'switch.z', guess: 'socket' }), 'socket');
assert.strictEqual(m.kindOf({ id: 'u', name: 'Hallway', switch: 'switch.u' }), 'relay', 'without a type, a switch defaults to relay');
assert.strictEqual(m.kindOf({ id: 'q', name: 'Main Meter' }), 'meter', 'no relay means a meter');
m.setTree({ places: [], placed: {}, kinds: { o: 'appliance', n: 'none' } });
assert.strictEqual(m.kindOf({ id: 'o', name: 'X', switch: 's' }), 'relay'); assert.strictEqual(m.kindOf({ id: 'n', name: 'X', switch: 's' }), 'meter');
assert.strictEqual(m.typeLabel({ id: 'q', name: 'Main Meter' }), 'Energy meter');
console.log('names ok');
// Names drop what the location and the group already say, and two lights never read the same.
const every = ['ACME Hallway NE', 'ACME Hallway NW', 'ACME room 401', 'ACME room 402', 'ACME Kitchen', 'ACME Water machine'];
assert.deepStrictEqual(m.shortNames(['ACME Hallway NE', 'ACME Hallway NW'], every), ['NE', 'NW']);
assert.deepStrictEqual(m.shortNames(['ACME room 401', 'ACME room 402'], every), ['Room 401', 'Room 402']);
assert.deepStrictEqual(m.shortNames(['ACME Kitchen'], every), ['Kitchen']);
assert.deepStrictEqual(m.shortNames(['Corridor'], ['Corridor', 'Office']), ['Corridor']);
console.log('short names ok');
// Rooms never overlap and every light sits inside its room.
const L = (n) => Array.from({ length: n }, (_, i) => ({ id: `l${i}` }));
const laid = m.layoutRooms([{ id: 'a', lights: L(1) }, { id: 'b', lights: L(4) }, { id: 'c', lights: L(1) }, { id: 'd', lights: L(6) }, { id: 'e', lights: L(10) }, { id: 'f', lights: [] }]);
for (const r of laid) {
  for (const l of r.spots) assert.ok(l.x > r.x0 && l.x < r.x1 && l.y > r.y0 && l.y < r.y1, `light outside ${r.id}`);
  for (const o of laid) if (o !== r) assert.ok(r.x1 <= o.x0 || o.x1 <= r.x0 || r.y1 <= o.y0 || o.y1 <= r.y0, `${r.id} overlaps ${o.id}`);
}
console.log('3d layout ok');
// A removed switch leaves an automation; an automation left with nothing to switch is marked for deletion.
const auto = { actions: [{ action: 'switch.turn_off', target: { entity_id: ['switch.k', 'switch.h'] } }, { delay: 5 }] };
console.log('forget ok');
// An hour with no power reading is a gap; a device silent for over two hours is still out.
const H = 3600000, t0 = Date.UTC(2026, 10, 5, 0);
const rows = [0, 1, 2, 5, 6].map((h) => ({ start: t0 + h * H }));
assert.deepStrictEqual(m.statGaps(rows, t0 + 7 * H), [{ from: t0 + 3 * H, to: t0 + 5 * H }]);
const out = m.statGaps(rows, t0 + 10 * H);
assert.strictEqual(out.length, 2); assert.strictEqual(out[1].active, true);
assert.deepStrictEqual(m.cfgSwitches({ actions: [{ action: 'switch.turn_off', target: { entity_id: ['switch.a', 'switch.b'] } }, { action: 'light.turn_on', target: { entity_id: 'light.x' } }, { delay: 1 }] }), ['switch.a', 'switch.b']);
console.log('gaps ok');
// Catch-up after an outage is spread over the missing hours; a normal hour and an impossible jump are left as they are.
const T0 = Date.UTC(2026, 10, 5, 0), Hr = 3600000;
const pw = [0, 1, 5, 6].map((h) => ({ start: T0 + h * Hr, max: 2000 }));
const en = [{ start: T0, change: 1 }, { start: T0 + Hr, change: 1.5 }, { start: T0 + 5 * Hr, change: 8, state: 100 }, { start: T0 + 6 * Hr, change: 1 }];
const spr = m.spreadCatchUp(en, pw);
assert.strictEqual(spr.length, 7, 'three missing hours plus the first back');
assert.ok(Math.abs(spr.reduce((t, r) => t + r.change, 0) - 11.5) < 1e-9, 'no energy lost');
assert.strictEqual(spr.find((r) => +new Date(r.start) === T0 + 5 * Hr).state, 100, 'the reading stays on the row it came from');
assert.deepStrictEqual(m.spreadCatchUp([{ start: T0 + 5 * Hr, change: 500 }], pw), [{ start: T0 + 5 * Hr, change: 500 }], 'impossible jump left for the spike filter');
console.log('catch-up ok');
// Sites from Home Assistant: a map-pin label is a location, its areas are groups, a floor holding them is the group above.
const labs = [{ label_id: 'sofia', name: '📍 Example Site', icon: 'mdi:map-marker' }, { label_id: 'plovdiv', name: 'Other Site', icon: 'mdi:map-marker-outline' }, { label_id: 'energy_meter', name: 'energy-meter', icon: null }];
const floors = [{ floor_id: 'f1', name: 'Floor 1' }, { floor_id: 'f9', name: 'Unused' }];
const areas = [{ area_id: 'hall', name: 'Hallway', labels: ['sofia'], floor_id: 'f1' }, { area_id: 'kit', name: 'Kitchen', labels: ['sofia'] }, { area_id: 'pd', name: 'Shop', labels: ['plovdiv'] }, { area_id: 'loose', name: 'Garage', labels: [] }];
const nat = m.nativePlaces(labs, floors, areas);
assert.deepStrictEqual(nat.places.map((x) => `${x.id}<${x.parent}`), ['loc:sofia<null', 'loc:plovdiv<null', 'floor:f1<loc:sofia', 'area:hall<floor:f1', 'area:kit<loc:sofia', 'area:pd<loc:plovdiv']);
assert.strictEqual(nat.places[0].name, 'Example Site', 'the pin is not part of the name');
const devs = { a: { id: 'a', area_id: 'hall' }, b: { id: 'b', labels: ['plovdiv'] }, c: { id: 'c', area_id: 'loose' }, d: { id: 'd', area_id: 'kit', disabled_by: 'user' }, e: { id: 'e', area_id: 'pd', labels: ['exclude_from_portal'] }, f: { id: 'f', area_id: 'kit', labels: ['plovdiv'], name: 'F' } };
assert.deepStrictEqual(m.nativePlaced(devs, nat), { a: 'area:hall', b: 'loc:plovdiv', f: 'area:kit' });
assert.strictEqual(m.nativePlaces([{ label_id: 'x', name: 'x' }], [], []), null, 'no location label: the portal keeps its own');
assert.deepStrictEqual(m.nativeProblems({ ...devs, g: { id: 'g', area_id: 'loose', name: 'G' } }, nat).length, 2);
console.log('native sites ok');
// Automations come from Home Assistant by area or 📍 label; a timed switch one is read as a schedule, anything else is listed as made in Home Assistant.
const cfg = { triggers: [{ trigger: 'time', at: '18:30:00' }], conditions: [{ condition: 'time', weekday: ['fri', 'mon'] }], actions: [{ action: 'switch.turn_off', target: { entity_id: ['switch.a'] } }] };
assert.deepStrictEqual(m.parseSchedule(cfg), { at: '18:30', how: 'off', days: ['mon', 'fri'] });
assert.strictEqual(m.parseSchedule({ triggers: [{ trigger: 'state', entity_id: 'x' }], actions: [{ action: 'switch.turn_on' }] }), null);
const ents = { 'automation.a': { entity_id: 'automation.a', area_id: 'hall' }, 'automation.b': { entity_id: 'automation.b', labels: ['plovdiv'] }, 'automation.c': { entity_id: 'automation.c', area_id: 'loose' }, 'sensor.x': { entity_id: 'sensor.x', area_id: 'hall' } };
const sts = { 'automation.b': { attributes: { friendly_name: 'Motion' } } };
const asAdmin = m.nativeAutomations(ents, sts, nat, [{ entity: 'automation.a', at: '07:00' }], { 'automation.a': cfg, 'automation.b': { triggers: [{ trigger: 'state' }] } });
assert.deepStrictEqual(asAdmin.map((a) => [a.entity, a.place, a.at, a.custom]), [['automation.a', 'area:hall', '18:30', false], ['automation.b', 'loc:plovdiv', undefined, true]]);
const asUser = m.nativeAutomations(ents, sts, nat, [{ entity: 'automation.a', at: '07:00' }], {});
assert.deepStrictEqual(asUser.map((a) => [a.at, a.custom]), [['07:00', false], [undefined, true]], 'without settings: the time last saved, or made in HA');
const natK = m.nativePlaces([...labs, { label_id: 'sock', name: 'Socket' }, { label_id: 'em', name: 'Energy meter' }], floors, areas);
assert.deepStrictEqual(natK.kinds, { sock: 'socket', em: 'meter' });
console.log('native automations and types ok');
// A virtual device is a Sum helper of the real devices it adds up; a deleted one's helpers go.
const plan = m.sumPlan({ virtual: [{ id: 'virt:a', name: 'A' }, { id: 'virt:far', name: 'Far' }], sums: { 'virt:gone': { energy: { entry: 'e1' }, power: { entry: 'e2' } }, 'virt:far': { energy: { entry: 'e3' } } } },
  [{ id: 'virt:a' }], () => [{ energy: 'sensor.b_e', power: 'sensor.b_p' }, { energy: 'sensor.a_e', power: null }, { energy: 'sensor.a_e' }]);
assert.deepStrictEqual(plan.want, { 'virt:a': { name: 'A', energy: ['sensor.a_e', 'sensor.b_e'], power: ['sensor.b_p'] } }, 'another location is left alone');
assert.deepStrictEqual(plan.drop, ['e1', 'e2']);
console.log('sums ok');
// A tab that opens without a location still gets the location's main device once one is chosen.
m.setLocation(null); m.setTree({ mains: { 'loc:a': 'virt:top' }, places: [{ id: 'loc:a', name: 'A', kind: 'location', parent: null }] });
assert.strictEqual(m.TREE.main, null);
m.setLocation('loc:a');
assert.strictEqual(m.TREE.main, 'virt:top', 'main follows the location');
console.log('main ok');
// An automation shows its own name, without the location it is saved under.
m.setTree({ places: [{ id: 'loc:a', name: 'Example Site', kind: 'location', parent: null }, { id: 'area:h', name: 'Hallway', kind: 'group', parent: 'loc:a' }] });
assert.strictEqual(m.autoTitle({ name: 'Example Site: Lights off at night', place: 'area:h' }), 'Lights off at night');
assert.strictEqual(m.autoTitle({ name: 'Turn off Rooms', place: 'area:h' }), 'Turn off Rooms');
assert.strictEqual(m.autoTitle({ place: 'area:h' }), 'Hallway', 'no name yet: its group');
console.log('names of automations ok');
// Each run of an automation, with the switches it changed in the same go.
const runs = m.autoRuns([
  { entity_id: 'automation.a', message: 'triggered by time', when: 1000, context_id: 'c1', source: 'time' },
  { entity_id: 'switch.x', state: 'off', when: 1001, context_id: 'c1', context_event_type: 'automation_triggered' },
  { entity_id: 'switch.y', state: 'off', when: 1001, context_id: 'other' },
  { entity_id: 'automation.a', message: 'triggered by time', when: 2000, context_id: 'c2' },
], [{ entity: 'automation.a' }]);
assert.deepStrictEqual(runs.map((r) => [r.at, r.changed.map((c) => c.entity)]), [[2000000, []], [1000000, ['switch.x']]]);
console.log('runs ok');
const runs2 = m.autoRuns([{ entity_id: 'automation.a', message: 'triggered by time', when: 5000, context_id: 'k' }, { entity_id: 'switch.z', state: 'on', when: 5002, context_entity_id: 'automation.a' }], [{ entity: 'automation.a' }]);
assert.deepStrictEqual(runs2[0].changed, [{ entity: 'switch.z', state: 'on' }], 'named as the cause');
console.log('runs by cause ok');
// An alert rule's automation tells the chosen targets when it turns on, and takes the HA notification away when it turns off.
const ra = m.ruleAutomation('binary_sensor.main_meter_power_above_50_kw', 'Main Meter Power above 50 kW', 'sensor.main_meter_power', 'W', 'critical', ['persistent_notification', 'mobile_app_iphone']);
assert.strictEqual(ra.alias, 'Portal alert: Main Meter Power above 50 kW');
assert.deepStrictEqual(ra.triggers.map((t) => [t.from, t.to]), [['off', 'on'], ['on', 'off']]);
assert.deepStrictEqual(m.ruleTargets(ra), ['persistent_notification', 'mobile_app_iphone'], 'who it tells is read back from it');
assert.ok(ra.actions[0].choose[0].sequence[0].data.message.startsWith('Critical: '));
assert.strictEqual(ra.actions[0].default[0].action, 'persistent_notification.dismiss');
assert.strictEqual(m.ruleAutoId('binary_sensor.x_y'), 'portal_alert_x_y');
console.log('rule automation ok');
// A location's price: fixed as entered; exchange sensor (€/MWh or €/kWh) plus extra, plus VAT; otherwise the helper.
const stP = { 'input_number.client_tariff': { state: '0.25' }, 'sensor.bg_price': { state: '200', attributes: { unit_of_measurement: '€/MWh' } }, 'sensor.off': { state: 'unavailable', attributes: { unit_of_measurement: '€/kWh' } } };
m.setTree({ prices: { 'loc:a': { mode: 'fixed', fixed: 0.3 }, 'loc:b': { mode: 'bill', bill: 0.31 }, 'loc:c': { mode: 'exchange', sensor: 'sensor.bg_price', extra: 0.05 }, 'loc:d': { mode: 'exchange', sensor: 'sensor.bg_price', extra: 0.05, vat: false }, 'loc:e': { mode: 'exchange', sensor: 'sensor.off' } } });
const hP = { states: stP };
assert.strictEqual(m.priceOf(hP, 'loc:a'), 0.3);
assert.strictEqual(m.priceOf(hP, 'loc:b'), 0.31, 'a bill price is stored all-in');
assert.strictEqual(m.vatNote(m.priceRule(hP, 'loc:b')), 'incl. VAT');
const hx = { states: { ...stP, 'sensor.entsoe': { state: '0.2', attributes: { unit_of_measurement: '€/kWh' } } }, entities: { 'sensor.entsoe': { platform: 'entsoe' } } };
m.setTree({ prices: { 'loc:b': { mode: 'bill', bill: 0.31 } } });
const forced = m.priceRule(hx, 'loc:b', 'exchange');
assert.strictEqual(forced.mode, 'exchange'); assert.strictEqual(forced.sensor, 'sensor.entsoe'); assert.ok(Math.abs(forced.now - 0.24) < 1e-9);
m.setTree({ prices: { 'loc:a': { mode: 'fixed', fixed: 0.3 }, 'loc:b': { mode: 'bill', bill: 0.31 }, 'loc:c': { mode: 'exchange', sensor: 'sensor.bg_price', extra: 0.05 }, 'loc:d': { mode: 'exchange', sensor: 'sensor.bg_price', extra: 0.05, vat: false }, 'loc:e': { mode: 'exchange', sensor: 'sensor.off' } } });
assert.ok(Math.abs(m.priceOf(hP, 'loc:c') - 0.3) < 1e-9, '(0.200 + 0.05) × 1.2');
assert.ok(Math.abs(m.priceOf(hP, 'loc:d') - 0.25) < 1e-9, 'no VAT');
assert.strictEqual(m.priceOf(hP, 'loc:e'), 0.25, 'no reading: the helper');
assert.strictEqual(m.priceOf(hP, 'loc:x'), 0.25, 'no setting: the helper');
assert.deepStrictEqual(m.treeWithPrice({ prices: { 'loc:a': { mode: 'fixed' } } }, 'loc:a', { mode: '' }).prices, {}, 'back to the helper');
m.setTree({ prices: { 'loc:m': { mode: 'exchange', sensor: 'sensor.bg_price', extra: 0.05, fixed: 0.4, fixedSource: { kind: 'typed' }, bill: 0.31, billSource: { kind: 'bill' } } } });
const switched = m.treeWithPrice(m.TREE, 'loc:m', { mode: 'fixed' });
assert.strictEqual(switched.prices['loc:m'].mode, 'fixed');
assert.strictEqual(switched.prices['loc:m'].extra, 0.05, 'switching keeps the IBEX margin');
assert.strictEqual(switched.prices['loc:m'].bill, 0.31, 'switching keeps the bill price');
console.log('prices ok');
// Each hour at its own price: the hour's 15-minute exchange prices, plus extra, plus VAT; no exchange price means one flat price.
(async () => {
  const H = 3600000, h0 = Date.UTC(2026, 10, 9, 10), iso = (t) => new Date(t).toISOString();
  const states = {
    'input_number.client_tariff': { state: '0.2' },
    'sensor.cur': { state: '0.3', attributes: { unit_of_measurement: '€/kWh' } },
    'sensor.avg': { state: '0.3', attributes: { prices_today: [0, 1, 2, 3].map((i) => ({ time: iso(h0 + i * 900000), price: 0.1 * (i + 1) })), prices_tomorrow: [] } },
  };
  const hass = { states, config: { time_zone: 'UTC' }, callWS: async () => ({}) };
  m.setTree({ prices: { 'loc:x': { mode: 'exchange', sensor: 'sensor.cur', extra: 0.05 } } });
  const at = await m.priceSeries(hass, h0 - H, h0 + H, 'loc:x');
  assert.ok(at.varies);
  assert.ok(Math.abs(at(h0 + 1000) - (0.25 + 0.05) * 1.2) < 1e-9, 'average of the four quarters 0.1..0.4, plus extra, plus VAT');
  assert.ok(Math.abs(at(h0 - 2 * H) - (0.3 + 0.05) * 1.2) < 1e-9, 'no price for that hour: the price now');
  m.setTree({ prices: { 'loc:x': { mode: 'bill', bill: 0.31 } } });
  const billFlat = await m.priceSeries(hass, 0, 1, 'loc:x');
  assert.strictEqual(billFlat.varies, false); assert.strictEqual(billFlat(h0), 0.31);
  m.setTree({ prices: {} });
  const flat = await m.priceSeries(hass, 0, 1, 'loc:x');
  assert.strictEqual(flat.varies, false); assert.strictEqual(flat(h0), 0.2);
  // Totals add each hour at its price.
  const tot = m.combineTotals([{ energy: [{ start: h0 - H, change: 2 }, { start: h0 - 2 * H, change: 1 }], power: [], energyPts: [], liveW: 0, lastPowerUpdate: h0 }], h0 + 1000, 'UTC', (t) => (t === h0 - H ? 0.5 : 0.1));
  assert.ok(Math.abs(tot.todayEur - (2 * 0.5 + 1 * 0.1)) < 1e-9);
  console.log('hourly prices ok');
})().catch((e) => { console.error(e); process.exit(1); });
// One price rule everywhere: the label says whether VAT is in, and a missing exchange reading falls back to the helper, said so.
{
  const st = { 'input_number.client_tariff': { state: '0.25' }, 'sensor.x': { state: '0.2', attributes: { unit_of_measurement: '€/kWh' } }, 'sensor.dead': { state: 'unavailable', attributes: { unit_of_measurement: '€/kWh' } } };
  m.setTree({ prices: { 'loc:f': { mode: 'fixed', fixed: 0.3 }, 'loc:b': { mode: 'bill', bill: 0.31 }, 'loc:e': { mode: 'exchange', sensor: 'sensor.x', extra: 0.05 }, 'loc:n': { mode: 'exchange', sensor: 'sensor.x', vat: false }, 'loc:d': { mode: 'exchange', sensor: 'sensor.dead' } } });
  const h = { states: st };
  assert.strictEqual(m.priceOf(h, 'loc:b'), 0.31, 'a bill price is stored all-in');
  assert.strictEqual(m.vatNote(m.priceRule(h, 'loc:b')), 'incl. VAT');
  assert.strictEqual(m.vatNote(m.priceRule(h, 'loc:f')), 'incl. VAT');
  assert.strictEqual(m.vatNote(m.priceRule(h, 'loc:e')), 'incl. VAT');
  assert.strictEqual(m.vatNote(m.priceRule(h, 'loc:n')), 'excl. VAT');
  assert.strictEqual(m.vatNote(m.priceRule(h, 'loc:z')), 'VAT not stated');
  const dead = m.priceRule(h, 'loc:d'); assert.ok(dead.missing && dead.now === 0.25 && m.vatNote(dead) === 'VAT not stated');
  // The charts' hour and day prices add up to the totals.
  const t = { priceAt: (ms) => (ms === 100 ? 0.5 : 0.2), hourStarts: new Map([[3, 100]]), dayKwh: new Map([['2026-11-09', 4]]), dayEur: new Map([['2026-11-09', 1.2]]) };
  const cp = m.chartPrice(t, 0.9);
  assert.strictEqual(cp.hour(3), 0.5); assert.strictEqual(cp.hour(7), 0.9); assert.ok(Math.abs(cp.day('2026-11-09') - 0.3) < 1e-9);
  m.setTree({ prices: { 'loc:x': { mode: 'exchange', sensor: 'sensor.bg_price', extra: 0 } } }); m.setLocation('loc:x');
  const priceChart = m.pricePanel({ states: { 'input_number.client_tariff': { state: '0.25' }, 'sensor.bg_price': { state: '200', attributes: { unit_of_measurement: '€/MWh', prices_today: [{ time: '2026-11-10 12:00:00+00:00', price: 200 }] } } }, config: { time_zone: 'UTC' } }, 600, Date.UTC(2026, 10, 10, 11, 59));
  assert.match(priceChart, /chart-src/); assert.match(priceChart, />IBEX</);
  console.log('one price rule ok');
}
// Reading a bill: the reader's JSON, leva into euros, ENTSO-e's answer in either shape, and the extra weighted by use.
{
  const b = m.parseBill('```json\n{"period_from":"2026-10-01","period_to":"2026-10-31","currency":"BGN","kwh":"1000","total_excl_vat":391.166,"lines":[{"name":"Енергия","amount_excl_vat":195.583},{"name":"Мрежа","amount_excl_vat":195.583}]}\n```');
  assert.ok(b.fromBgn && Math.abs(b.total_excl_vat - 200) < 1e-9 && b.kwh === 1000 && Math.abs(b.lines[0].amount_excl_vat - 100) < 1e-9);
  assert.throws(() => m.parseBill('sorry, no'));
  assert.throws(() => m.parseBill('{"kwh":null,"notes":"a sample"}'), /a sample/);
  assert.throws(() => m.parseBill('{"kwh":100,"total_excl_vat":30,"period_from":"2026-11-01","period_to":"2026-11-30"}'), /currency/i, 'a missing currency is not assumed to be euros');
  assert.throws(() => m.parseBill('{"currency":"USD","kwh":100,"total_excl_vat":30,"period_from":"2026-11-01","period_to":"2026-11-30"}'), /currency/i, 'an unknown currency is rejected');
  assert.strictEqual(m.parseBill('{"currency":"EUR","kwh":100,"total_excl_vat":30,"period_from":"2026-11-01","period_to":"2026-11-30"}').currency, 'EUR');
  const H = 3600000, t0 = Date.UTC(2026, 9, 1);
  assert.deepStrictEqual(m.exchangeRows({ prices: [{ timestamp: '2026-10-01 00:00:00+00:00', price: 300 }] }), [{ t: t0, p: 0.3 }], '€/MWh into €/kWh');
  assert.deepStrictEqual(m.exchangeRows({ '2026-10-01T00:00:00+00:00': 0.3 }), [{ t: t0, p: 0.3 }], 'time -> price');
  // Two hours: 0.10 and 0.30 (two quarters each); the location used 3 kWh in the cheap one and 1 in the dear one.
  const prices = [{ t: t0, p: 0.1 }, { t: t0 + 15 * 60000, p: 0.1 }, { t: t0 + H, p: 0.2 }, { t: t0 + H + 15 * 60000, p: 0.4 }];
  const x = m.billExtra({ kwh: 1000, total_excl_vat: 200, lines: b.lines }, prices, new Map([[t0, 3], [t0 + H, 1]]));
  assert.ok(x.weighted && Math.abs(x.avg - (3 * 0.1 + 1 * 0.3) / 4) < 1e-9 && Math.abs(x.perKwh - 0.2) < 1e-9 && Math.abs(x.extra - 0.05) < 1e-9 && x.linesOk);
  const plain = m.billExtra({ kwh: 1000, total_excl_vat: 300, lines: b.lines }, prices);
  assert.ok(!plain.weighted && Math.abs(plain.avg - 0.2) < 1e-9 && !plain.linesOk && plain.meterOff === null);
  assert.strictEqual(m.dayStartMs('2026-10-01', 'Europe/Sofia'), Date.UTC(2026, 8, 30, 21), 'Sofia is UTC+3 in October');
  assert.strictEqual(m.dayStartMs('2026-11-01', 'Europe/Sofia'), Date.UTC(2026, 9, 31, 22), 'and UTC+2 after the clocks go back');
  console.log('bill reading ok');
}
// A bill gives two prices: fixed (all in, VAT included) and the margin over IBEX; the contract kind comes from the reader, else from the lines.
{
  const bill = { kwh: 1000, total_excl_vat: 300, total_incl_vat: 360, lines: [{ name: 'Енергия' }] };
  const pr = m.billPrices(bill, { extra: 0.12 });
  assert.ok(Math.abs(pr.fixed - 0.36) < 1e-9 && pr.extra === 0.12);
  assert.ok(Math.abs(m.billPrices({ kwh: 100, total_excl_vat: 30 }, null).fixed - 0.36) < 1e-9, 'no total with VAT: 20% added');
  assert.ok(Math.abs(m.billPrices({ kwh: 100, total_excl_vat: 50, vat: 12 }, null).fixed - 0.62) < 1e-9, 'use the VAT amount printed on the bill');
  assert.strictEqual(m.billPrices({ kwh: 0, total_incl_vat: 10 }, null).fixed, null);
  assert.strictEqual(m.billKind({ pricing: 'exchange', lines: [] }), 'exchange');
  assert.strictEqual(m.billKind({ pricing: null, lines: [{ name: 'Енергия по борсова цена' }] }), 'exchange');
  assert.strictEqual(m.billKind({ pricing: null, lines: [{ name: 'Активна енергия' }] }), 'fixed');
  console.log('bill prices ok');
}

// A bill with more pages than the configured maximum is rejected, not silently truncated.
(async () => {
  const files = Array.from({ length: 5 }, (_, i) => ({ name: `page-${i + 1}.png`, type: 'image/png' }));
  await assert.rejects(m.billPages(files, { max_pages: 4 }), /at most 4 pages/i);
  console.log('bill page limit ok');
})().catch((e) => { console.error(e); process.exit(1); });

// A device from another provider: nothing is named the Zigbee2MQTT way, and it has more than one energy sensor.
{
  m.setLocation(null);
  m.setTree({ places: [], placed: {} });
  const hass = {
    devices: { plug: { id: 'plug', name: 'Kettle plug', manufacturer: 'Tuya', model: 'TS011F', labels: ['energy_meter'] }, hub: { id: 'hub', name: 'Hub', labels: ['energy_meter'] } },
    entities: {
      'switch.kettle': { entity_id: 'switch.kettle', device_id: 'plug', platform: 'tuya' },
      'switch.kettle_child_lock': { entity_id: 'switch.kettle_child_lock', device_id: 'plug', platform: 'tuya', entity_category: 'config' },
      'sensor.kettle_current_consumption': { entity_id: 'sensor.kettle_current_consumption', device_id: 'plug', platform: 'tuya', device_class: 'power' },
      'sensor.kettle_today': { entity_id: 'sensor.kettle_today', device_id: 'plug', platform: 'tuya', device_class: 'energy' },
      'sensor.kettle_total': { entity_id: 'sensor.kettle_total', device_id: 'plug', platform: 'tuya', device_class: 'energy' },
      'sensor.hub_uptime': { entity_id: 'sensor.hub_uptime', device_id: 'hub', platform: 'tuya', device_class: 'duration' },
    },
    states: { 'sensor.kettle_today': { attributes: { state_class: 'measurement' } }, 'sensor.kettle_total': { attributes: { state_class: 'total_increasing' } }, 'switch.kettle': { attributes: { device_class: 'outlet' } } },
  };
  m.syncModel(hass);
  const plug = m.DEVICES.find((d) => d.id === 'plug');
  assert.ok(plug, 'a metered device from another provider is not in the portal');
  assert.strictEqual(plug.power, 'sensor.kettle_current_consumption');
  assert.strictEqual(plug.energy, 'sensor.kettle_total');
  assert.strictEqual(plug.switch, 'switch.kettle');
  assert.strictEqual(m.kindOf(plug), 'socket');
  assert.ok(!m.DEVICES.some((d) => d.id === 'hub'), 'a device with no power or energy sensor is shown as a meter');
  m.DEVICES.length = 0;
  console.log('any provider ok');
}
