// The cards of the energy app: one sidebar screen each, with tabs. No dependencies.
const BRIDGE = 'binary_sensor.zigbee2mqtt_bridge_connection_state';
const TARIFF = 'input_number.client_tariff';
// A meter with no new reading for this long counts as silent, on every page.
const STALE_MIN = 15;

// Things Home Assistant has no device for. Meters and floors are added from its registries by syncModel.
const STATIC_DEVICES = [
  { id: 'coord', name: 'Zigbee coordinator', type: 'Network', model: 'Sonoff Dongle-M, Ethernet', floor: 'Floor 5', space: 'Not set', link: true },
];

const DEVICES = [...STATIC_DEVICES];
const PORTAL_PATH = 'energy-home';
// How devices are wired, kept in the Home dashboard's settings because Home Assistant has no place for it.
// parents: device id -> the device it is fed from. virtual: devices that are the sum of the devices under them.
// places: locations and the groups inside them, nested to any depth. placed: device id -> the place it is in.
// mains: location id -> its main device. main is the current location's.
// automations: Home Assistant automations shown in a location, each { entity, name, at, place, devices }.
// alarms: rules an admin made, each { id, device, kind, op, value, minutes, sev, entity, entry }. Home Assistant runs them as template helpers.
const TREE = { main: null, mains: {}, parents: {}, virtual: [], known: null, places: [], placed: {}, automations: [], alarms: [], kept: null, kinds: {}, notify: {}, sums: {}, prices: {} };
let nodeIds = new Set(), allNodes = [];
// The location being viewed. Locations act like tenants: every page shows only the chosen one.
// ponytail: this is what is shown, not a security boundary. Any logged-in user can still read everything in Home Assistant.
const LOCATION_KEY = 'portalLocation', CLIENT_KEY = 'portalClient', START_PATH = '/energy-locations/start', HOME_PATH = '/energy-home/home', SETUP_PATH = '/energy-setup/structure', ADMIN_HOME_PATH = '/energy-admin/clients';
// Server-provided identity. A Home Assistant admin is the only root; a
// client administrator is a portal role and never receives HA's admin flag.
const PORTAL = { ready: false, isRoot: false, role: null, client: null, clientName: '', location: null, clients: [], capabilities: {}, error: '', treeReady: false };
// Home Assistant refuses a statistics request with no ids, and a light or switch with no meter has none to give.
const statsWS = (hass, msg) => { const ids = (msg.statistic_ids || []).filter(Boolean); return ids.length ? hass.callWS({ ...msg, statistic_ids: ids }) : Promise.resolve({}); };
const portalCanManage = () => !!PORTAL.capabilities.manage_tree;
// Wiring, main devices and virtual devices decide what a client can see; the server only takes them from root.
const portalCanWire = () => !!PORTAL.capabilities.manage_wiring;
const portalCanManageHA = () => !!PORTAL.capabilities.manage_ha;
// A Home Assistant administrator works on whichever client is selected, so its commands say which.
const clientArg = () => (PORTAL.isRoot && portalClient ? { client: portalClient } : {});
const portalCanManageUsers = () => !!PORTAL.capabilities.manage_users;
const portalTenantMode = () => !PORTAL.isRoot;
let portalClient = null;
try { portalClient = typeof localStorage === 'undefined' ? null : localStorage.getItem(CLIENT_KEY); } catch (e) { /* private window */ }
if (typeof window !== 'undefined') window.portalContext = PORTAL;
// The screens that show one location. Choosing locations, adding devices and the structure itself cover all of them.
const NEEDS_LOCATION = /^\/energy-(home|groups|controls|devices|reports|alerts)\//;
let currentLocation = null;
let portalUser = null;
try { currentLocation = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(LOCATION_KEY); } catch (e) { /* private window */ }
// A new tab reopens the location this account last chose, or the only one there is. Saved per account so a shared browser never opens someone else's.
function restoreLocation() {
  const list = TREE.places.filter((p) => p.kind === 'location');
  let saved = null;
  try { saved = portalUser && localStorage.getItem(`${LOCATION_KEY}:${portalUser}`); } catch (e) { /* private window */ }
  if (currentLocation && !list.some((p) => p.id === currentLocation)) currentLocation = null;
  const pick = currentLocation || (list.some((p) => p.id === saved) ? saved : list.length === 1 ? list[0].id : null);
  if (pick && pick !== currentLocation) setLocation(pick);
}
function setLocation(id) {
  currentLocation = id || null;
  // The main device always follows the location, so nothing saved afterwards can wipe it.
  TREE.main = TREE.mains?.[currentLocation] ?? null;
  modelFrom = null;
  totalsCache = null;
  LAST_TOTALS = null;
  try { if (id) sessionStorage.setItem(LOCATION_KEY, id); else sessionStorage.removeItem(LOCATION_KEY); if (portalUser) { if (id) localStorage.setItem(`${LOCATION_KEY}:${portalUser}`, id); else localStorage.removeItem(`${LOCATION_KEY}:${portalUser}`); } } catch (e) { /* private window or tests */ }
}
const hasLocations = () => TREE.places.some((p) => p.kind === 'location');
const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const byName = (a, b) => a.name.localeCompare(b.name, 'en', { numeric: true });
const placeById = (id) => TREE.places.find((p) => p.id === id) || null;
const placeChildren = (id) => TREE.places.filter((p) => (placeById(p.parent)?.id || null) === (id || null)).sort(byName);
function placePath(id) {
  const out = [];
  for (let p = placeById(id); p && !out.includes(p); p = placeById(p.parent)) out.unshift(p);
  return out;
}
function placesUnder(id) {
  const out = new Set(), walk = (x) => { if (out.has(x)) return; out.add(x); placeChildren(x).forEach((c) => walk(c.id)); };
  walk(id);
  return out;
}
// Every place inside the current location in tree order, with how deep it sits.
function flatPlaces() {
  const out = [], walk = (parent, depth) => placeChildren(parent).forEach((p) => { out.push({ ...p, depth }); walk(p.id, depth + 1); });
  walk(currentLocation, 0);
  return out;
}
const placeLabel = (id) => placePath(id).map((p) => p.name).join(' › ');
// The location and the group as two names, for tables.
function placeParts(id) {
  const path = placePath(id), groups = path.filter((p) => p.kind !== 'location');
  return { location: path[0]?.kind === 'location' ? path[0].name : '', group: groups.map((p) => p.name).join(' › ') };
}
function treeWithDevicePlaced(tree, device, place) {
  const placed = { ...tree.placed };
  if (place) placed[device] = place; else delete placed[device];
  return { ...tree, placed };
}
// The server owns locations and groups and says where each device is. NATIVE holds that, once the tree has loaded.
let NATIVE = null, LABELS = [];
const cleanName = (x) => String(x || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
function serverPlaces(tree, labels) {
  const places = Array.isArray(tree?.places) ? tree.places : [];
  // A label named for a type (Light, Socket, Relay, AC, Energy meter) sets a device's type.
  const kinds = Object.fromEntries((labels || []).map((l) => [l.label_id, KIND_BY_NAME[cleanName(l.name).toLowerCase()]]).filter(([, k]) => k));
  const locByArea = Object.fromEntries(places.filter((p) => p.kind === 'location' && p.area_id).map((p) => [p.area_id, p.id]));
  return { places, kinds, locByArea, placed: tree?.placed || {} };
}
const KIND_BY_NAME = { light: 'lights', lights: 'lights', socket: 'socket', relay: 'relay', ac: 'ac', 'energy meter': 'meter', meter: 'meter' };
// Where each device sits, as the server said. A device marked to be left out, or switched off in Home Assistant, is not placed.
function nativePlaced(devices, nat) {
  const out = {};
  for (const d of Object.values(devices || {})) {
    if (d.disabled_by || (d.labels || []).some((x) => /exclude/i.test(x))) continue;
    if (nat.placed[d.id]) out[d.id] = nat.placed[d.id];
  }
  return out;
}
// The administrator must be able to assign a device before it has an area or
// location label. Keep the picker to portal-capable main devices rather than
// every integration, add-on pseudo-device and multi-channel child.
const PORTAL_TYPE_LABELS = new Set(['light', 'socket', 'relay', 'ac', 'energy_meter']);
function adminDeviceCatalog(devices, entities, placed) {
  const placedIds = new Set(Object.keys(placed || {}));
  const byId = new Map((devices || []).filter((d) => d?.id).map((d) => [d.id, d]));
  const portalEntityDevices = new Set((entities || []).filter((e) => ['mqtt', 'shelly'].includes(e.platform) && e.device_id && /_(power|energy)$/.test(e.entity_id || '')).map((e) => e.device_id));
  return (devices || []).filter((d) => {
    if (!d?.id || d.disabled_by) return false;
    // Shelly phase/meter children are represented by their parent device.
    // A real device below a non-meter bridge must not be folded away with them.
    const parent = d.via_device_id ? byId.get(d.via_device_id) : null;
    if (parent && placedIds.has(parent.id) && portalEntityDevices.has(parent.id)) return false;
    if (placedIds.has(d.id)) return true;
    if (d.entry_type === 'service') return false;
    return portalEntityDevices.has(d.id) || (d.labels || []).some((x) => PORTAL_TYPE_LABELS.has(x));
  });
}
function setTree(t) {
  Object.assign(TREE, { main: null, mains: {}, parents: {}, virtual: [], known: null, places: [], placed: {}, automations: [], alarms: [], kept: null, kinds: {}, notify: {}, sums: {}, prices: {} }, t || {});
  if (NATIVE) { TREE.virtualPlaced = Object.fromEntries(Object.entries(TREE.placed).filter(([k]) => k.startsWith('virt:'))); TREE.places = NATIVE.places; }
  if (currentLocation && !TREE.places.some((p) => p.id === currentLocation && p.kind === 'location')) setLocation(null);
  if (t?.mains) TREE.main = t.mains[currentLocation] ?? null;
  modelFrom = null;
  totalsCache = null;
}
const treeNodes = () => DEVICES.filter((d) => nodeIds.has(d.id));
const nodeById = (id) => (nodeIds.has(id) ? DEVICES.find((d) => d.id === id) : null);
const parentOf = (id) => { const p = TREE.parents[id]; return p && nodeIds.has(p) ? p : null; };
const childrenOf = (id) => treeNodes().filter((d) => parentOf(d.id) === id);
const mainDevice = () => nodeById(TREE.main);
const topNodes = () => treeNodes().filter((d) => !parentOf(d.id));
function ancestorsOf(id) {
  const out = [];
  for (let p = parentOf(id); p && !out.includes(p); p = parentOf(p)) out.push(p);
  return out;
}
// The real devices whose readings make up a device: itself, or for a virtual one, what is under it.
function readingsOf(id, seen = new Set()) {
  const d = nodeById(id);
  if (!d || seen.has(id)) return [];
  seen.add(id);
  if (d.channels) return channelsOf(d);
  return d.virtual ? childrenOf(id).flatMap((c) => readingsOf(c.id, seen)) : [d];
}
// A device with separate measuring channels has no readings of its own: it is what its channels measure.
const channelsOf = (d) => d.channels.map((id) => DEVICES.find((x) => x.id === id)).filter(Boolean);
const unique = (list) => [...new Map(list.map((d) => [d.id, d])).values()];
// A device only counts if nothing above it is in the same selection. The same rule keeps every total from double counting.
function rootsIn(list) {
  const ids = new Set(list.map((d) => d.id));
  return list.filter((d) => !ancestorsOf(d.id).some((p) => ids.has(p))).map((d) => d.id);
}
const countedIn = (list) => unique(rootsIn(list).flatMap((id) => readingsOf(id)));
const buildingRoots = () => (mainDevice() ? [TREE.main] : topNodes().map((d) => d.id));
const homeDevices = () => unique(buildingRoots().flatMap((id) => readingsOf(id)));
// All the real devices at or below these, so their energy can be compared with the device above.
function subtreeOf(rootIds) {
  const seen = new Set(), walk = (id) => { if (seen.has(id)) return; seen.add(id); childrenOf(id).forEach((c) => walk(c.id)); };
  rootIds.forEach(walk);
  return [...seen].filter((id) => !nodeById(id)?.virtual).flatMap((id) => nodeById(id)?.channels || [id]);
}
// Energy of a device and everything under it. kwhOf(id) gives a real device's energy, or null with no reading.
// Unmeasured is a device's energy minus what the devices directly under it measured; total adds up the levels below too.
// With a child missing it is unknown, never a guess.
function nodeEnergy(id, kwhOf, stale = () => false, seen = new Set()) {
  const d = nodeById(id);
  seen.add(id);
  const kids = childrenOf(id).filter((c) => !seen.has(c.id)).map((c) => nodeEnergy(c.id, kwhOf, stale, seen));
  const good = (k) => k.kwh != null && !k.partial && !k.stale, sum = kids.reduce((t, k) => t + (k.kwh || 0), 0);
  const below = kids.reduce((t, k) => t + k.total, 0), gapBelow = kids.some((k) => k.gap), allGood = kids.every(good);
  if (d.virtual) return { id, name: d.name, virtual: true, kwh: kids.length ? sum : null, partial: !allGood, reporting: kids.filter(good).length, kids, unmeasured: null, total: below, gap: gapBelow, over: false };
  const parts = d.channels?.map(kwhOf), kwh = parts ? (parts.some((v) => v != null) ? parts.reduce((t, v) => t + (v || 0), 0) : null) : kwhOf(id), isStale = stale(id), direct = kids.length && kwh != null && !isStale && allGood ? kwh - sum : null;
  return { id, name: d.name, kwh, stale: isStale, partial: false, reporting: kids.filter(good).length, kids, unmeasured: direct, total: (direct || 0) + below, gap: gapBelow || (kids.length > 0 && direct == null), over: direct != null && direct < -Math.max(0.05, kwh * 0.02) };
}
function unmeasuredOf(rootIds, kwhOf, stale) {
  const nodes = rootIds.filter(nodeById).map((id) => nodeEnergy(id, kwhOf, stale));
  const some = (n, test) => test(n) || n.kids.some((k) => some(k, test));
  return { nodes, applies: nodes.some((n) => some(n, (x) => !x.virtual && x.kids.length > 0)), kwh: nodes.reduce((t, n) => t + n.total, 0), energy: nodes.reduce((t, n) => t + (n.kwh || 0), 0), gap: nodes.some((n) => n.gap), over: nodes.some((n) => some(n, (x) => x.over)) };
}
// The same tree as flat rows, for tables.
function breakdownRows(rootIds, kwhOf, stale) {
  const u = unmeasuredOf(rootIds, kwhOf, stale), rows = [];
  const add = (n, depth, top) => {
    rows.push({ id: n.id, name: n.name, depth, kwh: n.kwh, share: top > 0 && n.kwh != null ? n.kwh / top : null, kind: n.virtual ? 'virtual' : 'device', partial: n.partial || n.stale });
    n.kids.forEach((k) => add(k, depth + 1, top));
    if (!n.virtual && n.kids.length) rows.push({ name: 'Unmeasured', depth: depth + 1, kwh: n.unmeasured, share: top > 0 && n.unmeasured != null ? n.unmeasured / top : null, kind: 'unmeasured', over: n.over });
  };
  u.nodes.forEach((n) => add(n, 0, n.kwh));
  return { applies: u.applies, unmeasured: u.kwh, gap: u.gap, over: u.over, rows };
}
// Changes to the tree. Each returns a new tree, and only what the page shows can be chosen, so these stay simple.
const wouldLoop = (id, parent) => parent === id || ancestorsOf(parent).includes(id);
function treeWithParent(tree, id, parent) {
  const parents = { ...tree.parents };
  if (parent) parents[id] = parent; else delete parents[id];
  return { ...tree, parents };
}
function treeWithMain(tree, id) {
  const next = treeWithParent(tree, id, null);
  return { ...next, main: id };
}
function treeWithVirtual(tree, name, id) {
  return { ...tree, virtual: [...tree.virtual, { id, name }] };
}
// TREE.prices: location id -> { mode: bill | exchange | fixed, bill, billSource, fixed, fixedSource, sensor, extra, vat, exchangeSource }.
// Bill and Fixed are stored all-in prices including VAT. Exchange is the live sensor, plus an ex-VAT margin, plus VAT.
// Without a setting, or while the sensor has no reading, Home Assistant's client_tariff helper.
// The one rule for what a kWh costs at a location. Every price and cost in the portal comes from it.
// raw is the exchange price in the sensor's own unit. vat: true when VAT is in the price, false when not, null when not known (the helper).
function priceRule(hass, loc = currentLocation, mode = null) {
  const p = TREE.prices?.[loc], st = hass.states, helper = parseFloat(st[TARIFF]?.state) || 0, chosen = mode || p?.mode;
  if (chosen === 'bill') {
    const fixed = Number(p?.bill) || 0;
    return { mode: 'bill', now: fixed, final: () => fixed, vat: true };
  }
  if (chosen === 'fixed') return { mode: 'fixed', now: Number(p?.fixed) || 0, final: () => Number(p?.fixed) || 0, vat: true };
  if (chosen === 'exchange') {
    const sensor = (p?.sensor && (st[p.sensor] || PRICE_MEMORY?.values?.[p.sensor]) ? p.sensor : ibexSensor(hass, loc)), s = st[sensor], div = /mwh/i.test(s?.attributes?.unit_of_measurement || '') ? 1000 : 1, withVat = p?.vat !== false;
    const final = (raw) => (raw / div + (Number(p?.extra) || 0)) * (withVat ? 1.2 : 1), nowRaw = parseFloat(s?.state);
    if (sensor && Number.isFinite(nowRaw)) return { mode: 'exchange', sensor, div, now: final(nowRaw), final, vat: withVat };
    // No reading now: the last known price for this quarter-hour, or the last value the sensor had.
    const kept = PRICE_MEMORY?.values?.[sensor], t = Date.now(), slot = priceList(hass).find((x) => x.t <= t && t < x.t + 900000);
    const lastRaw = slot ? slot.raw : parseFloat(kept?.state);
    if (sensor && Number.isFinite(lastRaw)) {
      const d = /mwh/i.test(kept?.unit || s?.attributes?.unit_of_measurement || '') ? 1000 : 1, f = (raw) => (raw / d + (Number(p?.extra) || 0)) * (withVat ? 1.2 : 1);
      return { mode: 'exchange', sensor, div: d, now: f(lastRaw), final: f, vat: withVat, stale: true };
    }
  }
  // No setting, or no exchange reading: the helper's price, said so, rather than a wrong number.
  return { mode: 'helper', now: helper, final: () => helper, vat: null, ...(chosen === 'exchange' || p?.mode === 'exchange' ? { missing: true } : {}) };
}
const vatNote = (rule) => (rule.vat === true ? 'incl. VAT' : rule.vat === false ? 'excl. VAT' : 'VAT not stated');
function priceOf(hass, loc = currentLocation) { return priceRule(hass, loc).now; }
if (typeof window !== 'undefined') window.portalPriceInfo = (h) => { const r = priceRule(h); return { now: r.now, vat: vatNote(r) }; };
if (typeof window !== 'undefined') window.portalPrice = (h) => priceOf(h);
// The exchange prices the sensor knows, every 15 minutes, today and tomorrow: [{ t, raw }].
// The market prices come from another integration. While it gives no readings (after a restart, or when its
// source is down) the portal uses what the server last saw, and says they are not live.
let PRICE_MEMORY = null, priceMemoryAt = 0;
async function loadPriceMemory(hass, force = false) {
  if (!force && Date.now() - priceMemoryAt < 300000) return PRICE_MEMORY;
  priceMemoryAt = Date.now();
  try { PRICE_MEMORY = await hass.callWS({ type: 'optim_energy/price/last' }); } catch (e) { /* an older server: live prices only */ }
  return PRICE_MEMORY;
}
const priceRows = (today, tomorrow) => [...(today || []), ...(tomorrow || [])].map((x) => ({ t: +new Date(String(x.time).replace(' ', 'T')), raw: Number(x.price) })).filter((x) => Number.isFinite(x.t) && Number.isFinite(x.raw));
const livePrices = (hass) => Object.values(hass.states).find((x) => Array.isArray(x.attributes?.prices_today) && x.attributes.prices_today.length);
function priceList(hass) {
  const s = livePrices(hass);
  return s ? priceRows(s.attributes.prices_today, s.attributes.prices_tomorrow) : priceRows(PRICE_MEMORY?.today, PRICE_MEMORY?.tomorrow);
}
// Whether the exchange price is being read right now, and when it last was.
function priceStatus(hass) {
  const live = !!livePrices(hass) || Object.keys(PRICE_MEMORY?.values || {}).some((id) => Number.isFinite(parseFloat(hass.states[id]?.state)));
  return { live, at: PRICE_MEMORY?.at ? PRICE_MEMORY.at * 1000 : null, known: live || !!PRICE_MEMORY?.at };
}
function priceStatusChip(hass) {
  const st = priceStatus(hass);
  if (st.live) return '<span class="live" title="The exchange price is being read now"><i></i>Live</span>';
  const when = st.at ? new Date(st.at).toLocaleString('en-GB', { timeZone: hass.config.time_zone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  return `<span class="live off" title="The price source gives no readings now"><i></i>${st.at ? `Not live · last read ${when}` : 'Not live'}</span>`;
}
// The location's price for the hour that holds t: the average of its 15-minute exchange prices when the sensor still lists them,
// else that hour's average from Home Assistant's history, else the price now. Margin, fees and VAT as in priceOf.
// Without an exchange price it is the same price for every hour.
async function priceSeries(hass, from, to, loc = currentLocation) {
  const rule = priceRule(hass, loc), now = rule.now, p = { sensor: rule.sensor }, final = rule.final;
  if (rule.mode !== 'exchange') { const flat = () => now; flat.varies = false; return flat; }
  const quarters = new Map(priceList(hass).map((x) => [x.t, x.raw]));
  let hours = new Map();
  try { const r = await statsWS(hass, { type: 'recorder/statistics_during_period', start_time: new Date(from).toISOString(), end_time: new Date(to).toISOString(), statistic_ids: [p.sensor], period: 'hour', types: ['mean'] }); hours = new Map((r[p.sensor] || []).filter((x) => x.mean != null).map((x) => [+new Date(x.start), x.mean])); } catch (e) { /* the price now stands in */ }
  const at = (t) => {
    const h0 = t - (t % HOUR_MS), qs = [0, 1, 2, 3].map((i) => quarters.get(h0 + i * 900000)).filter((v) => v != null);
    if (qs.length) return final(qs.reduce((a, b) => a + b, 0) / qs.length);
    return hours.has(h0) ? final(hours.get(h0)) : now;
  };
  at.varies = true;
  return at;
}
if (typeof window !== 'undefined') window.portalPriceSeries = (h, from, to) => priceSeries(h, from, to);
// The price ahead, for a location on the exchange price: now, the lowest and highest 15 minutes still to come,
// and a chart of every 15 minutes with the same hover details as the energy charts. W is the chart's width in pixels.
// Today's average price per kWh of the location, from the exchange prices it knows for today.
function priceDayAverage(hass, nowMs = Date.now()) {
  const rule = priceRule(hass);
  if (rule.mode !== 'exchange') return null;
  const day = new Date(nowMs).toLocaleDateString('en-CA', { timeZone: hass.config.time_zone });
  const today = priceList(hass).filter((x) => new Date(x.t).toLocaleDateString('en-CA', { timeZone: hass.config.time_zone }) === day);
  return today.length ? rule.final(today.reduce((t, x) => t + x.raw, 0) / today.length) : null;
}
function pricePanel(hass, W = 600, nowMs = Date.now()) {
  const rule = priceRule(hass);
  if (rule.mode !== 'exchange') return '';
  const known = priceList(hass).sort((a, b) => a.t - b.t), ahead = known.filter((x) => x.t + 900000 > nowMs), past = !ahead.length && known.length > 0;
  const rows = (past ? known.slice(-96) : ahead).map((x) => ({ t: x.t, raw: x.raw / rule.div, v: rule.final(x.raw) }));
  if (!rows.length) return '';
  const tz = hass.config.time_zone, part = (t, o) => new Date(t).toLocaleString('en-GB', { timeZone: tz, ...o }), hm = (t) => part(t, { hour: '2-digit', minute: '2-digit' });
  const today = part(nowMs, { day: 'numeric' }), dayOf = (t) => (part(t, { day: 'numeric' }) === today ? '' : `${part(t, { weekday: 'short' })} `);
  const lo = rows.reduce((a, b) => (b.v < a.v ? b : a)), hi = rows.reduce((a, b) => (b.v > a.v ? b : a)), avg = rows.reduce((t, x) => t + x.v, 0) / rows.length;
  const sorted = rows.map((x) => x.v).sort((a, b) => a - b), q1 = sorted[Math.floor(sorted.length / 4)], q3 = sorted[Math.floor((sorted.length * 3) / 4)];
  const H = Math.min(280, Math.max(130, Math.round(W * 0.28))), top = 16, bottom = 20, max = Math.max(hi.v, 0.01), step = W / rows.length, y = (v) => top + (H - top - bottom) * (1 - v / max), every = W < 480 ? 6 : 3;
  const eur = (v) => `€ ${v.toFixed(3)}`;
  const cols = rows.map((x, i) => {
    const color = i === 0 ? 'var(--fg)' : x.v <= q1 ? 'var(--ok)' : x.v >= q3 ? 'var(--bad)' : 'var(--slate)', bx = i * step + step * 0.1, hour = Number(part(x.t, { hour: '2-digit', hour12: false })) % 24, min = Number(part(x.t, { minute: '2-digit' }));
    const note = [i === 0 ? 'Now' : '', x === lo ? 'Lowest ahead' : '', x === hi ? 'Highest ahead' : ''].filter(Boolean).join(' · ') || null;
    const diff = Math.round((x.v / avg - 1) * 100);
    const tip = tipData(`${dayOf(x.t)}${hm(x.t)} to ${hm(x.t + 900000)}`, note, [[`Price per kWh, ${vatNote(rule)}`, eur(x.v)], ['Exchange price, excl. VAT', eur(x.raw)], [rule.vat ? 'Margin, fees and VAT' : 'Margin and fees', eur(x.v - x.raw)], ['Against the average', `${diff > 0 ? '+' : ''}${diff}%`]]);
    const label = min === 0 && hour % every === 0 ? `<text x="${i * step}" y="${H - 6}" text-anchor="middle" fill="var(--muted)" font-size="10">${String(hour).padStart(2, '0')}</text>` : '';
    const midnight = i > 0 && hour === 0 && min === 0 ? `<line x1="${i * step}" x2="${i * step}" y1="${top - 6}" y2="${H - bottom}" stroke="var(--muted)" stroke-dasharray="2 3"/><text x="${i * step + 4}" y="${top - 4}" fill="var(--muted)" font-size="10">${part(x.t, { weekday: 'short' })}</text>` : '';
    return `<g class="col"><rect class="b" data-tip="${tip}" x="${i * step}" y="${top}" width="${step}" height="${H - top - bottom}" fill="transparent"/><rect class="v" pointer-events="none" x="${bx}" y="${y(x.v)}" width="${Math.max(1, step * 0.8)}" height="${Math.max(1, y(0) - y(x.v))}" rx="1" fill="${color}"/>${label}${midnight}</g>`;
  }).join('');
  const avgLine = `<line x1="0" x2="${W}" y1="${y(avg)}" y2="${y(avg)}" stroke="var(--accent)" stroke-dasharray="4 3" pointer-events="none"/><text x="${W}" y="${y(avg) - 3}" text-anchor="end" fill="var(--accent)" font-size="10">average ${eur(avg)}</text>`;
  const chart = `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Price per kWh every 15 minutes from now"><text x="0" y="10" fill="var(--muted)" font-size="10">${eur(max)}</text><line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" stroke="var(--line)"/>${cols}${avgLine}</svg><div class="tip" hidden></div></div>`;
  const key = '<div class="key"><span><i style="background:var(--fg)"></i>Now</span><span><i style="background:var(--ok)"></i>Lowest quarter</span><span><i style="background:var(--bad)"></i>Highest quarter</span></div>';
  return `<div class="box"><div class="chead"><h3>${past ? 'Last known price per kWh' : 'Price per kWh, every 15 minutes'}</h3><span class="chart-src" aria-label="Price source: IBEX"><b>IBEX</b><span>${vatNote(rule)}</span>${priceStatusChip(hass)}</span></div><small class="muted">Lowest ${dayOf(lo.t)}${hm(lo.t)} · ${eur(lo.v)} · Highest ${dayOf(hi.t)}${hm(hi.t)} · ${eur(hi.v)}</small>${chart}${key}</div>`;
}
// Reading a bill. Which model and what it is told are in the integration's bill-reader.json.
// This code only sends the pages, checks what comes back and does the maths. The API address and key are in Home Assistant's rest_command.
const BILL_READER = '/optim_energy_static/bill-reader.json';
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs', PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs';
const BILL_BYTES = 240000; // what the page images may take of Home Assistant's 262,144-character template limit
const BGN_PER_EUR = 1.95583;
const billSettings = async () => { const r = await fetch(`${BILL_READER}?t=${Date.now()}`, { cache: 'no-store' }); if (!r.ok) throw new Error('bill-reader.json is missing from Home Assistant.'); return r.json(); };
// The reader's answer as a bill in euros: JSON, perhaps inside a code fence. Amounts in leva are turned into euros at the fixed rate.
function parseBill(text) {
  const s = String(text || ''), i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i < 0 || j < i) throw new Error('The reader did not answer with the bill’s figures.');
  const b = JSON.parse(s.slice(i, j + 1));
  if (!(Number(b.kwh) > 0) || (b.total_incl_vat == null && b.total_excl_vat == null) || !b.period_from || !b.period_to)
    throw new Error(`The reader found no kWh, total or dates on this bill${b.notes ? `: ${b.notes}` : '.'}`);
  const currency = String(b.currency ?? '').trim(), bgn = /^(BGN|лв\.?)$/i.test(currency), eur = /^(EUR|€)$/i.test(currency);
  if (!bgn && !eur) throw new Error('The reader did not give a bill currency it can use (EUR or BGN).');
  const k = bgn ? 1 / BGN_PER_EUR : 1, money = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v) * k);
  return { ...b, currency: 'EUR', fromBgn: bgn, kwh: Number(b.kwh) || 0, total_excl_vat: money(b.total_excl_vat), vat: money(b.vat), total_incl_vat: money(b.total_incl_vat), lines: (b.lines || []).map((l) => ({ ...l, unit_price: money(l.unit_price), amount_excl_vat: money(l.amount_excl_vat) })) };
}
// ENTSO-e's prices for any dates as [{ t, p }], € per kWh before VAT. The answer's shape is read loosely: a list of { timestamp, price }, or time -> price.
function exchangeRows(resp) {
  const list = Array.isArray(resp) ? resp : Object.values(resp || {}).find(Array.isArray);
  const raw = list ? list.map((x) => [x.timestamp ?? x.time ?? x.start, x.price ?? x.value]) : Object.entries(resp || {}).filter(([k]) => /^\d{4}-\d\d-\d\d/.test(k));
  const rows = raw.map(([t, p]) => ({ t: +new Date(String(t).replace(' ', 'T')), p: Number(p) })).filter((x) => Number.isFinite(x.t) && Number.isFinite(x.p));
  // ponytail: €/MWh is told from €/kWh by size; no hour in Bulgaria costs over € 5 per kWh.
  const mid = rows.map((x) => x.p).sort((a, b) => a - b)[rows.length >> 1];
  return mid > 5 ? rows.map((x) => ({ ...x, p: x.p / 1000 })) : rows;
}
// What one kWh on the bill cost beyond the exchange price. prices: [{ t, p }]; usage: hour start -> kWh the meters recorded.
// The exchange price is averaged over the bill's dates, each hour weighted by what the location used then; with no readings, a plain average.
function billExtra(bill, prices, usage = new Map()) {
  const hours = new Map();
  for (const { t, p } of prices) { const h = t - (t % HOUR_MS), x = hours.get(h) || [0, 0]; hours.set(h, [x[0] + p, x[1] + 1]); }
  let kwh = 0, eur = 0, metered = 0;
  for (const [h, v] of usage) { if (!(v > 0)) continue; metered += v; const x = hours.get(h); if (x) { kwh += v; eur += v * (x[0] / x[1]); } }
  const plain = prices.length ? prices.reduce((t, x) => t + x.p, 0) / prices.length : null, weighted = kwh > 0, avg = weighted ? eur / kwh : plain;
  const perKwh = bill.kwh > 0 && bill.total_excl_vat != null ? bill.total_excl_vat / bill.kwh : null;
  const linesSum = (bill.lines || []).reduce((t, l) => t + (Number(l.amount_excl_vat) || 0), 0);
  return { perKwh, avg, weighted, metered, extra: perKwh != null && avg != null ? perKwh - avg : null, linesSum, linesOk: bill.total_excl_vat != null && Math.abs(linesSum - bill.total_excl_vat) <= Math.max(0.5, bill.total_excl_vat * 0.01), meterOff: metered > 0 && bill.kwh > 0 ? metered / bill.kwh - 1 : null };
}
const billDay = (s) => (s ? new Date(`${s}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '?');
// The IBEX price sensor: the one a location already uses, else ENTSO-e's current price.
function ibexSensor(hass, loc) {
  const chosen = TREE.prices?.[loc]?.sensor;
  if (chosen && (hass.states[chosen] || PRICE_MEMORY?.values?.[chosen])) return chosen;
  const ids = Object.keys(hass.states).filter((id) => id.startsWith('sensor.') && hass.entities?.[id]?.platform === 'entsoe' && /\/\s*(k|m)wh/i.test(hass.states[id].attributes?.unit_of_measurement || ''));
  // With the source down the sensors carry no unit; the ones remembered by the server still do.
  const kept = Object.entries(PRICE_MEMORY?.values || {}).filter(([, v]) => /\/\s*(k|m)wh/i.test(v.unit || '')).map(([id]) => id);
  const all = ids.length ? ids : kept;
  return all.find((id) => /current/.test(id)) || all[0] || null;
}
// The two prices a bill gives. Fixed: what one kWh cost in all, VAT included. Follows IBEX: the margin over the exchange price, before VAT.
function billPrices(bill, fig) {
  const excl = bill.total_excl_vat == null ? null : Number(bill.total_excl_vat), vat = bill.vat == null ? (excl == null ? null : excl * 0.2) : Number(bill.vat);
  const incl = bill.total_incl_vat ?? (excl == null ? null : excl + vat);
  return { fixed: bill.kwh > 0 && incl != null ? incl / bill.kwh : null, extra: fig?.extra ?? null, totalIncl: incl, totalExcl: excl, vat };
}
// The kind of contract the bill shows, as the reader saw it. Without an answer, IBEX only if a line names the exchange.
const billKind = (bill) => (bill.pricing === 'exchange' || bill.pricing === 'fixed' ? bill.pricing : (bill.lines || []).some((l) => /ibex|борс/i.test(l.name || '')) ? 'exchange' : 'fixed');
// Midnight at the start of a YYYY-MM-DD day, in Home Assistant's time zone.
function dayStartMs(day, tz) {
  const [y, m, d] = String(day).split('-').map(Number), guess = Date.UTC(y, m - 1, d), p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(guess)).forEach((x) => { p[x.type] = +x.value; });
  return guess - (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - guess);
}
// The bill's pages as JPEG images: each PDF page drawn, each photo scaled down. White behind, so a see-through page reads.
async function billPages(files, cfg) {
  const width = cfg.image_width || 1600, max = Math.max(1, Number(cfg.max_pages) || 4), inputs = [];
  const jpeg = ([src, w, h], scale, q) => { const k = Math.min(1, width / w) * scale, c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k); const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(src, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', q); };
  let pages = 0;
  for (const f of files) {
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
      const pdfjs = await import(PDFJS);
      pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      const doc = await pdfjs.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
      inputs.push({ doc }); pages += doc.numPages;
    } else { inputs.push({ file: f }); pages += 1; }
  }
  if (pages > max) throw new Error(`The bill has ${pages} pages. Upload at most ${max} page${max === 1 ? '' : 's'}.`);
  const srcs = [];
  for (const input of inputs) {
    if (input.doc) {
      for (let i = 1; i <= input.doc.numPages; i++) {
        const pg = await input.doc.getPage(i), v = pg.getViewport({ scale: width / pg.getViewport({ scale: 1 }).width }), c = document.createElement('canvas');
        c.width = Math.round(v.width); c.height = Math.round(v.height);
        await pg.render({ canvasContext: c.getContext('2d'), viewport: v }).promise;
        srcs.push([c, c.width, c.height]);
      }
    } else {
      const f = input.file;
      let b;
      try { b = await createImageBitmap(f); } catch (e) { throw new Error(`${f.name} cannot be opened here. Use a PDF, JPEG or PNG.`); }
      srcs.push([b, b.width, b.height]);
    }
  }
  // ponytail: Home Assistant renders the rest_command payload as a template, and a template's output is capped at 256 KB.
  // The pages lose JPEG quality, then size, until they fit; a self-hosted proxy is the upgrade if bills get too blurry.
  let scale = 1, q = 0.8, out;
  for (;;) {
    out = srcs.map((s) => jpeg(s, scale, q));
    if (out.join('').length <= BILL_BYTES) return out;
    if (scale < 0.35) throw new Error('The bill is too large to send through Home Assistant. Try fewer pages.');
    if (q > 0.55) q -= 0.1; else scale *= 0.85;
  }
}
// Sends the pages through Home Assistant to the reader and returns the bill it read.
async function readBill(hass, files) {
  const cfg = await billSettings(), pages = await billPages(files, cfg);
  if (!pages.length) throw new Error('Choose the bill first.');
  const body = JSON.stringify({ model: cfg.model, ...(cfg.reasoning_effort ? { reasoning_effort: cfg.reasoning_effort } : {}), max_tokens: cfg.max_tokens || 4000, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: [{ type: 'text', text: [].concat(cfg.prompt).join('\n') }, ...pages.map((url) => ({ type: 'image_url', image_url: { url, ...(cfg.image_detail ? { detail: cfg.image_detail } : {}) } }))] }] });
  const r = await hass.callWS({ type: 'optim_energy/bill/read', body });
  const res = r?.response;
  if (res?.status !== 200) throw new Error(`The reader answered ${res?.status ?? 'nothing'}: ${String(typeof res?.content === 'string' ? res.content : JSON.stringify(res?.content ?? '')).slice(0, 200)}`);
  return { bill: parseBill(res.content?.choices?.[0]?.message?.content), model: res.content?.model || cfg.model, pages: pages.length };
}
// The figures for a bill read at a location: the exchange prices for its dates from ENTSO-e (or Home Assistant's history of the price sensor),
// weighted by the hourly use of the location's main device.
async function billFigures(hass, bill, loc) {
  const tz = hass.config.time_zone, next = new Date(Date.parse(`${bill.period_to}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const from = dayStartMs(bill.period_from, tz), to = dayStartMs(next, tz);
  if (!(to > from)) throw new Error('The bill’s period could not be read.');
  let prices = [], source = 'the price history in Home Assistant';
  const sensor = TREE.prices?.[loc]?.sensor;
  if (sensor) {
    source = 'the price history in Home Assistant';
    const div = /mwh/i.test(hass.states[sensor]?.attributes?.unit_of_measurement || '') ? 1000 : 1;
    const st = await statsWS(hass, { type: 'recorder/statistics_during_period', start_time: new Date(from).toISOString(), end_time: new Date(to).toISOString(), statistic_ids: [sensor], period: 'hour', types: ['mean'] });
    prices = (st[sensor] || []).filter((x) => x.mean != null).map((x) => ({ t: +new Date(x.start), p: x.mean / div }));
  }
  const main = TREE.mains?.[loc], ids = main ? unique(readingsOf(main)).map((d) => d.energy).filter(Boolean) : [], usage = new Map();
  if (ids.length) {
    const st = await statsWS(hass, { type: 'recorder/statistics_during_period', start_time: new Date(from).toISOString(), end_time: new Date(to).toISOString(), statistic_ids: ids, period: 'hour', types: ['change'] });
    for (const id of ids) for (const x of st[id] || []) { const t = +new Date(x.start); if (x.change > 0) usage.set(t, (usage.get(t) || 0) + x.change); }
  }
  // Exchange prices only cover the hours there are prices for; a whole month should have about one per hour or quarter.
  const hoursWanted = (to - from) / HOUR_MS, hoursPriced = new Set(prices.map((x) => x.t - (x.t % HOUR_MS))).size;
  return { ...billExtra(bill, prices, usage), source, mainSet: !!main, priced: hoursPriced / hoursWanted };
}
function treeWithPrice(tree, loc, patch) {
  const prices = { ...(tree.prices || {}) }, next = { ...(prices[loc] || {}), ...patch };
  if (!next.mode) delete prices[loc]; else prices[loc] = next;
  return { ...tree, prices };
}
// The main device of any location, not only the one being viewed.
function treeWithLocationMain(tree, location, device) {
  const next = device ? treeWithParent(tree, device, null) : tree;
  return { ...next, mains: { ...tree.mains, [location]: device || null }, main: location === currentLocation ? device || null : tree.main };
}
function treeWithoutVirtual(tree, id) {
  const up = tree.parents[id], parents = {};
  for (const [k, v] of Object.entries(tree.parents)) { if (k === id) continue; if (v !== id) parents[k] = v; else if (up) parents[k] = up; }
  return treeWithDevicePlaced({ ...tree, parents, virtual: tree.virtual.filter((v) => v.id !== id), main: tree.main === id ? null : tree.main }, id, null);
}
// Home Assistant keeps the sidebar order per account. Client accounts see the
// packaged portal only; Home Assistant administrators get a separate command
// centre and keep their normal HA tools.
const CLIENT_PANELS = ['energy-start', 'energy-locations', 'energy-home', 'energy-groups', 'energy-controls', 'energy-devices', 'energy-reports', 'energy-alerts', 'energy-setup'];
const ADMIN_PANELS = ['energy-admin', 'core_configurator', '45df7312_zigbee2mqtt', 'hacs'];
let sidebarKey = null;
// A Home Assistant administrator looking at a tenant's pages, opened with Preview.
const previewing = () => PORTAL.isRoot && typeof location !== 'undefined' && /^\/energy-(?!admin|start)/.test(location.pathname);
async function syncSidebar(hass) {
  if (!PORTAL.ready || typeof location === 'undefined') return;
  const setup = portalCanManage();
  const singleLocationUser = !PORTAL.isRoot && PORTAL.role === 'user' && (PORTAL.locations || []).length <= 1;
  const clientPanels = CLIENT_PANELS.filter((id) => id !== 'energy-start' && (!singleLocationUser || id !== 'energy-locations'));
  const preview = previewing(), tenantTabs = CLIENT_PANELS.filter((id) => id !== 'energy-start');
  const allowed = new Set(PORTAL.isRoot ? ADMIN_PANELS : clientPanels.filter((id) => setup || id !== 'energy-setup'));
  const order = !PORTAL.isRoot ? clientPanels : preview ? ['energy-admin', ...tenantTabs, ...ADMIN_PANELS.filter((id) => id !== 'energy-admin')] : ADMIN_PANELS;
  const key = `${PORTAL.role}|${preview}|${[...allowed].join(',')}`;
  if (sidebarKey === key) return;
  try {
    const now = (await hass.callWS({ type: 'frontend/get_user_data', key: 'sidebar' }))?.value;
    const hidden = new Set(now?.hiddenPanels || []);
    for (const id of ['energy-admin', ...CLIENT_PANELS, ...ADMIN_PANELS]) hidden.delete(id);
    if (PORTAL.isRoot) {
      // Keep the normal HA tools visible. The tenant's pages are in an administrator's
      // sidebar only while one of them is open, which is what Preview does.
      for (const id of CLIENT_PANELS) if (!preview || id === 'energy-start') hidden.add(id);
    } else {
      for (const id of Object.keys(hass.panels || {})) if (!allowed.has(id)) hidden.add(id);
    }
    const nextHidden = [...hidden];
    if (JSON.stringify(now?.panelOrder) !== JSON.stringify(order) || JSON.stringify(now?.hiddenPanels || []) !== JSON.stringify(nextHidden)) await hass.callWS({ type: 'frontend/set_user_data', key: 'sidebar', value: { panelOrder: order, hiddenPanels: nextHidden } });
    sidebarKey = key;
  } catch (e) { /* the order is a nicety, the app works without it */ }
}
let treeLoad = null, whoLoad = null, treeWatched = false;
const announceTree = () => { if (typeof window !== 'undefined') window.dispatchEvent(new Event('portal-tree')); };
function resetPortalTree() {
  currentLocation = null;
  try { sessionStorage.removeItem(LOCATION_KEY); } catch (e) { /* private window */ }
  NATIVE = null;
  LABELS = [];
  modelFrom = null;
  totalsCache = null;
  // Nothing of the tenant that was open may be shown for the next one.
  LAST_TOTALS = null;
  PORTAL.treeReady = false;
  setTree({ places: [], placed: {}, mains: {}, parents: {}, virtual: [], known: [] });
}
let portalContextSeq = 0;
async function switchPortalClient(hass, client) {
  if (!PORTAL.isRoot || !client || client === portalClient) return treeLoad;
  const seq = ++portalContextSeq;
  portalClient = client;
  try { localStorage.setItem(CLIENT_KEY, client); } catch (e) { /* private window */ }
  treeLoad = null;
  whoLoad = null;
  resetPortalTree();
  announceTree();
  await ensureTree(hass);
  if (seq === portalContextSeq) announceTree();
  return treeLoad;
}
function ensureTree(hass) {
  portalUser = hass.user?.id || null;
  if (!whoLoad) {
    whoLoad = hass.callWS({ type: 'optim_energy/whoami' }).then((ctx) => {
      Object.assign(PORTAL, ctx || {}, { ready: true, isRoot: !!ctx?.is_root, error: '' });
      if (PORTAL.isRoot) {
        const ids = (PORTAL.clients || []).map((c) => c.id);
        if (!ids.includes(portalClient)) portalClient = ids[0] || null;
        try { if (portalClient) localStorage.setItem(CLIENT_KEY, portalClient); } catch (e) { /* private window */ }
      } else {
        portalClient = ctx?.client || null;
      }
      syncSidebar(hass);
      return ctx;
    }).catch((e) => {
      PORTAL.ready = true;
      PORTAL.treeReady = true;
      PORTAL.error = 'This account is not assigned to a tenant. Ask the administrator to add it under Administration.';
      announceTree();
      return null;
    });
  }
  if (!treeWatched) {
    treeWatched = true;
    hass.connection?.subscribeEvents(() => { treeLoad = null; ensureTree(hass); }, 'lovelace_updated').catch(() => {});
    // A change to labels, floors, areas or devices shows straight away. The
    // server recomputes the native permission groups when these change.
    for (const ev of ['label_registry_updated', 'floor_registry_updated', 'area_registry_updated', 'device_registry_updated', 'entity_registry_updated']) hass.connection?.subscribeEvents(() => { treeLoad = null; ensureTree(hass); }, ev).catch(() => {});
  }
  if (!treeLoad) treeLoad = whoLoad.then(async (ctx) => {
    if (!ctx) return null;
    const client = PORTAL.isRoot ? portalClient : null;
    const reg = (kind) => hass.callWS({ type: 'optim_energy/registry/list', kind, ...(client ? { client } : {}) }).catch(() => []);
    try {
      const [payload, labels, devices, entities] = await Promise.all([
        hass.callWS({ type: 'optim_energy/tree/get', ...(client ? { client } : {}) }),
        reg('label'), reg('device'), reg('entity'), loadPriceMemory(hass, true),
      ]);
      if (payload) { PORTAL.client = payload.client; PORTAL.clientName = payload.client_name || ''; }
      NATIVE = serverPlaces(payload?.tree, Array.isArray(labels) ? labels : []);
      LABELS = Array.isArray(labels) ? labels : [];
      // Home Assistant only ships the device/entity registry to admins. The
      // server has already filtered these lists for this tenant.
      try { hass.devices = Object.fromEntries((devices || []).map((d) => [d.id, d])); hass.entities = Object.fromEntries((entities || []).map((e) => [e.entity_id, e])); } catch (e) { /* read-only test host */ }
      setTree(payload?.tree);
      restoreLocation();
      modelFrom = null;
      syncModel(hass);
      PORTAL.treeReady = true;
      announceTree();
      needLocation();
      return payload;
    } catch (e) {
      console.warn('Optim Energy: could not load the tenant tree', e);
      PORTAL.treeReady = true;
      PORTAL.error = 'The portal settings could not be loaded. An administrator can check the Home Assistant log.';
      announceTree();
      return null;
    }
  });
  return treeLoad;
}
// With locations set up, nothing shows until one is chosen, so every page starts from the choice.
function needLocation() {
  if (typeof location === 'undefined') return;
  if (!PORTAL.isRoot && PORTAL.role === 'user' && (PORTAL.locations || []).length <= 1) {
    const only = (PORTAL.locations || [])[0] || TREE.places.find((p) => p.kind === 'location')?.id || null;
    if (only) setLocation(only);
    if (/^\/energy-locations(?:\/|$)/.test(location.pathname)) {
      history.replaceState(null, '', HOME_PATH);
      window.dispatchEvent(new CustomEvent('location-changed', { bubbles: true, composed: true }));
      return;
    }
  }
  // Administration needs no location. Its bare address opens on the list of tenants.
  if (PORTAL.isRoot && /^\/energy-admin(?:\/|$)/.test(location.pathname)) {
    if (/^\/energy-admin\/?$/.test(location.pathname)) {
      history.replaceState(null, '', ADMIN_HOME_PATH);
      window.dispatchEvent(new CustomEvent('location-changed', { bubbles: true, composed: true }));
    }
    return;
  }
  // Only once the account is known: before that nobody counts as an administrator yet.
  if (PORTAL.ready && !PORTAL.isRoot && /^\/energy-admin(?:\/|$)/.test(location.pathname)) {
    history.replaceState(null, '', START_PATH);
    window.dispatchEvent(new CustomEvent('location-changed', { bubbles: true, composed: true }));
    return;
  }
  if (currentLocation || !hasLocations()) return;
  if (!NEEDS_LOCATION.test(location.pathname)) return;
  history.replaceState(null, '', START_PATH);
  window.dispatchEvent(new CustomEvent('location-changed', { bubbles: true, composed: true }));
}
if (typeof window !== 'undefined') window.addEventListener('location-changed', needLocation);
if (typeof window !== 'undefined') window.addEventListener('location-changed', () => { if (HASS && PORTAL.isRoot) syncSidebar(HASS); });
// Saves a Setup change, says so, and offers to put it back.
async function commitTree(card, next, label) {
  const r = card.shadowRoot, err = r.getElementById('err') || { textContent: '' }, before = JSON.parse(JSON.stringify(TREE));
  err.textContent = '';
  r.activeElement?.blur();
  try { await saveTree(card._hass, next); showToast(card, label || 'Saved', before); } catch (e) { err.textContent = 'Could not save the change. Try again.'; card.paint(); }
}
function showToast(card, text, before) {
  const r = card.shadowRoot;
  let t = r.getElementById('toast');
  if (!t) {
    t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status');
    t.addEventListener('click', async (e) => { if (!e.target.closest('button') || !t._before) return; const was = t._before; t._before = null; try { await (typeof was === 'function' ? was() : saveTree(card._hass, was)); showToast(card, 'Undone'); } catch (x) { showToast(card, 'Could not undo. Try again.', was); } });
    r.querySelector('.w').append(t);
  }
  t._before = before || null;
  t.hidden = false;
  t.innerHTML = `<span>${esc(text)}</span>${before ? '<button>Undo</button>' : ''}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; t._before = null; }, 8000);
}
async function saveTree(hass, next) {
  const tree = { ...next, mains: currentLocation ? { ...next.mains, [currentLocation]: next.main } : next.mains || {}, known: [...new Set([...(TREE.known || []), ...nodeIds, ...next.virtual.map((v) => v.id)])] };
  await hass.callWS({ type: 'optim_energy/tree/save', tree, ...(PORTAL.isRoot && portalClient ? { client: portalClient } : {}) });
  setTree(tree);
  syncModel(hass);
  announceTree();
  syncSums(hass);
}
// Each virtual device is also two Home Assistant Sum helpers, energy and power, so it can be used in automations, cards and alert rules.
// Their members are the real devices it adds up. The portal's own figures never read them: a new helper has no history.
// TREE.sums: virtual id -> { energy: { entry, entity, members }, power: { ... } }.
// ponytail: renaming a virtual device does not rename its helpers, and a change made to a helper in Home Assistant is not read back.
function sumPlan(tree, devices, readings) {
  const want = {}, drop = [];
  for (const v of tree.virtual) {
    if (!devices.some((d) => d.id === v.id)) continue; // another location: left as it is
    const parts = readings(v.id);
    want[v.id] = { name: v.name, energy: [...new Set(parts.map((d) => d.energy).filter(Boolean))].sort(), power: [...new Set(parts.map((d) => d.power).filter(Boolean))].sort() };
  }
  for (const [id, h] of Object.entries(tree.sums || {})) if (!tree.virtual.some((v) => v.id === id)) for (const k of ['energy', 'power']) if (h[k]) drop.push(h[k].entry);
  return { want, drop };
}
async function groupFlow(hass, name, members) {
  const f = await hass.callApi('POST', 'config/config_entries/flow', { handler: 'group' });
  await hass.callApi('POST', `config/config_entries/flow/${f.flow_id}`, { next_step_id: 'sensor' });
  const r = await hass.callApi('POST', `config/config_entries/flow/${f.flow_id}`, { name, entities: members, hide_members: false, type: 'sum' });
  if (r.type !== 'create_entry') throw new Error('not created');
  return r.result.entry_id;
}
// An options change keeps every other setting as it was.
async function groupMembers(hass, entry, members) {
  const f = await hass.callApi('POST', 'config/config_entries/options/flow', { handler: entry });
  const keep = Object.fromEntries((f.data_schema || []).map((x) => [x.name, x.description?.suggested_value ?? x.default]).filter(([, v]) => v !== undefined));
  const r = await hass.callApi('POST', `config/config_entries/options/flow/${f.flow_id}`, { ...keep, entities: members });
  if (r.type !== 'create_entry') throw new Error('not changed');
}
let sumsBusy = false, sumsAgain = false;
async function syncSums(hass) {
  if (!portalCanManage()) return;
  if (sumsBusy) { sumsAgain = true; return; }
  sumsBusy = true;
  try {
    const { want, drop } = sumPlan(TREE, DEVICES, readingsOf), sums = JSON.parse(JSON.stringify(TREE.sums || {}));
    if (!portalCanManageHA()) {
      let changed = false;
      for (const [id, helpers] of Object.entries(sums)) {
        if (TREE.virtual.some((v) => v.id === id)) continue;
        for (const kind of ['energy', 'power']) if (helpers[kind]?.entry) {
          await hass.callWS({ ...clientArg(), type: 'optim_energy/helper/sum/delete', virtual_id: id, kind }).catch(() => {});
          changed = true;
        }
      }
      for (const [id, wanted] of Object.entries(want)) for (const kind of ['energy', 'power']) {
        const now = sums[id]?.[kind], members = wanted[kind];
        if (now && now.members.join() === members.join()) continue;
        if (!members.length) {
          if (now?.entry) { await hass.callWS({ ...clientArg(), type: 'optim_energy/helper/sum/delete', virtual_id: id, kind }).catch(() => {}); changed = true; }
          continue;
        }
        const saved = await hass.callWS({ ...clientArg(), type: 'optim_energy/helper/sum/save', virtual_id: id, kind, name: `${wanted.name} ${kind}`, members, ...(now?.entry ? { entry_id: now.entry } : {}) });
        sums[id] = { ...(sums[id] || {}), [kind]: { entry: saved.entry_id, entity: saved.entity_id, members } };
        changed = true;
      }
      if (changed) { treeLoad = null; await ensureTree(hass); }
      sumsBusy = false;
      if (sumsAgain) { sumsAgain = false; syncSums(hass); }
      return;
    }
    let changed = false;
    for (const entry of drop) { await hass.callApi('DELETE', `config/config_entries/entry/${entry}`).catch(() => {}); changed = true; }
    for (const id of Object.keys(sums)) if (!TREE.virtual.some((v) => v.id === id)) delete sums[id];
    for (const [id, w] of Object.entries(want)) for (const k of ['energy', 'power']) {
      const now = sums[id]?.[k], members = w[k];
      if (now && now.members.join() === members.join()) continue;
      if (now && !members.length) { await hass.callApi('DELETE', `config/config_entries/entry/${now.entry}`).catch(() => {}); delete sums[id][k]; changed = true; continue; }
      if (!members.length) continue;
      if (now) await groupMembers(hass, now.entry, members);
      const entry = now?.entry || (await groupFlow(hass, `${w.name} ${k}`, members));
      let entity = now?.entity;
      for (let i = 0; i < 20 && !entity; i += 1) { await new Promise((res) => setTimeout(res, 300)); entity = (await hass.callWS({ type: 'config/entity_registry/list' })).find((x) => x.config_entry_id === entry)?.entity_id; }
      sums[id] = { ...(sums[id] || {}), [k]: { entry, entity: entity || null, members } };
      changed = true;
    }
    if (changed) await saveTree(hass, { ...TREE, sums });
  } catch (e) { console.warn('Portal: could not update the Sum helpers', e); }
  sumsBusy = false;
  if (sumsAgain) { sumsAgain = false; syncSums(hass); }
}
// The device to rename when Wiring next opens, from Edit under Locations and groups.
let wiringFocus = null;
const SHELLY_PHASE = /_phase_([abc])_(power|apparent_power|power_factor|voltage|current|frequency)$/;
const METER_LABEL = 'energy_meter';
// Which reading each entity is, going by the name Zigbee2MQTT gives it.
const READINGS = [['Power', /_power$/, 'W'], ['Apparent power', /_(power_apparent|apparent_power)$/, 'VA'], ['Voltage A', /_voltage_phase_a$/, 'V'], ['Voltage B', /_voltage_phase_b$/, 'V'], ['Voltage C', /_voltage_phase_c$/, 'V'], ['Voltage', /_voltage$/, 'V'], ['Current A', /_current_phase_a$/, 'A'], ['Current B', /_current_phase_b$/, 'A'], ['Current C', /_current_phase_c$/, 'A'], ['Current', /_current$/, 'A'], ['Frequency', /_(ac_)?frequency$/, 'Hz'], ['Power factor', /_power_factor$/, '%'], ['Device temperature', /_temperature$/, '°C'], ['Link quality', /_linkquality$/, 'LQI'], ['Signal strength', /_signal_strength$/, 'dBm'], ['Total energy', /_energy$/, 'kWh']];
let modelFrom = null;
// Rebuilds the device list from Home Assistant's registries, so a meter appears here once it has the energy-meter
// label. Where it sits comes from the portal's own locations and groups. Returns true when something changed.
let HASS = null;
function syncModel(hass) {
  HASS = hass;
  const src = [hass.devices, hass.entities];
  if (src.some((x) => !x) || (modelFrom && src.every((x, i) => x === modelFrom[i]))) return false;
  modelFrom = src;
  // Sensors of any integration. Zigbee2MQTT and Shelly are read by their entity names as before; a device
  // from another provider is read by what its sensors are (device class), whatever they are called.
  const all = Object.values(hass.entities), entities = all.filter((e) => e.entity_id.startsWith('sensor.'));
  const sensorsOf = (id) => entities.filter((e) => e.device_id === id), kidsOf = (id) => Object.values(hass.devices).filter((k) => k.via_device_id === id);
  const classOf = (e) => e.device_class || e.original_device_class || hass.states?.[e.entity_id]?.attributes?.device_class;
  const usable = (e) => !e.entity_category && !e.disabled_by && !e.hidden_by;
  const hasPower = (id) => sensorsOf(id).some((e) => /_power$/.test(e.entity_id) || (usable(e) && classOf(e) === 'power'));
  const toMeter = (d, own, kidSensors = []) => {
    const find = (re) => own.find((e) => re.test(e.entity_id))?.entity_id, shelly = own[0]?.platform === 'shelly';
    // Shelly gives power factor as 0 to 1, not a percentage, so it is kept apart from the Zigbee figure.
    const readings = READINGS.map(([name, re, unit]) => (shelly && name === 'Power factor' ? ['Channel power factor', find(re), ''] : [name, find(re), unit])).filter(([, id]) => id);
    for (const e of kidSensors) {
      const m = SHELLY_PHASE.exec(e.entity_id);
      if (m) readings.push([{ power: `Phase ${m[1].toUpperCase()} power`, apparent_power: `Phase ${m[1].toUpperCase()} apparent power`, power_factor: `Phase ${m[1].toUpperCase()} power factor`, voltage: `Voltage ${m[1].toUpperCase()}`, current: `Current ${m[1].toUpperCase()}`, frequency: 'Frequency' }[m[2]], e.entity_id, { power: 'W', apparent_power: 'VA', voltage: 'V', current: 'A', frequency: 'Hz' }[m[2]] || '']);
    }
    if (!readings.some(([n]) => n === 'Power')) { const e = own.find((x) => usable(x) && classOf(x) === 'power'); if (e) readings.unshift(['Power', e.entity_id, 'W']); }
    if (!readings.some(([n]) => n === 'Total energy')) {
      // Several energy sensors (today, this month, total) are common; the one that only ever counts up is the meter.
      const energy = own.filter((x) => usable(x) && classOf(x) === 'energy'), total = (x) => /total/.test(hass.states?.[x.entity_id]?.attributes?.state_class || '');
      const e = energy.find(total) || energy[0];
      if (e) readings.push(['Total energy', e.entity_id, 'kWh']);
    }
    const read = (name) => readings.find(([n]) => n === name)?.[1];
    const phases = Object.fromEntries(['a', 'b', 'c'].map((x) => [x.toUpperCase(), find(new RegExp(`_energy_phase_${x}$`))]).filter(([, id]) => id));
    return { id: d.id, tagged: (d.labels || []).map((x) => NATIVE?.kinds[x]).find(Boolean), name: d.name_by_user || d.name, type: 'Energy device', model: [d.manufacturer, d.model_id || d.model].filter(Boolean).join(' '), place: placeById(TREE.placed[d.id])?.id || null, power: read('Power'), energy: read('Total energy'), report: `dev:${d.id}`, readings, alive: read('Device temperature') ? [read('Device temperature')] : [], voltages: readings.filter(([n]) => n.startsWith('Voltage')).map(([, id]) => id), frequency: read('Frequency'), apparent: read('Apparent power'), powerFactor: read('Power factor'), temperature: read('Device temperature'), linkQuality: read('Link quality'), alarms: find(/_event$/)?.replace(/^sensor\.|_event$/g, ''), rssi: read('Signal strength'), address: (d.configuration_url || '').replace(/^https?:\/\//, '').replace(/:80\/?$|\/$/g, ''), platform: own[0]?.platform, ...(shelly ? { shelly: true } : {}), ...(Object.keys(phases).length ? { phases } : {}) };
  };
  const channelMeters = [];
  if (NATIVE) TREE.placed = { ...(TREE.virtualPlaced || {}), ...nativePlaced(hass.devices, NATIVE) };
  const inPortal = (d) => (NATIVE ? !!TREE.placed[d.id] && !(d.via_device_id && TREE.placed[d.via_device_id]) : (d.labels || []).includes(METER_LABEL));
  const meters = Object.values(hass.devices).filter(inPortal).map((d) => {
    const kids = kidsOf(d.id);
    if (hasPower(d.id) || !kids.some((k) => hasPower(k.id))) {
      const m = toMeter(d, sensorsOf(d.id), kids.flatMap((k) => sensorsOf(k.id)));
      const sw = switchOf(hass, d);
      if (sw) m.switch = sw;
      m.guess = guessControls(hass, d.id, sw, d.name_by_user || d.name);
      return m;
    }
    const parent = toMeter(d, sensorsOf(d.id).filter((e) => /_signal_strength$/.test(e.entity_id))), parts = kids.filter((k) => hasPower(k.id)).map((k, i) => ({ ...toMeter(k, sensorsOf(k.id)), channelOf: d.id, channel: i, place: parent.place })).filter((p) => p.power && p.energy);
    channelMeters.push(...parts);
    return { ...parent, shelly: true, channels: parts.map((p) => p.id), readings: [...parent.readings, ...parts.flatMap((p) => p.readings.map(([n, id, u]) => [`Channel ${p.channel} ${n.toLowerCase()}`, id, u]))] };
    // A meter needs both figures. A light or switch with no metering is still shown, so it can be
    // switched and scheduled; it simply has no power or energy to report.
  }).filter((m) => m.channels?.length || (m.power && m.energy) || m.switch);
  const virtual = TREE.virtual.map((v) => ({ id: v.id, name: v.name, type: 'Virtual device', model: 'Sum of the devices under it', place: placeById(TREE.placed[v.id])?.id || null, virtual: true, report: `dev:${v.id}` }));
  // A device is called what it is called in Home Assistant, everywhere and for everyone.
  allNodes = [...meters, ...virtual];
  // Only the chosen location exists from here on, so every page, total and alert follows it. With no locations set up yet, all devices show.
  const here = currentLocation ? placesUnder(currentLocation) : null, inScope = (d) => (here ? here.has(d.place) : !hasLocations());
  const ownMeters = meters.filter(inScope), ownVirtual = virtual.filter(inScope), ownChannels = channelMeters.filter(inScope), zigbee = ownMeters.find((m) => !m.shelly);
  const statics = STATIC_DEVICES.map((d) => ({ ...d, place: placePath(zigbee?.place)[0]?.id ?? null })).filter((d) => inScope(d) || (d.link && !hasLocations()));
  DEVICES.splice(0, DEVICES.length, ...ownMeters, ...ownChannels, ...ownVirtual, ...statics);
  nodeIds = new Set([...ownMeters, ...ownVirtual].map((d) => d.id));
  return true;
}
// What the Reports page can open: places with meters, then each meter.
function portalModel(hass) {
  syncModel(hass);
  const list = DEVICES.filter((d) => d.energy && d.power), withChannels = DEVICES.filter((d) => d.channels);
  const meters = Object.fromEntries(list.map((d) => [d.id, { id: d.id, channelOf: d.channelOf || null, energy: d.energy, power: d.power, name: d.name, voltages: d.voltages, frequency: d.frequency, phases: d.phases, powerFactor: d.powerFactor, temperature: d.temperature, linkQuality: d.linkQuality, shelly: d.shelly }]));
  const groupItems = flatPlaces().filter((p) => p.kind !== 'location').map((p) => { const inside = placedDevices(p.id); return { id: `place:${p.id}`, name: esc(placeParts(p.id).group), meters: countedIn(inside).map((d) => d.id), roots: rootsIn(inside) }; }).filter((x) => x.meters.length);
  const main = mainDevice(), building = list.length ? [{ id: 'building', name: placeById(currentLocation) ? esc(placeById(currentLocation).name) : main ? main.name : 'All devices', meters: homeDevices().map((d) => d.id), roots: buildingRoots() }] : [];
  const virtualItems = treeNodes().filter((d) => d.virtual).map((d) => ({ id: d.report, name: d.name, meters: readingsOf(d.id).map((x) => x.id), roots: [d.id] }));
  const views = [{ group: 'Location', items: building }, { group: 'Virtual devices', items: virtualItems }, { group: 'Groups', items: groupItems }, { group: 'Devices', items: [...list.filter((d) => !d.channelOf).map((d) => ({ id: d.report, name: d.name, meters: [d.id], roots: [d.id] })), ...withChannels.map((d) => ({ id: d.report, name: d.name, meters: d.channels, roots: [d.id] }))] }, { group: 'Channels', items: list.filter((d) => d.channelOf).map((d) => ({ id: d.report, name: d.name, meters: [d.id], roots: [] })) }].filter((g) => g.items.length);
  // Reports are about what was measured. A light or switch with no meter is in the portal, but in no report view.
  for (const v of views) v.items = v.items.map((x) => ({ ...x, meters: x.meters.filter((id) => meters[id]) })).filter((x) => x.meters.length);
  return { meters, views };
}
if (typeof window !== 'undefined') {
  window.portalModel = portalModel;
  window.portalTree = { location: () => placeById(currentLocation)?.name || '', changeLocation: () => navigate(START_PATH), ensure: ensureTree, subtree: subtreeOf, breakdown: breakdownRows, silent: (id, states, nowMs) => { const s = deviceStatus(nodeById(id) || {}, states, nowMs); return s.key === 'bad' || s.kind === 'silent'; } };
}


// Switches and automations must redraw at once when they change, not on the slow refresh.
function controlChanged(before, after) {
  return Object.keys(after).some((id) => /^(switch|automation)\./.test(id) && after[id] !== before[id]);
}

// The devices that count towards a place: those in it or in a group inside it. Virtual ones stand for what is under them.
const placedDevices = (id) => { const under = placesUnder(id); return DEVICES.filter((d) => (d.virtual || d.channels || (d.energy && d.power && !d.channelOf)) && under.has(d.place)); };
// One description of a place, whatever its level. No place means the whole location, which reads what Home reads.
// With one meter it shows that meter's details; with several, their sum.
function resolveSpace(id) {
  const p = !id || id === currentLocation ? null : placeById(id), loc = placeById(currentLocation);
  const base = p ? { level: p.kind, id: p.id, name: p.name, path: placePath(p.id) } : { level: 'all', id: currentLocation, name: loc?.name || 'All devices', path: loc ? [loc] : [] };
  const inside = p ? placedDevices(p.id) : [], meters = p ? countedIn(inside) : homeDevices(), roots = p ? rootsIn(inside) : buildingRoots();
  if (!meters.length) return base;
  const m = meters[0], one = meters.length === 1 ? { voltages: m.voltages, frequency: m.frequency, apparent: m.apparent, phases: m.phases } : {};
  return { ...base, ...one, report: p ? `place:${p.id}` : 'building', roots, meters: meters.map((d) => d.id), energies: meters.map((d) => d.energy), powers: meters.map((d) => d.power), energy: meters[0].energy, power: meters[0].power };
}
function spacePower(sp, st) {
  if (!sp.meters) return '—';
  const w = liveReadings(DEVICES.filter((d) => sp.meters.includes(d.id)), st, Date.now()).power;
  return w == null ? 'No reading' : fmtPower({ state: String(w) });
}
function devicePower(d, st) {
  const w = liveReadings([d], st, Date.now()).power;
  return w == null ? 'No reading' : fmtPower({ state: String(w) });
}
// Live figures for any number of meters, from what the meters report. Power adds up. Voltage and frequency are the
// average across meters, each meter counted once. Readings repeat silently, so a value counts if it is under
// 15 minutes old or its meter's power moved in the last 5 minutes.
const LIVE_EXTRAS = [['powerFactor', 'Power factor'], ['temperature', 'Device temperature'], ['linkQuality', 'Link quality']];
function liveReadings(devices, states, nowMs) {
  const age = (id) => nowMs - +new Date(states[id]?.last_updated), num = (id) => parseFloat(states[id]?.state);
  const ids = (d, label) => (d.readings || []).filter(([name]) => name.startsWith(label)).map(([, id]) => id);
  const mean = (a) => (a.length ? a.reduce((t, v) => t + v, 0) / a.length : null);
  const volts = [], freqs = [];
  let power = 0, powerMeters = 0;
  devices = devices.flatMap((d) => (d.channels ? channelsOf(d) : [d]));
  for (const d of devices) {
    const moving = d.shelly || age(d.power) <= 5 * 60000, ok = (id) => Number.isFinite(num(id)) && (moving || age(id) <= 15 * 60000);
    if (ok(d.power)) { power += num(d.power); powerMeters++; }
    const v = ids(d, 'Voltage').filter(ok).map(num), f = ids(d, 'Frequency').filter(ok).map(num);
    if (v.length) volts.push(mean(v));
    if (f.length) freqs.push(mean(f));
  }
  // These only update when they change, so they count for as long as the meter is responding.
  const responding = (d) => { const s = deviceStatus(d, states, nowMs); return s.key === 'ok' || s.kind === 'delayed'; };
  const extras = {};
  for (const [key, label] of LIVE_EXTRAS) {
    const have = devices.filter((d) => ids(d, label).length);
    extras[key] = mean(have.filter(responding).map((d) => num(ids(d, label)[0])).filter(Number.isFinite));
    extras[`${key}Meters`] = have.length;
    extras[`${key}Names`] = have.map((d) => d.name);
  }
  return { power: powerMeters ? power : null, powerMeters, voltage: mean(volts), voltageMeters: volts.length, frequency: mean(freqs), frequencyMeters: freqs.length, ...extras };
}
const showPowerFactor = (v) => `${Math.round(v)}%`, showTemperature = (v) => `${Math.round(v * 10) / 10} °C`, showLinkQuality = (v) => `${Math.round(v)} of 255`;
// Only the readings these meters actually report.
function qualityRows(q) {
  const named = (n, plain, avg) => (n > 1 ? avg : plain);
  return [
    [q.powerFactorMeters, named(q.powerFactorMeters, 'Power factor', 'Average power factor'), q.powerFactor, showPowerFactor],
    [q.temperatureMeters, named(q.temperatureMeters, `Device temperature, ${q.temperatureNames?.[0]}`, 'Average device temperature'), q.temperature, showTemperature],
    // Signal belongs to one meter, so several are never averaged.
    [q.linkQualityMeters === 1, 'Link quality', q.linkQuality, showLinkQuality],
  ].filter(([n]) => n).map(([, name, v, show]) => [name, v == null ? 'No reading' : show(v)]);
}
function mergeEnergy(list) {
  if (list.length === 1) return list[0];
  const out = { today: Array(24).fill(null), yesterday: Array(24).fill(null), current: list[0].current, days: new Map() };
  for (const b of list) {
    for (const key of ['today', 'yesterday']) b[key].forEach((v, i) => { if (v != null) out[key][i] = (out[key][i] || 0) + v; });
    for (const [d, kwh] of b.days) out.days.set(d, (out.days.get(d) || 0) + kwh);
  }
  out.todayTotal = list.reduce((a, b) => a + b.todayTotal, 0);
  out.yesterdayTotal = list.reduce((a, b) => a + b.yesterdayTotal, 0);
  out.dayList = [...out.days].sort(([a], [b]) => (a < b ? -1 : 1)).slice(-7).map(([day, kwh]) => ({ day, kwh, isToday: day === list[0].dayKey }));
  return out;
}
// Home page totals: every registered meter added together, from recorded data.
const HOUR_MS = 3600000;
// The hour in progress is how far the meter's own counter has moved since the hour began.
function hourSoFar(energyPts) {
  const E = energyPts.filter((p) => Number.isFinite(p.v));
  if (!E.length) return 0;
  const sofar = E[E.length - 1].v - E[0].v;
  return sofar >= 0 && sofar < 20 ? sofar : 0;
}
const historyPts = (raw, id) => (raw[id] || []).map((r) => ({ t: (r.lu ?? r.lc) * 1000, v: parseFloat(r.s) }));
function withLiveHour(b, kwh) {
  const diff = kwh - (b.today[b.current] || 0);
  b.today[b.current] = kwh;
  b.todayTotal += diff;
  b.days.set(b.dayKey, (b.days.get(b.dayKey) || 0) + diff);
  b.dayList = [...b.days].sort(([x], [y]) => (x < y ? -1 : 1)).slice(-7).map(([day, v]) => ({ day, kwh: v, isToday: day === b.dayKey }));
  return b;
}
// A meter that was offline reports everything it counted meanwhile in its first row back. That energy is real,
// so it is spread over the rows it was missing instead of being thrown away as a spike. A jump too big even for that stays out.
function spreadCatchUp(energy, power, step = HOUR_MS) {
  if (!energy?.length || !power?.length) return energy || [];
  const at = (r) => +new Date(r.start), seen = power.map(at).sort((a, b) => a - b), maxAt = new Map(power.map((r) => [at(r), r.max]));
  const peaks = power.map((r) => r.max).filter((x) => x != null), top = peaks.length ? Math.max(...peaks) : null, hours = step / HOUR_MS;
  const ceiling = (w) => (w == null ? 5 * Math.max(hours, 1) : (w / 1000) * 2 * hours + 0.1);
  const out = [];
  let i = 0;
  for (const r of energy) {
    const t = at(r), v = r.change || 0;
    while (i < seen.length && seen[i] < t) i += 1;
    const prev = i ? seen[i - 1] : null, missing = prev == null ? 0 : Math.round((t - prev) / step) - 1;
    if (missing < 1 || v <= ceiling(maxAt.get(t)) || energy.some((x) => at(x) > prev && at(x) < t)) { out.push(r); continue; }
    const share = v / (missing + 1);
    if (share > ceiling(top)) { out.push(r); continue; }
    for (let k = 1; k <= missing; k += 1) out.push({ start: prev + k * step, change: share, spread: true });
    out.push({ ...r, change: share, spread: true });
  }
  return out;
}
if (typeof window !== 'undefined') window.spreadCatchUp = spreadCatchUp;
function combineTotals(meters, nowMs, tz, priceAt = null) {
  const dayOf = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ms));
  const today = dayOf(nowMs), month = today.slice(0, 7), hourStart = nowMs - (nowMs % HOUR_MS);
  const hours = new Map(), peaks = new Map(), trend = new Map();
  let live = 0, liveW = 0;
  for (const m of meters) {
    const stuck = new Set(m.power.filter((r) => { const t = +new Date(r.start); return t >= hourStart ? m.lastPowerUpdate < t : r.min != null && r.min === r.max; }).map((r) => +new Date(r.start)));
    const maxAt = new Map(m.power.map((r) => [+new Date(r.start), r.max]));
    const real = m.power.filter((r) => r.max != null && !stuck.has(+new Date(r.start))).map((r) => r.max), top = real.length ? Math.max(...real) : null;
    for (const r of m.energy) {
      const t = +new Date(r.start), v = r.change || 0, limit = stuck.has(t) ? top : maxAt.get(t), cap = limit == null ? 5 : (limit / 1000) * 2 + 0.1;
      if (t < hourStart && v > 0 && v <= cap) hours.set(t, (hours.get(t) || 0) + v);
    }
    // Devices peak at different moments, so adding their highest readings overstates it. Several devices use their hourly averages.
    for (const r of m.power) { const t = +new Date(r.start), w = meters.length > 1 ? r.mean : r.max; if (w != null && !stuck.has(t)) peaks.set(t, (peaks.get(t) || 0) + w); }
    for (const r of m.fine || []) { const t = +new Date(r.start); if (r.mean != null && !stuck.has(t - (t % HOUR_MS)) && t >= nowMs - 24 * HOUR_MS) trend.set(t, (trend.get(t) || 0) + r.mean); }
    live += hourSoFar(m.energyPts || []);
    liveW += m.liveW || 0;
  }
  let todayKwh = live, monthKwh = live, todayEur = priceAt ? live * priceAt(nowMs) : null, monthEur = todayEur;
  const dayKwh = new Map([[today, live]]), dayEur = new Map([[today, todayEur || 0]]);
  const points = [];
  for (const [t, v] of [...hours].sort(([a], [b]) => a - b)) {
    if (dayOf(t) === today) { todayKwh += v; if (priceAt) todayEur += v * priceAt(t); }
    if (priceAt) { const d = dayOf(t); dayKwh.set(d, (dayKwh.get(d) || 0) + v); dayEur.set(d, (dayEur.get(d) || 0) + v * priceAt(t)); }
    if (dayOf(t).slice(0, 7) === month) { monthKwh += v; if (priceAt) monthEur += v * priceAt(t); }
    if (dayOf(t) === today) points.push([t, v]);
  }
  points.push([nowMs, live]);
  let peak = null;
  for (const [t, w] of peaks) if (dayOf(t).slice(0, 7) === month && (!peak || w > peak.w)) peak = { w, t };
  // The start of each of today's local hours, so a chart's hour 0 to 23 can be priced at its own time.
  const hourStarts = new Map();
  for (let t = hourStart - 26 * HOUR_MS; t <= hourStart + 24 * HOUR_MS; t += HOUR_MS) if (dayOf(t) === today) hourStarts.set(Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(t))), t);
  return { today: todayKwh, month: monthKwh, todayEur, monthEur, dayKwh, dayEur, hourStarts, priceAt, live, peak, points, trend: [...[...trend].sort(([a], [b]) => a - b), [nowMs, liveW]] };
}
let totalsCache = null, LAST_TOTALS = null;
// What the charts price with: each of today's hours at its own price, each day at its own average. One price while totals load.
function chartPrice(totals, flat) {
  const at = totals?.priceAt;
  if (!at) return { hour: () => flat, day: () => flat };
  return { hour: (k) => (totals.hourStarts?.has(k) ? at(totals.hourStarts.get(k)) : flat), day: (d) => (totals.dayKwh?.get(d) > 0 ? totals.dayEur.get(d) / totals.dayKwh.get(d) : flat) };
}
async function loadTotals(hass) {
  const nowMs = Date.now(), tz = hass.config.time_zone, list = DEVICES.filter((d) => d.energy && d.power), ids = list.flatMap((d) => [d.energy, d.power]);
  const counted = new Set(homeDevices().map((d) => d.id));
  const hourStart = nowMs - (nowMs % HOUR_MS), iso = (ms) => new Date(ms).toISOString();
  const [hourly, fine, raw] = await Promise.all([
    statsWS(hass, { type: 'recorder/statistics_during_period', start_time: iso(nowMs - 33 * 24 * HOUR_MS), statistic_ids: ids, period: 'hour', types: ['change', 'mean', 'min', 'max'] }),
    statsWS(hass, { type: 'recorder/statistics_during_period', start_time: iso(nowMs - 24 * HOUR_MS), statistic_ids: list.map((d) => d.power), period: '5minute', types: ['mean'] }),
    hass.callWS({ type: 'history/history_during_period', start_time: iso(hourStart), end_time: iso(nowMs), entity_ids: list.map((d) => d.energy), minimal_response: true, no_attributes: true, significant_changes_only: false }),
  ]);
  const pts = (id) => historyPts(raw, id);
  const meters = list.map((d) => {
    const state = hass.states[d.power], updated = d.shelly && Number.isFinite(parseFloat(state?.state)) ? nowMs : +new Date(state?.last_updated), w = parseFloat(state?.state);
    return { energy: spreadCatchUp(hourly[d.energy] || [], hourly[d.power] || []), power: hourly[d.power] || [], fine: fine[d.power] || [], energyPts: pts(d.energy), lastPowerUpdate: updated, liveW: Number.isFinite(w) && nowMs - updated <= 15 * 60000 ? w : 0 };
  });
  // Every device is added up on its own too, so one under another can be compared with it.
  const priceAt = await priceSeries(hass, nowMs - 33 * 24 * HOUR_MS, nowMs);
  const devices = Object.fromEntries(list.map((d, i) => { const one = combineTotals([meters[i]], nowMs, tz, priceAt); const counting = d.shelly && Number.isFinite(parseFloat(hass.states[d.energy]?.state)); const has = one.today > 0 || meters[i].energyPts.length || counting; return [d.id, { today: has ? one.today : null, todayEur: has ? one.todayEur : null, month: one.month > 0 || counting ? one.month : null }]; }));
  const stale = (id) => { const s = deviceStatus(nodeById(id), hass.states, nowMs); return s.key === 'bad' || s.kind === 'silent'; };
  return { ...combineTotals(meters.filter((m, i) => counted.has(list[i].id)), nowMs, tz, priceAt), count: counted.size, firstRow: Math.min(...meters.filter((m, i) => counted.has(list[i].id)).map((m) => m.energy[0]?.start ?? Infinity)), devices, stale, tariff: priceOf(hass) };
}
function portalTotals(hass) {
  syncModel(hass);
  if (totalsCache && Date.now() - totalsCache.at < 50000) return totalsCache.p;
  const p = ensureTree(hass).then(() => loadTotals(hass)).then((t) => { LAST_TOTALS = t; return t; }).catch((e) => { totalsCache = null; throw e; });
  totalsCache = { at: Date.now(), p };
  return p;
}
if (typeof window !== 'undefined') window.portalTotals = portalTotals;
// The location's Home Assistant automations, each with its own on and off.
// What a timed switch automation does, read from its own settings, so one changed in Home Assistant shows as it is. Anything else is not a schedule.
function parseSchedule(cfg) {
  const all = (x) => [].concat(x || []);
  const tr = all(cfg?.triggers || cfg?.trigger).find((x) => (x.trigger || x.platform) === 'time' && typeof x.at === 'string' && /^\d\d:\d\d/.test(x.at));
  const act = all(cfg?.actions || cfg?.action).find((a) => /^switch\.turn_(on|off)$/.test(a.action || a.service || ''));
  if (!tr || !act) return null;
  const wd = all(cfg.conditions || cfg.condition).find((c) => c.condition === 'time' && c.weekday);
  return { at: tr.at.slice(0, 5), how: /on$/.test(act.action || act.service) ? 'on' : 'off', days: wd ? DAY_KEY.filter((d) => all(wd.weekday).includes(d)) : [...DAY_KEY] };
}
const AUTO_CFG = {};
const portalAutomations = () => TREE.automations;
const automationsIn = (sp) => { const under = placesUnder(sp.id); return portalAutomations().filter((a) => under.has(a.place)); };
const BELL_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21,19V20H3V19L5,17V11C5,7.9 7.03,5.17 10,4.29C10,4.19 10,4.1 10,4A2,2 0 0,1 12,2A2,2 0 0,1 14,4C14,4.1 14,4.19 14,4.29C16.97,5.17 19,7.9 19,11V17L21,19M14,21A2,2 0 0,1 12,23A2,2 0 0,1 10,21"/></svg>';
const DAY_KEY = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
function daysText(days) {
  if (!days || days.length === 7) return 'Every day';
  const k = days.join();
  if (k === 'mon,tue,wed,thu,fri') return 'Mon to Fri';
  if (k === 'sat,sun') return 'Weekends';
  return days.map((d) => DAY_KEY.indexOf(d)).map((i) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i]).join(', ');
}
// One timed switch as a Home Assistant automation. Changing one keeps which switches it drives.
// ponytail: a new schedule drives the group's switches as they are when saved. Re-save it after moving devices, or resolve them at run time if that gets annoying.
function scheduleConfig(base, { alias, how, at, days, switches }) {
  const action = `switch.turn_${how}`;
  return {
    mode: 'single', description: 'Made in the portal', ...(base || {}), alias,
    triggers: [{ trigger: 'time', at: `${at}:00` }],
    conditions: days.length === 7 ? [] : [{ condition: 'time', weekday: days }],
    // The chosen switches replace the ones it had; anything else in it is kept.
    actions: base?.actions?.some((a) => /^switch\.turn_/.test(a.action || '')) ? base.actions.flatMap((a, i, all) => (!/^switch\.turn_/.test(a.action || '') ? [a] : all.findIndex((x) => /^switch\.turn_/.test(x.action || '')) === i ? [{ ...a, action, target: { ...a.target, entity_id: switches } }] : [])) : [...(base?.actions || []), { action, target: { entity_id: switches } }],
  };
}
// ponytail: the time and days shown are the ones saved here. A change made directly in Home Assistant's settings does not show until it is saved here.
// Today 18:00, Yesterday 18:00, or Tue 4 Nov 18:00.
function whenShort(t, nowMs = Date.now()) {
  const d = new Date(t), day = (x) => new Date(x).toDateString(), hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (day(t) === day(nowMs)) return `today ${hm}`;
  if (day(t) === day(nowMs - 86400000)) return `yesterday ${hm}`;
  return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${hm}`;
}
// An automation's own name, without the location it was saved under.
function autoTitle(a) {
  const loc = placePath(a.place)[0]?.name, n = a.name || '';
  return (loc && n.startsWith(`${loc}: `) ? n.slice(loc.length + 2) : n) || placeById(a.place)?.name || 'Automation';
}
function scheduleRow(a, st, admin, note = '') {
  const e = st[a.entity], on = e?.state === 'on', name = autoTitle(a), ran = e?.attributes?.last_triggered ? ` · Last ran ${whenShort(+new Date(e.attributes.last_triggered))}` : '', where = a.place && a.place !== placePath(a.place)[0]?.id ? `${esc(placeById(a.place)?.name || '')} · ` : '';
  const sw = e ? `<button class="sw${on ? ' on' : ''}" role="switch" aria-checked="${on}" data-auto="${a.entity}" data-on="${on}" aria-label="${esc(name)} at ${a.at}"><i></i></button>` : '<span class="muted">Not found</span>';
  return `<div class="sc${on ? '' : ' off'}"><button class="st" ${a.custom ? `data-ha-auto="${e?.attributes?.id || ''}"` : `data-sched="${a.entity}"`}${admin ? '' : ' disabled'}><b>${a.at || '·'}</b><span><b>${esc(name)}</b><small>${where}${a.custom ? 'Made in Home Assistant' : `Turn ${a.how || 'off'} · ${daysText(a.days)}`}${ran}${note}</small></span></button>${sw}</div>`;
}
// The switches an automation acts on, from its own actions.
const cfgSwitches = (cfg) => (cfg?.actions || []).filter((a) => /^switch\./.test(a.action || '')).flatMap((a) => [].concat(a.target?.entity_id || []));
// A switch as a person knows it, with the type of the device behind it.
function switchInfo(hass, id) { const d = allNodes.find((x) => x.switch === id); return { id, name: d?.name || hass.states[id]?.attributes?.friendly_name || id, kind: d ? kindOf(d) : 'relay' }; }
// Turning an automation on or off says so, and can be undone.
function toggleAutomation(card, entity, isOn) {
  const h = card._hass, name = placeById(portalAutomations().find((a) => a.entity === entity)?.place)?.name || 'Automation', set = (on) => h.callService('automation', on ? 'turn_on' : 'turn_off', { entity_id: entity });
  set(!isOn).then(() => showToast(card, `${name}: automation ${isOn ? 'off' : 'on'}`, () => set(isOn))).catch(() => showToast(card, 'Could not change it. Try again.'));
}
const schedulesSorted = (list) => [...list].sort((a, b) => (a.at || '~').localeCompare(b.at || '~'));
function inSpace(item, sp) {
  return !sp.id || placesUnder(sp.id).has(item.place);
}
function devicesIn(sp) {
  return sp.level === 'all' ? DEVICES : DEVICES.filter((d) => inSpace(d, sp));
}
// Safe by default: only a real light entity or an explicit Light label makes a switch a light.
// What a device is for. Measuring is not a type: any device that measures counts in energy, whatever its type.
// An admin's choice wins; otherwise a real HA light entity. Other switches are relays. Without a relay it can only be a meter.
const KINDS = [['meter', 'Energy meter', 'mdi:meter-electric-outline'], ['lights', 'Light', 'mdi:lightbulb'], ['socket', 'Socket', 'mdi:power-socket-eu'], ['relay', 'Relay', 'mdi:electric-switch'], ['ac', 'AC', 'mdi:air-conditioner']];
const KIND_LABEL = Object.fromEntries(KINDS.map(([k, n]) => [k, n]));
const OLD_KIND = { appliance: 'relay', none: 'meter' };
function guessControls(hass, deviceId, switchId, name) {
  const ids = [deviceId, ...Object.values(hass.devices || {}).filter((k) => k.via_device_id === deviceId).map((k) => k.id)];
  const ents = Object.values(hass.entities || {}).filter((e) => ids.includes(e.device_id));
  if (ents.some((e) => e.entity_id.startsWith('climate.'))) return 'ac';
  if (ents.some((e) => e.entity_id.startsWith('light.'))) return 'lights';
  if (!switchId) return 'meter';
  if (hass.states?.[switchId]?.attributes?.device_class === 'outlet') return 'socket';
  return 'relay';
}
const kindOf = (d) => {
  if (!d.switch && d.guess !== 'ac') return 'meter';
  const saved = TREE.kinds?.[d.id];
  return d.tagged || OLD_KIND[saved] || saved || d.guess || 'relay';
};
// Renaming a device and moving it between this client's locations and groups, for whoever manages the client.
function deviceManageHtml(d) {
  if (!portalCanManage() || !NATIVE || d.virtual || d.link || d.channelOf) return '';
  const spots = TREE.places.filter((p) => p.kind === 'location').sort(byName).flatMap((l) => [l.id, ...[...placesUnder(l.id)].filter((x) => x !== l.id)]), name = d.fullName || d.name;
  return `<h3>Name and place</h3><div class="kvl manage"><label>Name<input id="dname" maxlength="80" value="${esc(name)}" autocomplete="off"></label><label>Location or group<select id="dplace">${spots.map((p) => `<option value="${esc(p)}"${p === d.place ? ' selected' : ''}>${esc(placeLabel(p))}</option>`).join('')}</select></label></div><button data-save-device="${esc(d.id)}" data-was-name="${esc(name)}" data-was-place="${esc(d.place || '')}">Save name and place</button><span class="err" id="dmsg"></span>`;
}
const typeLabel = (d) => (d.virtual ? 'Virtual' : d.link ? d.type : KIND_LABEL[kindOf(d)]);
// Everything that is not lights stays out of All off and the group buttons.
const isKept = (d) => kindOf(d) !== 'lights';
// ponytail: only the 1PM's relay is a light circuit. The relay on EM and Pro EM models controls something else, and AIoT does not offer it either.
const switchOf = (hass, d) => {
  const own = Object.values(hass.entities).filter((e) => e.device_id === d.id);
  if (own.some((e) => e.platform === 'shelly')) return /1PM/.test(d.model || '') ? own.find((e) => e.platform === 'shelly' && e.entity_id.startsWith('switch.'))?.entity_id : undefined;
  // Any other provider: the device's own on/off entity, not a configuration or diagnostic toggle.
  return own.find((e) => /^(switch|light)\./.test(e.entity_id) && !e.entity_category && !e.disabled_by && !e.hidden_by)?.entity_id;
};
// The 3D view: rooms packed in rows on one floor, each sized by its number of lights, lights placed evenly inside.
// ponytail: a stylised plan, not the real one. A real floor plan (Sweet Home 3D and floor3d-card) replaces it if this proves useful.
function layoutRooms(rooms) {
  const sized = rooms.map((r) => { const n = r.lights.length, w = Math.min(7, Math.max(3, 2 + n * 0.7)), d = n > 6 ? 4 : 3; return { ...r, w, d }; });
  const rowMax = Math.max(8, Math.sqrt(sized.reduce((t, r) => t + (r.w + 0.4) * (r.d + 0.4), 0)) * 1.05), gap = 0.4, out = [];
  let x = 0, y = 0, rowD = 0;
  for (const r of sized) {
    if (x > 0 && x + r.w > rowMax) { x = 0; y += rowD + gap; rowD = 0; }
    const cols = Math.ceil(Math.sqrt(r.lights.length * r.w / r.d)) || 1, rows = Math.ceil(r.lights.length / cols) || 1;
    const spots = r.lights.map((l, i) => ({ ...l, x: x + (r.w * ((i % cols) + 0.5)) / cols, y: y + (r.d * (Math.floor(i / cols) + 0.5)) / rows }));
    out.push({ ...r, x0: x, y0: y, x1: x + r.w, y1: y + r.d, spots });
    x += r.w + gap; rowD = Math.max(rowD, r.d);
  }
  return out;
}
// Only what is placed under it, so the whole location can never reach another location's switches.
function switchesIn(sp) {
  const under = placesUnder(sp.id);
  return devicesIn(sp).filter((d) => d.switch && under.has(d.place));
}
// What a group's tile, All on, All off and a new schedule act on: everything except what is kept out of them.
const groupSwitches = (sp) => switchesIn(sp).filter((d) => !isKept(d));
const liveSwitches = (sp, st) => groupSwitches(sp).filter((d) => st[d.switch] && st[d.switch].state !== 'unavailable');
// A device as people count it: a channel is part of its device.
const isMeasuring = (d) => (d.power || d.channels) && !d.channelOf;
const fmtDay = (ms, h) => new Date(ms).toLocaleDateString('en-CA', { timeZone: h.config.time_zone });
const powerText = (w) => (w == null ? 'No reading' : Math.abs(w) >= 1000 ? `${(w / 1000).toFixed(1)} kW` : `${Math.round(w)} W`);
// What Home shows under Right now, all from the devices' own readings.
function nowPanel(states, nowMs) {
  const roots = buildingRoots(), parts = homeDevices(), live = liveReadings(parts, states, nowMs);
  const entry = (d) => ({ id: d.id, name: d.name, report: d.report, w: liveReadings(readingsOf(d.id), states, nowMs).power });
  const expand = (id) => (nodeById(id)?.virtual ? childrenOf(id).flatMap((c) => expand(c.id)) : [id]);
  // The levels directly under the main device, when they are groupings of their own rather than the devices listed below.
  const levels = roots.length === 1 ? childrenOf(roots[0]) : roots.map(nodeById).filter(Boolean);
  // One device at the top says nothing about where the power goes, so look one level down.
  let top = [...new Set(roots.flatMap(expand))];
  if (top.length === 1) { const under = childrenOf(top[0]).flatMap((c) => expand(c.id)); if (under.length) top = under; }
  const biggest = top.map(nodeById).filter(Boolean).map(entry).filter((x) => x.w != null).sort((a, b) => b.w - a.w).slice(0, 3);
  // Power factor is active power over apparent power. An average of phases would let an unused phase drag it down.
  const num = (id) => parseFloat(states[id]?.state), withApparent = parts.filter((d) => d.shelly && Number.isFinite(num(d.apparent)) && Number.isFinite(num(d.power)));
  const apparent = withApparent.reduce((t, d) => t + num(d.apparent), 0), active = withApparent.reduce((t, d) => t + num(d.power), 0);
  const pf = apparent > 0 ? Math.min(1, Math.abs(active) / apparent) : live.powerFactor == null ? null : live.powerFactor / 100;
  const has = (label) => parts.some((d) => (d.readings || []).some(([n]) => n.startsWith(label)));
  return { tops: top, main: mainDevice()?.name || null, total: live.power, split: levels.some((d) => d.virtual) ? levels.map(entry) : [], biggest, voltage: live.voltage, frequency: live.frequency, pf, hasVoltage: has('Voltage'), hasFrequency: has('Frequency') };
}
function deviceHealth(states, nowMs) {
  const list = DEVICES.filter(isMeasuring).map((d) => deviceStatus(d, states, nowMs));
  return { total: list.length, online: list.filter((s) => s.key === 'ok' || s.kind === 'delayed').length };
}
// Hourly rows into today, yesterday and recent days. Hours above 20 kWh are meter catch-up, not use.
function bucketEnergy(rows, reading, nowMs, tz) {
  const dayOf = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ms));
  const hourOf = (ms) => +new Date(ms).toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' });
  const today = dayOf(nowMs), yesterday = dayOf(nowMs - 86400000);
  const out = { today: Array(24).fill(null), yesterday: Array(24).fill(null), current: hourOf(nowMs), days: new Map(), dayKey: today };
  for (const r of rows) {
    const t = +new Date(r.start), d = dayOf(t), h = hourOf(t), v = r.change > 0 && r.change < 20 ? r.change : 0;
    if (d === today) out.today[h] = v; else if (d === yesterday) out.yesterday[h] = v;
    out.days.set(d, (out.days.get(d) || 0) + v);
  }
  const last = rows[rows.length - 1];
  if (out.today[out.current] == null && last && Number.isFinite(reading) && last.state != null) {
    const v = reading - last.state;
    out.today[out.current] = v >= 0 && v < 20 ? v : 0;
    if (out.today[out.current] > 0) out.days.set(today, (out.days.get(today) || 0) + out.today[out.current]);
  }
  out.todayTotal = out.today.reduce((a, v) => a + (v || 0), 0);
  out.yesterdayTotal = out.yesterday.reduce((a, v) => a + (v || 0), 0);
  out.dayList = [...out.days].sort(([a], [b]) => (a < b ? -1 : 1)).slice(-7).map(([day, kwh]) => ({ day, kwh, isToday: day === today }));
  return out;
}
// Meters that report their own alarms; the others only raise offline and no-data alerts.
// ponytail: only the `_event` and `_threshold` entities the Tongou has. Add other models when one is installed.
const alarmMeters = () => DEVICES.filter((d) => d.alarms);
const networkPlace = () => { const c = DEVICES.find((d) => d.link); return c ? c.place ?? 'none' : null; };
const whereIs = (d) => `${d.place ? `${esc(placeLabel(d.place))} · ` : ''}${d.name}`;
// Current problems, each tied to where it is so a place can show only its own.
function computeActive(states, nowMs, data) {
  const out = [];
  for (const m of alarmMeters()) {
    const eventId = `sensor.${m.alarms}_event`, ev = states[eventId]?.state;
    if (!isAlarm(ev)) continue;
    const { periods = [], series = {} } = data?.meters?.[m.id] || {};
    const info = alarmInfo(ev), p = periods.find((x) => x.state === ev && x.active), since = p ? p.from : +new Date(states[eventId].last_changed);
    const cur = info.series ? parseFloat(states[`sensor.${m.alarms}_${info.sensor || info.series}`]?.state) : NaN;
    const pts = series[info.series] || [], w = pts.length ? worstIn(pts, since, nowMs, info.above !== false) : (Number.isFinite(cur) ? cur : null);
    const a = assessAlarm(ev, w, info.limit ? states[`number.${m.alarms}_${info.limit}`]?.state : null);
    out.push({ ...a, place: m.place, config: a.config && `${m.id}:${a.config}`, where: whereIs(m), since });
  }
  for (const d of DEVICES.filter(isMeasuring)) {
    const s = deviceStatus(d, states, nowMs);
    if (s.key === 'bad' || (s.key === 'warn' && s.label !== 'Connection dropped')) {
      const delayed = s.kind === 'delayed';
      out.push({ sev: s.key === 'bad' ? 'critical' : 'warn', title: delayed ? `${d.name}: live power not updating` : `${d.name}: not sending readings`, place: d.place, where: whereIs(d), since: states[d.power] ? +new Date(states[d.power].last_updated) : nowMs, what: delayed ? `The device is responding, but its power reading has not changed recently. ${s.label}.` : `This device has stopped sending readings. ${s.label}.`, verdict: delayed ? 'Energy totals are still correct. The live figure may be out of date.' : 'Readings are missing until it reconnects. The device keeps counting energy.', action: delayed ? 'Contact your installer if this lasts more than a few hours.' : 'Check the device has power, then contact your installer.' });
    }
  }
  for (const r of alarmRules()) {
    const e = states[r.entity];
    if (e?.state !== 'on') continue;
    out.push({ sev: r.sev, title: esc(r.name), place: r.place, where: r.place ? esc(placeLabel(r.place)) : '', since: +new Date(e.last_changed), what: 'An alert rule has gone off.', verdict: '', action: 'Check what it watches. An administrator can change the rule in Home Assistant, under Settings, Helpers.' });
  }

  if (networkPlace() && states[BRIDGE]?.state !== 'on') out.push({ sev: 'warn', title: 'Device network reconnecting', place: networkPlace(), where: 'Zigbee coordinator', since: +new Date(states[BRIDGE]?.last_changed || nowMs), what: 'The connection to the devices dropped.', verdict: 'Readings pause for a few seconds. Energy totals are not affected.', action: 'No action needed unless this lasts more than a few minutes.' });
  return out;
}
// Alert rules are made in Home Assistant: a Threshold or Template helper that turns on, with the "Portal alert" label. A "Critical" label makes it red.
// It belongs to the place of its device, or to the location of its area.
function alarmRules() {
  if (!HASS) return [];
  const label = (n) => LABELS.find((l) => cleanName(l.name).toLowerCase() === n)?.label_id, alert = label('portal alert'), crit = label('critical');
  if (!alert) return [];
  return Object.values(HASS.entities).filter((e) => e.entity_id.startsWith('binary_sensor.') && (e.labels || []).includes(alert)).map((e) => {
    const place = TREE.placed[e.device_id] || NATIVE?.locByArea?.[e.area_id] || null;
    return { id: e.entity_id, entity: e.entity_id, sev: (e.labels || []).includes(crit) ? 'critical' : 'warn', name: HASS.states[e.entity_id]?.attributes?.friendly_name || e.entity_id, place };
  });
}
const ALERT_STATS = ['voltage', 'temperature', 'current', 'power'];
// Hours with no power reading at all: the device was offline or sent nothing.
// ponytail: whole hours only, so a drop shorter than an hour is not listed. Raw history would catch it, at many times the download.
function statGaps(rows, nowMs) {
  const t = rows.map((r) => +new Date(r.start)).sort((a, b) => a - b), out = [];
  for (let i = 1; i < t.length; i += 1) if (t[i] - t[i - 1] > HOUR_MS) out.push({ from: t[i - 1] + HOUR_MS, to: t[i] });
  if (t.length && nowMs - t[t.length - 1] > 2 * HOUR_MS) out.push({ from: t[t.length - 1] + HOUR_MS, to: nowMs, active: true });
  return out;
}
// Runs of the location's automations in the last 7 days, from Home Assistant's logbook, each with the switches it changed.
async function fetchRuns(hass) {
  const autos = automationsIn(resolveSpace()), switches = DEVICES.filter((d) => d.switch).map((d) => d.switch);
  if (!autos.length) return [];
  const end = new Date(), start = new Date(+end - 7 * 86400000);
  const ev = await hass.callWS({ type: 'logbook/get_events', start_time: start.toISOString(), end_time: end.toISOString(), entity_ids: [...autos.map((a) => a.entity), ...switches] });
  return autoRuns(ev, autos);
}
function autoRuns(ev, autos) {
  const t = (x) => (typeof x.when === 'number' ? x.when * 1000 : +new Date(x.when));
  return ev.filter((x) => autos.some((a) => a.entity === x.entity_id) && x.context_event_type !== 'automation_triggered' && /triggered/i.test(x.message || '')).map((r) => {
    // A switch it changed shares its context, or at least names it as the cause, within a few minutes.
    const changed = ev.filter((x) => /^switch\./.test(x.entity_id || '') && (x.context_id === r.context_id || (x.context_entity_id === r.entity_id && Math.abs(t(x) - t(r)) < 300000)));
    return { entity: r.entity_id, at: t(r), source: r.source || '', changed: changed.map((x) => ({ entity: x.entity_id, state: x.state })) };
  }).sort((a, b) => b.at - a.at);
}
// Who can be told: Home Assistant's own notifications only, the bell in its sidebar and app.
// ponytail: phones and email were left out on purpose; ruleAutomation still takes any notify service if they are wanted back.
const notifyTargets = (hass) => (hass.services?.notify?.persistent_notification ? [['persistent_notification', 'HA notifications']] : []);
// An alert rule tells people through its own automation. It is not listed among the automations of a location.
// When the rule turns on: a notification in Home Assistant, and a message to each phone or email chosen. When it turns off: the notification goes away.
const ruleAutoId = (rule) => `portal_alert_${rule.split('.')[1]}`;
function ruleAutomation(rule, name, sensor, unit, sev, targets) {
    const now = unit === 'W' ? `{{ (states('${sensor}') | float(0) / 1000) | round(1) }} kW` : `{{ states('${sensor}') }} ${unit}`;
    const message = `${sev === 'critical' ? 'Critical' : 'Warning'}: {{ state_attr('${rule}', 'friendly_name') }}. Now ${now}.`, id = ruleAutoId(rule);
    const on = targets.map((t) => (t === 'persistent_notification'
      ? { action: 'persistent_notification.create', data: { notification_id: id, title: 'Energy alert', message } }
      : { action: `notify.${t}`, continue_on_error: true, data: { title: 'Energy alert', message } }));
    return {
      alias: `Portal alert: ${name}`, description: `Made by the portal for the alert rule ${rule}. It is deleted with the rule.`, mode: 'queued',
      triggers: [{ trigger: 'state', entity_id: rule, from: 'off', to: 'on', id: 'on' }, { trigger: 'state', entity_id: rule, from: 'on', to: 'off', id: 'off' }],
      conditions: [],
      actions: [{ choose: [{ conditions: [{ condition: 'trigger', id: 'on' }], sequence: on }], default: targets.includes('persistent_notification') ? [{ action: 'persistent_notification.dismiss', data: { notification_id: id } }] : [] }],
    };
  }
const ruleTargets = (cfg) => (cfg?.actions?.[0]?.choose?.[0]?.sequence || []).map((a) => (a.action === 'persistent_notification.create' ? 'persistent_notification' : (a.action || '').replace(/^notify\./, ''))).filter(Boolean);
async function fetchAlerts(hass) {
  const end = new Date(), meters = alarmMeters();
  const start = new Date(+end - 7 * 86400000).toISOString();
  const limitId = (m, x) => `number.${m.alarms}_${x.key}_threshold`, statId = (m, k) => `sensor.${m.alarms}_${k}`;
  // 5-minute statistics give the peaks without downloading every raw reading.
  const watched = [...new Map(DEVICES.filter((d) => d.power && !d.virtual).map((d) => [d.channelOf || d.id, d])).entries()];
  const [r, st, hourly] = await Promise.all([
    hass.callWS({ type: 'history/history_during_period', start_time: start, end_time: end.toISOString(), entity_ids: [BRIDGE, ...meters.flatMap((m) => [statId(m, 'event'), ...ALERT_SETTINGS.map((x) => limitId(m, x))]), ...alarmRules().map((x) => x.entity)], minimal_response: true, no_attributes: true }),
    meters.length ? statsWS(hass, { type: 'recorder/statistics_during_period', start_time: start, end_time: end.toISOString(), statistic_ids: meters.flatMap((m) => ALERT_STATS.map((k) => statId(m, k))), period: '5minute', types: ['min', 'max'] }) : {},
    watched.length ? statsWS(hass, { type: 'recorder/statistics_during_period', start_time: start, end_time: end.toISOString(), statistic_ids: watched.map(([, d]) => d.power), period: 'hour', types: ['mean'] }) : {},
  ]);
  const pts = (id) => (r[id] || []).map((x) => ({ s: x.s, t: (x.lu || x.lc) * 1000 }));
  const stat = (id, f) => (st[id] || []).filter((x) => x[f] != null).map((x) => ({ s: String(x[f]), t: +new Date(x.start) }));
  const one = (m) => ({ periods: alarmPeriods(pts(statId(m, 'event')), +end), series: { ...Object.fromEntries(ALERT_SETTINGS.map((x) => [`${x.key}_threshold`, pts(limitId(m, x))])), ...Object.fromEntries(ALERT_STATS.map((k) => [k, stat(statId(m, k), 'max')])), voltage_low: stat(statId(m, 'voltage'), 'min') } });
  const outages = Object.fromEntries(watched.map(([id, d]) => [id, statGaps(hourly[d.power] || [], +end)]).filter(([, g]) => g.length));
  return { outages, net: pts(BRIDGE), meters: Object.fromEntries(meters.map((m) => [m.id, one(m)])), rules: Object.fromEntries(alarmRules().map((x) => [x.id, alarmPeriods(pts(x.entity), +end)])) };
}
const ALERT_CSS = `.astack{display:grid;gap:8px}
.ar{background:var(--panel);border:1px solid color-mix(in srgb,var(--line) 60%,transparent);border-radius:var(--radius);box-shadow:var(--shadow);min-width:0}
.ar summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:12px;padding:12px 14px}.ar summary::-webkit-details-marker{display:none}.ar summary::after{content:"›";margin-left:auto;color:var(--muted);font-size:18px;line-height:1;transition:transform .15s}.ar[open] summary::after{transform:rotate(90deg)}
.ar summary i{width:10px;height:10px;border-radius:50%;background:var(--slate);flex:none}.ar.critical summary i{background:var(--bad)}.ar.warn summary i{background:var(--warn)}.ar summary span{min-width:0}.ar summary b{display:block;font-weight:500;font-size:14.5px;overflow-wrap:anywhere}.ar summary small{display:block;color:var(--muted);font-size:12.5px}
.more{padding:0 14px 12px 36px;font-size:13.5px;display:grid;gap:8px}.more button.cfg{justify-self:start}
.occ{display:grid;gap:3px;font-size:12.5px}.occ div{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--line);padding:3px 0}.occ span:last-child{color:var(--muted);text-align:right}
.clear{display:grid;justify-items:center;gap:8px;padding:48px 0;font-size:16px;font-weight:600}.clear svg{width:48px;height:48px;fill:var(--ok)}
`;
// The same alert view for the Alerts page and each space's Alerts tab.
function alertsHtml(data, st, nowMs, tz, inScope, openSet, hasNet, part) {
  const when = (t) => new Date(t).toLocaleString('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const time = (t) => new Date(t).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  const row = (sev, key, title, meta, body) => `<details class="ar ${sev}" data-group="${esc(key)}"${openSet?.has(key) ? ' open' : ''}><summary><i></i><span><b>${title}</b><small>${meta}</small></span></summary><div class="more">${body}</div></details>`;
  const cfgBtn = (a) => (a.config && portalCanManageHA() ? `<button class="cfg" data-config="${a.config}">Change limit in Home Assistant ›</button>` : '');
  const times = (n) => `${n} time${n > 1 ? 's' : ''}`;
  if (part === 'now') {
    const active = computeActive(st, nowMs, data).filter(inScope);
    return active.length ? `<div class="astack">${active.map((a) => row(a.sev, `now:${a.title}`, a.title, `Since ${when(a.since)}`, `<span>${a.action}</span>${cfgBtn(a)}`)).join('')}</div>` : `<div class="clear">${BELL_SVG}All good</div>`;
  }
  const scoped = DEVICES.filter((d) => isMeasuring(d) && inScope(d));
  const perMeter = scoped.filter((d) => d.alarms).map((m) => { const d = data.meters?.[m.id] || {}; return { m, ...groupAlarms((d.periods || []).filter((p) => !p.active), d.series, nowMs, tz) }; });
  const groups = perMeter.flatMap(({ m, groups: g }) => g.map((x) => ({ ...x, meter: m, key: `${m.id}:${x.state}` }))).sort((x, y) => SEV_RANK[x.assess.sev] - SEV_RANK[y.assess.sev] || y.last - x.last);
  const net = networkSummary(data.net || [], nowMs), netWatch = hasNet && net.day >= 10;
  const occ = (items, u) => `<div class="occ">${items.slice(0, 20).map((p) => `<div><span>${when(p.from)} to ${time(p.to)}</span><span>${duration(p.to - p.from)}${p.worst != null ? ` · ${valueText(Math.round(p.worst * 10) / 10, u || '')}` : ''}</span></div>`).join('')}</div>`;
  const groupHtml = groups.map((g) => { const a = { ...g.assess, config: g.assess.config && `${g.meter.id}:${g.assess.config}` }; return row(a.sev, g.key, a.title, `${g.meter.name} · ${times(g.count)} · last ${when(g.last)}`, `<span>${a.action}</span>${cfgBtn(a)}${occ(g.items, a.unit)}`); }).join('');
  const netHtml = hasNet && net.week ? row(netWatch ? 'warn' : '', 'net', 'Connection drops', `${times(net.week)} · longest ${shortDuration(net.longestMs)}`, netWatch ? 'Happening often. Ask your installer to check the Zigbee coordinator.' : 'Readings pause for a few seconds. Totals are not affected.') : '';
  const ruleHtml = alarmRules().map((r) => {
    const past = (data.rules?.[r.id] || []).filter((p) => !p.active);
    return past.length && inScope(r) ? row(r.sev, `rule:${r.id}`, esc(r.name), `${times(past.length)} · last ${when(past[0].from)}`, occ(past, '')) : '';
  }).join('');
  const outHtml = Object.entries(data.outages || {}).map(([id, list]) => {
    const d = DEVICES.find((x) => x.id === id), past = list.filter((g) => !g.active);
    if (!d || !inScope(d) || !past.length) return '';
    return row('critical', `out:${id}`, `${esc(d.name)}: not sending readings`, `${times(past.length)} · ${duration(past.reduce((t, g) => t + g.to - g.from, 0))} in total · last ${when(past[past.length - 1].from)}`, `<span>Check the device has power and network.</span>${occ([...past].reverse(), '')}`);
  }).join('');
  return outHtml || ruleHtml || groupHtml || netHtml ? `<div class="astack">${outHtml}${ruleHtml}${groupHtml}${netHtml}</div>` : '<span class="muted">No alerts in the last 7 days.</span>';
}
const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Pure helpers, covered by test_schedule.js
function deviceStatus(d, states, nowMs) {
  if (d.virtual || d.channels) {
    const parts = readingsOf(d.id), up = parts.filter((p) => { const s = deviceStatus(p, states, nowMs); return s.key === 'ok' || s.kind === 'delayed'; }).length;
    if (!parts.length) return { key: '', label: 'No devices yet' };
    return up === parts.length ? { key: 'ok', label: 'All online' } : { key: 'warn', label: `${up} of ${parts.length} online` };
  }
  if (d.link) return states[BRIDGE]?.state === 'on' ? { key: 'ok', label: 'Connected' } : { key: 'warn', label: 'Connection dropped' };
  // The Zigbee bridge being down only says something about the devices behind it.
  if (!d.shelly && (!d.platform || d.platform === 'mqtt') && states[BRIDGE]?.state !== 'on') return { key: 'warn', label: 'Connection dropped' };
  const s = states[d.power];
  if (!s || s.state === 'unavailable' || s.state === 'unknown') return { key: 'bad', label: 'Offline' };
  // Home Assistant holds a live connection to a Shelly and marks it unavailable the moment it drops. A steady reading never updates, so age says nothing.
  if (d.shelly) return { key: 'ok', label: 'Online' };
  // Sensors only update when their value changes, so the device is silent only if all of them are old.
  const ages = [d.power, d.energy, ...(d.alive || [])].map((id) => states[id]).filter(Boolean).map((x) => (nowMs - +new Date(x.last_updated)) / 60000);
  const newest = Math.min(...ages), age = (nowMs - +new Date(s.last_updated)) / 60000;
  if (newest > STALE_MIN) return { key: 'warn', label: `No data for ${Math.round(newest)} min`, kind: 'silent' };
  if (age > STALE_MIN) return { key: 'warn', label: `No data for ${Math.round(age)} min`, kind: 'delayed' };
  return { key: 'ok', label: 'Online' };
}
function filterDevices(list, q, place, type) {
  const t = (q || '').trim().toLowerCase();
  const under = place ? placesUnder(place) : null;
  return list.filter((d) => (!under || under.has(d.place)) && (!type || d.type === type) && (!t || `${d.name} ${d.type} ${d.model} ${placeLabel(d.place)}`.toLowerCase().includes(t)));
}
function hm(s) { return (s || '').slice(0, 5); }

const VOLT_LOW = 207, VOLT_HIGH = 253, WARM_C = 45;
const ALARMS = {
  high_temp_alarm: { config: 'temperature', title: 'Device running warm', limit: 'temperature_threshold', unit: '°C', series: 'temperature', above: true },
  over_voltage_alarm: { config: 'over_voltage', title: 'Mains voltage above the alert limit', limit: 'over_voltage_threshold', unit: 'V', series: 'voltage', above: true },
  under_voltage_alarm: { config: 'under_voltage', title: 'Mains voltage below the alert limit', limit: 'under_voltage_threshold', unit: 'V', series: 'voltage_low', sensor: 'voltage' },
  over_current_alarm: { config: 'over_current', title: 'Current above the alert limit', limit: 'over_current_threshold', unit: 'A', series: 'current', above: true },
  over_power_alarm: { config: 'over_power', title: 'Power above the alert limit', limit: 'over_power_threshold', unit: 'W', series: 'power', above: true },
};
function alarmInfo(state) {
  return ALARMS[state] || { title: String(state || '').replace(/_alarm$/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) };
}
// What can be changed on the meter. Each alert is only ever Ignore or Alarm; none of these settings can switch power off.
const ALERT_SETTINGS = [
  { key: 'over_voltage', name: 'High voltage', help: 'Alert when mains voltage rises above this.', sensor: 'voltage', recommended: VOLT_HIGH, above: true },
  { key: 'under_voltage', name: 'Low voltage', help: 'Alert when mains voltage falls below this.', sensor: 'voltage', recommended: VOLT_LOW, above: false },
  { key: 'temperature', name: 'Device temperature', help: 'Alert when the inside of the device gets warmer than this. It is not the room temperature.', sensor: 'temperature', recommended: WARM_C, above: true },
  { key: 'over_current', name: 'High current', help: 'Alert when current on this circuit rises above this.', sensor: 'current', above: true },
  { key: 'over_power', name: 'High power', help: 'Alert when power on this circuit rises above this.', sensor: 'power', above: true },
];
// A value with its unit. W and VA become kW and kVA from 1,000. Everything else stays as it reads.
function valueText(v, u) {
  const n = Number(v);
  if (u === 'W' && Number.isFinite(n)) return powerText(n);
  if (u === 'VA' && Number.isFinite(n)) return Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)} kVA` : `${Math.round(n)} VA`;
  if (u === 'kWh' && Number.isFinite(n)) return `${n.toLocaleString('en-GB', { maximumFractionDigits: n >= 100 ? 1 : 2 })} kWh`;
  return `${v} ${u}`;
}
const SEV_RANK = { critical: 0, warn: 1, info: 2 };
// Plain answers to: what happened, is it a problem, what should I do. worst is the highest (or lowest) value measured.
function assessAlarm(state, worst, limit) {
  const a = alarmInfo(state), u = a.unit || '', has = worst != null && Number.isFinite(worst);
  const reached = has ? `Reached ${valueText(Math.round(worst * 10) / 10, u)}.` : '';
  const lim = limit != null && limit !== '' ? valueText(limit, u) : 'the set limit';
  if (state === 'over_voltage_alarm' || state === 'under_voltage_alarm') {
    const high = state === 'over_voltage_alarm', out = has && (worst > VOLT_HIGH || worst < VOLT_LOW);
    if (out) return { ...a, sev: 'critical', what: `The mains voltage went outside the normal range of ${VOLT_LOW} to ${VOLT_HIGH} V.`, verdict: `${reached} This can damage equipment.`, action: 'Call your electrician or grid operator.' };
    return { ...a, sev: 'info', what: `The mains voltage went ${high ? 'above' : 'below'} the ${lim} limit set on this device.`, verdict: `${reached} That is inside the normal range of ${VOLT_LOW} to ${VOLT_HIGH} V, so this is not a fault.`, action: `The limit is stricter than normal mains. Set it to ${high ? VOLT_HIGH : VOLT_LOW} V to stop these alerts.` };
  }
  if (state === 'high_temp_alarm') {
    const hot = has && worst > WARM_C;
    return { ...a, sev: hot ? 'warn' : 'info', what: `The temperature inside this device rose above its ${lim} limit. It measures the device, not the room.`, verdict: hot ? `${reached} That is warm for equipment in an electrical panel.` : `${reached} That is ordinary for equipment in an electrical panel.`, action: hot ? 'Check the panel has airflow and nothing is overheating.' : 'No action needed. Raise the limit if these alerts are not useful.' };
  }
  if (state === 'over_current_alarm' || state === 'over_power_alarm') return { ...a, sev: 'warn', what: `This circuit went above its ${lim} limit.`, verdict: `${reached} Check what was running at that time.`, action: 'If this repeats, reduce the load and call your electrician.' };
  return { ...a, sev: 'warn', what: 'This device reported an alert.', verdict: reached, action: 'Contact your installer if this continues.' };
}
// Highest or lowest value during a period, counting the value already showing when it began.
function worstIn(points, from, to, above) {
  const before = points.filter((p) => p.t <= from).pop();
  const vals = [...(before ? [before] : []), ...points.filter((p) => p.t > from && p.t <= to)].map((p) => parseFloat(p.s)).filter(Number.isFinite);
  if (!vals.length) return null;
  return above === false ? Math.min(...vals) : Math.max(...vals);
}
function valueAt(points, t) {
  const p = points.filter((x) => x.t <= t && Number.isFinite(parseFloat(x.s))).pop();
  return p ? parseFloat(p.s) : null;
}
// Repeats of one problem become one entry, with its worst value and when it happened on each of the last 7 days.
function groupAlarms(periods, series, nowMs, tz) {
  const dayKey = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(t));
  const days = Array.from({ length: 7 }, (_, i) => dayKey(nowMs - (6 - i) * 86400000));
  const groups = new Map();
  for (const p of periods) {
    const a = alarmInfo(p.state), g = groups.get(p.state) || { state: p.state, count: 0, totalMs: 0, last: 0, worst: null, limit: null, items: [], perDay: Object.fromEntries(days.map((d) => [d, 0])) };
    const pts = (series || {})[a.series] || [], w = worstIn(pts, p.from, p.to, a.above !== false ? true : false);
    if (w != null && (g.worst == null || (a.above !== false ? w > g.worst : w < g.worst))) g.worst = w;
    g.count++; g.totalMs += p.to - p.from;
    if (p.from > g.last) { g.last = p.from; const l = valueAt((series || {})[a.limit] || [], p.from); if (l != null) g.limit = l; }
    const d = dayKey(p.from); if (d in g.perDay) g.perDay[d]++;
    g.items.push({ ...p, worst: w });
    groups.set(p.state, g);
  }
  return { days, groups: [...groups.values()].map((g) => ({ ...g, assess: assessAlarm(g.state, g.worst, g.limit) })).sort((x, y) => SEV_RANK[x.assess.sev] - SEV_RANK[y.assess.sev] || y.last - x.last) };
}
function networkSummary(points, nowMs) {
  const pts = [...points].sort((a, b) => a.t - b.t);
  const dropsAll = [];
  pts.forEach((p, i) => { if (p.s === 'off' && (i === 0 || pts[i - 1].s !== 'off')) { const n = pts.slice(i + 1).find((q) => q.s === 'on'); dropsAll.push({ from: p.t, ms: (n ? n.t : nowMs) - p.t }); } });
  const day = dropsAll.filter((d) => d.from > nowMs - 86400000);
  return { week: dropsAll.length, day: day.length, longestMs: dropsAll.reduce((m, d) => Math.max(m, d.ms), 0), totalMs: dropsAll.reduce((m, d) => m + d.ms, 0) };
}
function shortDuration(ms) { return ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} sec` : duration(ms); }
const isAlarm = (s) => !['normal', 'none', 'off', '', 'unknown', 'unavailable', undefined, null].includes(s);
// Turns state changes into alarm periods. Short gaps, including meter restarts, join one period.
function alarmPeriods(points, endMs, mergeMin = 15) {
  const out = [];
  const pts = [...points].sort((a, b) => a.t - b.t);
  pts.forEach((p, i) => {
    if (!isAlarm(p.s)) return;
    const to = i + 1 < pts.length ? pts[i + 1].t : endMs;
    const last = [...out].reverse().find((x) => x.state === p.s);
    if (last && p.t - last.to <= mergeMin * 60000) { last.to = to; last.count++; last.active = i + 1 >= pts.length; return; }
    out.push({ state: p.s, from: p.t, to, count: 1, active: i + 1 >= pts.length });
  });
  return out.sort((a, b) => b.from - a.from);
}
function networkRestarts(points) {
  return points.filter((p, i) => p.s === 'off' && (i === 0 || points[i - 1].s !== 'off')).length;
}
function duration(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), rest = m % 60;
  if (h < 24) return rest ? `${h} h ${rest} min` : `${h} h`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
const minutes = (s) => { const [a, b] = hm(s).split(':').map(Number); return a * 60 + b; };

const SHEET_CSS = `dialog{border:0;padding:0;margin:auto;width:min(560px,calc(100vw - 32px));max-height:min(86vh,760px);border-radius:16px;background:var(--panel);color:var(--fg);box-shadow:0 18px 50px rgba(0,0,0,.45);overflow:hidden}
dialog[open]{display:flex;flex-direction:column}dialog::backdrop{background:rgba(0,0,0,.5)}
@media(max-width:600px){dialog{width:100vw;max-width:100vw;max-height:92vh;margin:auto 0 0;border-radius:16px 16px 0 0}}
.dh{display:flex;align-items:center;gap:8px;padding:12px 12px 10px 16px;border-bottom:1px solid var(--line)}.dh h3{flex:1;margin:0;font-size:16px;font-weight:600}
.x{all:unset;cursor:pointer;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:20px}.x:hover{background:color-mix(in srgb,var(--fg) 8%,transparent)}.x:focus-visible{outline:2px solid var(--accent)}
.db{flex:1;overflow-y:auto;padding:12px 16px 16px;display:grid;gap:14px;align-content:start;overscroll-behavior:contain}
.df{display:flex;align-items:center;gap:8px;padding:10px 12px calc(10px + env(safe-area-inset-bottom));border-top:1px solid var(--line);background:var(--panel)}.df .sp{flex:1}
.df button{height:36px;padding:0 16px;font-size:14px;border-radius:18px}.df .del{all:unset;cursor:pointer;color:var(--bad);font-size:13.5px;padding:0 6px;height:36px;display:flex;align-items:center}.df .del.armed{font-weight:600}
.lab{font-size:12px;color:var(--muted);margin-bottom:5px;display:flex;justify-content:space-between;gap:8px}
input.nm,select.gp,input.tm{width:100%;box-sizing:border-box;height:38px;font-size:14px}
.row{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px;align-items:center}
.seg{display:inline-flex;padding:3px;border-radius:18px;background:color-mix(in srgb,var(--fg) 8%,transparent)}.seg button{all:unset;cursor:pointer;padding:6px 12px;border-radius:15px;font-size:13px;font-weight:500;color:var(--muted);white-space:nowrap}.seg button.on{background:var(--accent);color:#fff}.seg button:focus-visible{outline:2px solid var(--accent)}
.days{display:flex;gap:4px}.days button{all:unset;cursor:pointer;flex:1;text-align:center;height:30px;line-height:30px;border-radius:15px;font-size:12.5px;background:color-mix(in srgb,var(--fg) 7%,transparent);color:var(--muted)}.days button.on{background:var(--accent);color:#fff}.days button:focus-visible{outline:2px solid var(--accent)}
.quick{all:unset;cursor:pointer;color:var(--accent);font-size:12px}
.devg{display:grid;gap:4px}.devg+.devg{margin-top:8px}.devg small{font-size:11.5px;color:var(--muted)}
.devs{display:flex;flex-wrap:wrap;gap:5px}.devs button{all:unset;cursor:pointer;padding:5px 10px;font-size:12.5px;border-radius:14px;background:color-mix(in srgb,var(--fg) 7%,transparent)}.devs button.on{background:var(--accent);color:#fff}.devs button:focus-visible{outline:2px solid var(--accent)}.devs em{font-style:normal;font-size:10.5px;opacity:.8;margin-left:4px}
.warnx{color:var(--warn)}.err{color:var(--bad);font-size:13px}.err:empty{display:none}
`;
const AUTO_CSS = `.chead{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}.chead h2{margin:0}.chead .gold{height:34px;min-height:0;padding:0 14px;font-size:13.5px;border-radius:17px;margin-left:auto}.slist{display:grid;gap:5px;min-width:0}
.sc{display:flex;align-items:center;gap:10px;background:var(--panel);border:1px solid color-mix(in srgb,var(--line) 60%,transparent);border-radius:12px;box-shadow:var(--shadow);padding:2px 12px;min-width:0}
.st{all:unset;flex:1;min-width:0;display:flex;align-items:center;gap:10px;padding:5px 0;cursor:pointer}.st:disabled{cursor:default}.st:focus-visible{outline:2px solid var(--accent)}.st>b{font-weight:650;font-size:15px;width:46px;flex:none}.st span{min-width:0}.st span b{display:block;font-weight:500;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.st small{display:block;color:var(--muted);font-size:11.5px}.sc.off .st>b{color:var(--muted)}
.box .sc{border:0;box-shadow:none;background:none;padding:0;border-radius:0;border-bottom:1px solid var(--line)}.box .sc:last-child{border-bottom:0}
`;
const BASE = `
.live{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;color:var(--ok);white-space:nowrap}.live i{width:8px;height:8px;border-radius:50%;background:var(--ok);flex:none}.live.off{color:var(--bad)}.live.off i{background:var(--bad)}
.w.loading>*{display:none!important}.w.loading::before,.w.loading::after{content:'';display:block;border-radius:var(--radius);background:linear-gradient(90deg,var(--panel) 25%,color-mix(in srgb,var(--fg) 7%,var(--panel)) 37%,var(--panel) 63%);background-size:400% 100%;animation:sk 1.4s ease infinite}.w.loading::before{height:96px}.w.loading::after{height:260px}@keyframes sk{0%{background-position:100% 50%}100%{background-position:0 50%}}@media(prefers-reduced-motion:reduce){.w.loading::before,.w.loading::after{animation:none}}.sk{display:block;border-radius:var(--radius);background:linear-gradient(90deg,var(--panel) 25%,color-mix(in srgb,var(--fg) 7%,var(--panel)) 37%,var(--panel) 63%);background-size:400% 100%;animation:sk 1.4s ease infinite;border:1px solid var(--line)}
.locbar{display:flex;gap:6px;flex-wrap:wrap;padding:0;margin:-4px 0 -8px;font-family:var(--ha-font-family-body,Roboto,sans-serif)}.locbar button{all:unset;cursor:pointer;display:inline-flex;align-items:center;max-width:100%}.locbar button:hover .lp{background:color-mix(in srgb,var(--primary-text-color) 12%,transparent)}.locbar button:focus-visible .lp{outline:2px solid var(--primary-color)}.lp{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px 0 7px;border-radius:14px;font-size:12.5px;font-weight:600;color:var(--primary-text-color);background:color-mix(in srgb,var(--primary-text-color) 7%,transparent);transition:background .15s}.lp ha-icon{--mdc-icon-size:15px;display:flex;color:var(--primary-color)}.lp ha-icon:last-child{color:var(--secondary-text-color)}
:host{display:block;--lit:#ffb300;--page:var(--primary-background-color);--panel:var(--card-background-color);--line:var(--divider-color);--fg:var(--primary-text-color);--muted:var(--secondary-text-color);--slate:var(--disabled-text-color);--accent:color-mix(in srgb,var(--primary-color) 82%,var(--primary-text-color));--radius:14px;--shadow:0 1px 2px rgba(0,0,0,.10),0 6px 20px rgba(0,0,0,.07);--ok:var(--success-color);--warn:var(--warning-color);--bad:var(--error-color);--track:color-mix(in srgb,var(--fg) 10%,transparent)}
.w{color:var(--fg);padding:clamp(2px,1vw,12px);font-family:var(--ha-font-family-body,Roboto,sans-serif);font-variant-numeric:tabular-nums;line-height:1.4;display:grid;gap:18px}
.w{margin-top:-10px}@media(max-width:870px){.w{margin-top:-16px;gap:12px}.locbar{margin:-14px 0 -12px!important}}
h2{margin:0;font-weight:650;letter-spacing:-.02em;font-size:clamp(22px,3vw,30px);line-height:1.15}
h3{margin:0;font-size:15px;font-weight:600}
.muted{color:var(--muted);font-size:13px}
input,select,button{font:inherit;font-size:14px;color:var(--fg);background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:7px 12px;transition:background .15s,border-color .15s,color .15s,box-shadow .15s}
button{cursor:pointer;font-weight:500;background:color-mix(in srgb,var(--fg) 6%,transparent);border-color:transparent}button:hover:not(:disabled){background:color-mix(in srgb,var(--fg) 11%,transparent)}button:disabled{opacity:.55;cursor:default}
button.gold{background:var(--accent);border-color:var(--accent);color:#fff}button.gold:hover:not(:disabled){background:color-mix(in srgb,var(--accent) 86%,#000)}
.box,.now,.kpi,.f,.loc,.autos,.ac{box-shadow:var(--shadow);border-color:color-mix(in srgb,var(--line) 60%,transparent)!important;transition:border-color .15s,box-shadow .15s,transform .15s}
button.kpi:hover,.f:hover,.loc:hover{transform:translateY(-1px);box-shadow:0 2px 4px rgba(0,0,0,.12),0 10px 26px rgba(0,0,0,.10)}
.ctl button.on{background:var(--accent);border-color:var(--accent);color:#fff!important}button.armed,.ctl button.armed{background:var(--bad);border-color:var(--bad);color:#fff}
.kinds{display:flex;flex-wrap:wrap;gap:6px}.kinds button{padding:6px 12px;font-size:13px;border-radius:16px}.kinds button.on{background:var(--accent);color:#fff}
.sw{all:unset;cursor:pointer;display:inline-flex;align-items:center;flex:none;padding:8px 0}.sw i{position:relative;display:block;width:46px;height:28px;border-radius:14px;background:var(--track);transition:background .15s}.sw i::after{content:"";position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.35);transition:left .15s}.sw.on i{background:var(--accent)}.sw.on i::after{left:21px}.sw.wait{cursor:default}.sw.wait i{animation:swp .9s ease-in-out infinite}@keyframes swp{50%{opacity:.45}}.sw:focus-visible i{outline:2px solid var(--accent);outline-offset:2px}
.busy{position:relative;color:transparent!important}.busy::after{content:"";position:absolute;inset:0;margin:auto;width:14px;height:14px;border-radius:50%;border:2px solid var(--muted);border-top-color:transparent;animation:pspin .8s linear infinite}@keyframes pspin{to{transform:rotate(360deg)}}
.toast{position:fixed;left:50%;bottom:calc(72px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:30;display:flex;gap:14px;align-items:center;background:var(--fg);color:var(--page);padding:10px 16px;border-radius:12px;font-size:14px;box-shadow:0 8px 28px rgba(0,0,0,.3);white-space:nowrap}.toast[hidden]{display:none}.toast button{all:unset;cursor:pointer;font-weight:600;text-decoration:underline;padding:4px}
@media(pointer:coarse),(max-width:870px){input,select{min-height:44px;box-sizing:border-box}button{min-height:44px}.tab,.crumb button,.locbar button,.tg,.fold,.seg button{min-height:44px;display:inline-flex!important;align-items:center;box-sizing:border-box}.cnt{min-height:44px;bottom:0!important;display:inline-flex!important;align-items:center}.f{min-height:64px}}
:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;white-space:nowrap}
.pill::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--slate)}
.pill.ok::before{background:var(--ok)}.pill.warn::before{background:var(--warn)}.pill.bad::before{background:var(--bad)}
.demo{font-size:11px;color:var(--accent);border:1px solid var(--accent);border-radius:4px;padding:0 5px;margin-left:6px;white-space:nowrap}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-weight:400;color:var(--muted);font-size:12.5px;padding:0 12px 8px 0;border-bottom:1px solid var(--line);white-space:nowrap}
th button{all:unset;cursor:pointer}
td{padding:9px 12px 9px 0;border-bottom:1px solid var(--line);vertical-align:middle}
td.num,th.num{text-align:right}
.drawer{box-sizing:border-box;position:fixed;top:0;right:0;bottom:0;width:min(400px,100%);z-index:20;background:var(--panel);border-left:1px solid var(--accent);padding:22px;display:grid;gap:14px;align-content:start;overflow:auto;box-shadow:-10px 0 40px rgba(0,0,0,.5);color:var(--fg)}
.drawer[hidden]{display:none}
@media(max-width:870px){.drawer{padding-bottom:84px}}
.dhead{display:flex;justify-content:space-between;gap:12px;align-items:start}.dline{display:flex;gap:14px;flex-wrap:wrap;align-items:center}
.kvl{display:grid;font-size:14px}.kvl div{display:flex;justify-content:space-between;gap:14px;padding:6px 0;border-bottom:1px solid var(--line)}.kvl span:first-child{color:var(--muted)}.kvl span:last-child{text-align:right}
`;
const CHART_CSS = `
.chart{position:relative}.chart svg{display:block;width:100%;height:auto}.chart rect.b{cursor:crosshair}.chart svg:has(rect.b:hover) g.col:not(:hover) rect.v{opacity:.45}.chart circle{opacity:.9}
.tip{position:absolute;z-index:5;background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:var(--radius);padding:7px 10px;font-size:12px;pointer-events:none;white-space:nowrap;box-shadow:0 6px 20px rgba(0,0,0,.45);min-width:150px;display:grid;gap:1px}.tip[hidden]{display:none}
.tip b{font-weight:600}.tip em{font-style:normal;color:var(--accent);font-weight:500}.tip div{display:flex;justify-content:space-between;gap:18px}.tip div span:first-child{color:var(--muted)}
.key{display:flex;gap:6px 14px;flex-wrap:wrap;font-size:12px;color:var(--muted)}.key i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.chart-src{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);white-space:nowrap}.chart-src b{font-size:10.5px;line-height:1;letter-spacing:.04em;padding:3px 7px;border-radius:999px;background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent);font-weight:700}
.box{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px;display:grid;gap:10px;min-width:0;align-content:start}
.chead{display:flex;justify-content:space-between;gap:8px 12px;flex-wrap:wrap;align-items:center}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:6px;overflow:hidden}.seg button{all:unset;cursor:pointer;font-size:12.5px;padding:4px 10px;color:var(--muted)}.seg button.on{background:color-mix(in srgb,var(--accent) 18%,transparent);color:var(--fg)}.seg button:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
`;
// Categorical colours, in fixed order, validated for colour-blind separation on a dark surface. A ninth device goes into Other.
// Administration: one card per section. Filters and search sit in the card's header, the table fills it edge to
// edge, and every edit or confirmation opens in a dialog. Spacing follows one scale: 8, 12, 16, 24.
const ADMIN_CSS = `
.admin{max-width:1180px;margin:0 auto;padding-bottom:24px}#admin{display:grid;gap:16px;min-width:0}
.admin-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.admin-actions button{white-space:nowrap}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.primary:hover:not(:disabled){background:color-mix(in srgb,var(--accent) 84%,#000)}
button.quiet{background:transparent;border-color:var(--line);color:var(--fg)}button.quiet:hover:not(:disabled){background:color-mix(in srgb,var(--fg) 8%,transparent)}
.form-actions button.danger{background:var(--bad);border-color:var(--bad);color:#fff}.form-actions button.danger:hover:not(:disabled){background:color-mix(in srgb,var(--bad) 84%,#000)}
.admin-note{margin:0;color:var(--muted);font-size:12.5px;line-height:1.5}
.flash{position:fixed;left:50%;bottom:84px;transform:translateX(-50%);z-index:5;max-width:min(560px,calc(100vw - 32px));padding:10px 16px;border-radius:10px;background:var(--fg);color:var(--page);font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.25)}.flash.bad{background:var(--bad);color:#fff}.flash:empty{display:none}
`;

const ADMIN_TABLE_CSS = `
.admin-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-end;flex-wrap:wrap;padding:8px 0 4px}
.admin-head h1{margin:0;font-size:clamp(24px,3vw,30px);letter-spacing:-.03em;line-height:1.15}.admin-head p{margin:6px 0 0;color:var(--muted);font-size:13px;max-width:680px;line-height:1.45}
.admin-kicker{display:block;color:var(--accent);font-size:10px;font-weight:750;letter-spacing:.12em;text-transform:uppercase;margin-bottom:6px}
.admin-head .admin-actions{gap:8px}.admin-head .admin-actions button{height:36px;padding:0 14px;font-size:13px}
.admin-control{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px}.admin-control select{height:36px;min-width:180px;max-width:260px}
.toolbar-label{font-size:12.5px;color:var(--muted)}.toolbar-label b{color:var(--fg)}
.admin-banner{display:flex;gap:16px;align-items:center;flex-wrap:wrap;padding:14px 16px;border:1px solid color-mix(in srgb,var(--accent) 40%,var(--line));border-radius:12px;background:color-mix(in srgb,var(--accent) 6%,var(--panel))}.admin-banner>div{flex:1 1 320px;display:grid;gap:4px}
.admin-card{border:1px solid var(--line);border-radius:12px;background:var(--panel);overflow:hidden;min-width:0}
.admin-card-head{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--line)}.admin-card-head .sp{flex:1}
.admin-card-head h2{margin:0;font-size:15px;letter-spacing:-.01em}.admin-card-head h2 small{display:block;margin-top:2px;font-weight:400;font-size:12px;color:var(--muted)}
.admin-card-head button{height:32px;padding:0 12px;font-size:12.5px}
.admin-card-foot{display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:space-between;padding:10px 16px;border-top:1px solid var(--line);color:var(--muted);font-size:12.5px}.admin-card-foot b{color:var(--fg);font-weight:600}
.chips{display:flex;gap:6px;flex-wrap:wrap}.chip{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border:1px solid var(--line);border-radius:999px;font-size:12.5px;color:var(--muted);white-space:nowrap}
.chip:hover{color:var(--fg);border-color:var(--muted)}.chip:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.chip.on{background:color-mix(in srgb,var(--accent) 14%,transparent);border-color:color-mix(in srgb,var(--accent) 55%,var(--line));color:var(--fg);font-weight:600}
.chip span{font-size:11.5px;font-weight:600;padding:1px 6px;border-radius:999px;background:color-mix(in srgb,var(--fg) 10%,transparent);color:var(--fg)}
.seg-tabs.full{display:flex}.seg-tabs.full button{flex:1;text-align:center;height:32px}.price-big{grid-column:1/-1;display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:12px 14px;border-radius:10px;background:color-mix(in srgb,var(--fg) 5%,transparent);font-size:12.5px;color:var(--muted)}.price-big b{font-size:22px;letter-spacing:-.02em;color:var(--fg);white-space:nowrap}.price-big.new{background:color-mix(in srgb,var(--accent) 12%,transparent)}.form-grid input[type=file]{height:auto;padding:8px;border:1px dashed var(--line);border-radius:8px;background:var(--page);font-size:12.5px;color:var(--fg)}
.seg-tabs{display:inline-flex;padding:3px;border-radius:9px;background:color-mix(in srgb,var(--fg) 7%,transparent)}.seg-tabs button{all:unset;box-sizing:border-box;cursor:pointer;height:28px;padding:0 12px;border-radius:7px;font-size:12.5px;color:var(--muted)}.seg-tabs button.on{background:var(--panel);color:var(--fg);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.18)}
.admin-search{display:flex;align-items:center;gap:6px;height:32px;padding:0 10px;border:1px solid var(--line);border-radius:8px;background:var(--page);flex:0 1 260px;min-width:160px}.admin-search:focus-within{border-color:var(--accent)}
.admin-search ha-icon{--mdc-icon-size:16px;color:var(--muted);flex:none}.admin-search input{all:unset;flex:1;min-width:0;font-size:13px;color:var(--fg)}
.admin-bulk{display:flex;gap:12px;align-items:center;padding:8px 16px;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--accent) 8%,transparent);font-size:12.5px}.admin-bulk .sp{flex:1}.admin-bulk button{height:30px;padding:0 12px;font-size:12.5px}
.admin-table-wrap{overflow:auto;border:1px solid var(--line);border-radius:12px;background:var(--panel)}.admin-card .admin-table-wrap{border:0;border-radius:0;background:transparent}
.admin-table{width:100%;border-collapse:collapse;font-size:13px}
.admin-table th{text-align:left;color:var(--muted);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap;background:color-mix(in srgb,var(--fg) 3%,transparent)}
.admin-table td{padding:12px;border-bottom:1px solid color-mix(in srgb,var(--line) 70%,transparent);vertical-align:middle}
.admin-table th:first-child,.admin-table td:first-child{padding-left:16px}.admin-table th:last-child,.admin-table td:last-child{padding-right:16px}
.admin-table th.act{text-align:right}.admin-table th.pick,.admin-table td.pick{width:20px;padding-right:0}.admin-table td.num,.admin-table th.num{text-align:right;font-variant-numeric:tabular-nums}
.admin-table tr:last-child td{border-bottom:0}.admin-table tbody tr:hover{background:color-mix(in srgb,var(--accent) 5%,transparent)}.admin-table tbody tr.sel{background:color-mix(in srgb,var(--accent) 9%,transparent)}
.admin-table input[type=checkbox]{width:16px;height:16px;margin:0;accent-color:var(--accent)}
.admin-empty{padding:28px 16px !important;text-align:center;color:var(--muted)}
.table-name{all:unset;cursor:pointer;display:grid;gap:2px;font-weight:600;color:var(--fg)}.table-name:hover{color:var(--accent)}.table-name:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.table-sub{display:block;margin-top:2px;font-weight:400;color:var(--muted);font-size:11.5px;line-height:1.35}
.table-actions{display:flex;gap:6px;flex-wrap:nowrap;justify-content:flex-end}
.table-action{all:unset;box-sizing:border-box;cursor:pointer;height:28px;display:inline-flex;align-items:center;padding:0 10px;border:1px solid var(--line);border-radius:7px;color:var(--fg);font-size:12px;white-space:nowrap}
.table-action:hover{background:color-mix(in srgb,var(--fg) 8%,transparent)}.table-action:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.table-action.danger{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 35%,var(--line))}.table-action.danger:hover{background:color-mix(in srgb,var(--bad) 10%,transparent)}
.pill{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:999px;font-size:11.5px;background:color-mix(in srgb,var(--fg) 8%,transparent);color:var(--fg);white-space:nowrap}
.pill.accent{background:color-mix(in srgb,var(--accent) 16%,transparent)}.pill.warn{background:color-mix(in srgb,var(--warn) 18%,transparent)}.pill.muted{color:var(--muted)}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--muted)}.dot.ok{background:var(--ok)}
dialog.admin-modal{width:min(560px,calc(100vw - 32px));max-height:calc(100vh - 48px);padding:0;border:1px solid var(--line);border-radius:14px;background:var(--panel);color:var(--fg);box-shadow:0 24px 64px rgba(0,0,0,.35);overflow:auto}
dialog.admin-modal::backdrop{background:rgba(0,0,0,.5)}
.admin-editor{display:grid;gap:20px;padding:20px 24px 20px}
.admin-editor header{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:0 -24px;padding:0 24px 16px;border-bottom:1px solid var(--line)}.admin-editor h3{margin:0;font-size:18px;letter-spacing:-.02em;line-height:1.25;overflow-wrap:anywhere}
.admin-editor .x{all:unset;cursor:pointer;width:28px;height:28px;display:grid;place-items:center;border-radius:7px;color:var(--muted);font-size:20px;line-height:1;flex:none}.admin-editor .x:hover{background:color-mix(in srgb,var(--fg) 8%,transparent);color:var(--fg)}
.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 12px;align-items:start}.form-grid .wide,.form-grid p{grid-column:1/-1}
.form-grid .field{display:grid;gap:6px;color:var(--muted);font-size:12px;line-height:16px;min-width:0;align-content:start}.field-top{display:flex;justify-content:space-between;align-items:baseline;gap:8px;min-height:16px}.field-hint{font-variant-numeric:tabular-nums}.form-grid .admin-note{margin:-4px 0 0}.form-grid>.check{min-height:24px}.form-grid input:not([type=checkbox]),.form-grid select{width:100%;box-sizing:border-box;height:38px}
.inline-action{all:unset;cursor:pointer;color:var(--accent);font-size:12px;line-height:16px;font-weight:600}.inline-action:hover{text-decoration:underline}
.checks{display:grid;gap:10px;padding:12px;border:1px solid var(--line);border-radius:8px;max-height:180px;overflow:auto;background:var(--page)}.checks.tall{max-height:min(280px,40vh)}.check{display:flex;gap:8px;align-items:center;font-size:13px;line-height:18px;color:var(--fg);min-width:0;cursor:pointer}.check>span{min-width:0;overflow-wrap:anywhere}.check-sub{margin-left:auto;padding-left:8px;color:var(--muted);font-size:11.5px;white-space:nowrap;flex:none}.check input{width:16px;height:16px;margin:0;accent-color:var(--accent)}
.confirm-text{margin:0;font-size:14px;line-height:1.5;color:var(--fg)}
.form-error{margin:0;color:var(--bad);font-size:13px}.form-error:empty{display:none}
.form-actions{display:flex;justify-content:flex-end;gap:8px;margin:0 -24px;padding:16px 24px 0;border-top:1px solid var(--line)}.form-actions button{height:38px;padding:0 16px;font-size:13px}
@media(max-width:700px){.admin-head{align-items:flex-start}.admin-head .admin-actions{width:100%}.admin-control{flex:1}.admin-control select{flex:1;min-width:0;max-width:none}.admin-card-head{padding:12px}.admin-search{flex:1 1 100%}.admin-table th,.admin-table td{padding:10px 8px}.admin-table th:first-child,.admin-table td:first-child{padding-left:12px}.admin-table th:last-child,.admin-table td:last-child{padding-right:12px}.admin-table .hide-s{display:none}.table-actions{flex-wrap:wrap}.form-grid{grid-template-columns:minmax(0,1fr)}.admin-editor{padding:16px}.admin-editor header{margin:0 -16px;padding:0 16px 12px}.form-actions{margin:0 -16px;padding:12px 16px 0}.form-actions button{flex:1}.flash{bottom:96px}}
`;

const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const tipData = (when, note, rows) => encodeURIComponent(JSON.stringify({ when, note, rows }));
// Stacked bars for today by hour, or the last days. parts are { name, b } with b from bucketEnergy. Total is one bar; By device splits it.
function energyChart(parts, range, detail, W, tariff, vat = '') {
  const pr = typeof tariff === 'number' ? { hour: () => tariff, day: () => tariff } : tariff, costLabel = vat ? `Cost, ${vat}` : 'Cost';
  if (!parts?.length) return '<p class="muted">Loading…</p>';
  const all = mergeEnergy(parts.map((p) => p.b)), hours = range === 'hours', H = Math.min(280, Math.max(130, Math.round(W * 0.28))), top = 16, bottom = 20;
  const columns = hours ? all.today.map((_, i) => i) : all.dayList.map((x) => x.day), at = (b, k) => (hours ? b.today[k] || 0 : b.days.get(k) || 0);
  const week = (p) => [...p.b.days.values()].reduce((t, v) => t + v, 0), ranked = [...parts].sort((a, b) => week(b) - week(a)), rest = ranked.slice(8);
  const series = detail ? [...ranked.slice(0, 8).map((p, i) => ({ name: p.name, color: SERIES[i], parts: [p] })), ...(rest.length ? [{ name: `Other (${rest.length})`, color: 'var(--slate)', parts: rest }] : [])] : [{ name: 'Total', color: 'var(--accent)', parts }];
  const valuesAt = (k) => series.map((x) => ({ name: x.name, color: x.color, v: x.parts.reduce((t, p) => t + at(p.b, k), 0) }));
  const totals = columns.map((k) => valuesAt(k).reduce((t, x) => t + x.v, 0)), ghost = !detail && hours ? all.yesterday : [];
  const max = Math.max(0.01, ...totals, ...ghost.map((v) => v || 0)), step = W / Math.max(1, columns.length), pair = ghost.length > 0, bw = pair ? Math.min(step * 0.8, 26) : Math.min(step * (hours ? 0.55 : 0.4), hours ? 18 : 30), y = (v) => top + (H - top - bottom) * (1 - v / max);
  const dayName = (d, o) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', ...o });
  const colHtml = columns.map((k, i) => {
    const vals = valuesAt(k), total = totals[i], x = i * step + (step - bw) / 2, live = hours && k === all.current;
    let tip;
    if (detail) tip = { when: hours ? `${String(k).padStart(2, '0')}:00 to ${String((k + 1) % 24).padStart(2, '0')}:00` : dayName(k, { weekday: 'long', day: 'numeric', month: 'short' }), note: live ? 'This hour so far' : null, rows: [...vals.filter((v) => v.v > 0).sort((a, b) => b.v - a.v).map((v) => [v.name, `${v.v.toFixed(2)} kWh`]), ['Total', `${total.toFixed(2)} kWh`]] };
    else if (hours) tip = hourTip(k, all.today[k], all.yesterday[k], all.current, pr.hour(k), costLabel);
    else tip = { when: dayName(k, { weekday: 'long', day: 'numeric', month: 'short' }), note: all.dayList[i].isToday ? 'So far today' : null, rows: [['Energy', `${total.toFixed(2)} kWh`], [costLabel, `€ ${(total * pr.day(k)).toFixed(2)}`]] };
    let base = y(0);
    const half = pair ? bw / 2 : bw, xt = pair ? x + bw / 2 : x;
    const segs = vals.filter((v) => v.v > 0).map((v) => { const h = Math.max(1, y(0) - y(v.v)); base -= h; return `<rect class="v" pointer-events="none" x="${xt}" y="${base}" width="${pair ? half - 1 : bw}" height="${Math.max(1, h - (detail && h > 3 ? 1 : 0))}" rx="${detail ? 1 : 2}" fill="${v.color}"${live ? ' fill-opacity=".55"' : ''}/>`; }).join('');
    const dot = ghost[k] == null ? '' : `<rect class="v" pointer-events="none" x="${x}" y="${y(ghost[k])}" width="${half - 1}" height="${Math.max(1, y(0) - y(ghost[k]))}" rx="2" fill="var(--slate)" fill-opacity=".7"/>`;
    const label = hours ? (k % (W < 480 ? 6 : 3) === 0 ? String(k).padStart(2, '0') : '') : dayName(k, { weekday: 'short', day: 'numeric' });
    const sum = !hours && total > 0 ? `<text x="${i * step + step / 2}" y="${base - 4}" text-anchor="middle" fill="var(--fg)" font-size="10">${total.toFixed(total >= 100 ? 0 : 1)}</text>` : '';
    return `<g class="col"><rect class="b" data-tip="${tipData(tip.when, tip.note, tip.rows)}" x="${i * step}" y="${top}" width="${step}" height="${H - top - bottom}" fill="transparent"/>${segs}${dot}${sum}${label ? `<text x="${i * step + step / 2}" y="${H - 6}" text-anchor="middle" fill="var(--muted)" font-size="10">${label}</text>` : ''}</g>`;
  }).join('');
  const key = detail ? series.map((x) => `<span><i style="background:${x.color}"></i>${esc(x.name)}</span>`).join('') : ghost.length ? `<span><i style="background:${series[0].color}"></i>Today</span><span><i style="background:var(--slate);opacity:.7"></i>Yesterday</span>` : '';
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Energy, ${detail ? 'by device' : 'total'}"><line x1="0" x2="${W}" y1="${top}" y2="${top}" stroke="var(--line)" stroke-dasharray="2 3"/><line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" stroke="var(--line)"/><text x="0" y="10" fill="var(--muted)" font-size="10">${max.toFixed(max >= 10 ? 0 : 1)} kWh</text>${colHtml}</svg><div class="tip" hidden></div></div>${key ? `<div class="key">${key}</div>` : ''}`;
}
// Topology. Both views are the same shape of tree: wiring shows where the power goes, network shows how Home Assistant reaches each device.
const isDown = (s) => s.key === 'bad' || s.kind === 'silent';
const countUnder = (n) => n.kids.reduce((t, k) => t + 1 + countUnder(k), 0);
const downUnder = (n) => n.kids.reduce((t, k) => t + (k.down ? 1 : 0) + downUnder(k), 0);
function topoNode(d, states, nowMs, kids, sub) {
  const s = deviceStatus(d, states, nowMs);
  return { id: d.id, device: true, real: !d.virtual, kind: TREE.main === d.id ? 'main' : d.virtual ? 'virtual' : 'device', name: d.name, sub: sub || s.label, key: s.key, down: isDown(s), w: liveReadings(readingsOf(d.id), states, nowMs).power, kids };
}
function wiringTree(states, nowMs) {
  const walk = (d) => topoNode(d, states, nowMs, childrenOf(d.id).map(walk));
  const main = mainDevice(), tops = topNodes(), order = main ? [main, ...tops.filter((d) => d.id !== main.id)] : tops;
  return { id: 'root', kind: 'location', name: placeById(currentLocation)?.name || 'All devices', sub: 'Location', key: '', down: false, w: liveReadings(homeDevices(), states, nowMs).power, kids: order.map(walk) };
}
// Four maps from two choices. What is shown: the connection of each device, or the power it draws.
// How it is arranged: by the location's groups, or by the devices' own hierarchy (parent devices).
// A hub is a group, or a device with devices under it; it says how many it holds and how they are doing.
function topoHub(id, name, kids, w = null) {
  const n = { id, kind: 'hub', name, key: '', down: false, w, kids }, all = countUnder(n) - kids.filter((k) => k.kind === 'hub').length, down = downUnder(n);
  n.sub = `${all} ${all === 1 ? 'device' : 'devices'}`; n.key = !all ? '' : down === all ? 'bad' : down ? 'warn' : 'ok'; n.down = !!all && down === all;
  return n;
}
// A device as the connection map shows it: its address and signal. Home Assistant does not know which
// router or access point a device uses, so nothing more can be said about its path.
function connectionLeaf(d, states, nowMs) {
  const num = (id) => parseFloat(states[id]?.state);
  return { ...topoNode(d, states, nowMs, [], [d.address, Number.isFinite(num(d.rssi)) ? `${Math.round(num(d.rssi))} dBm` : '', !d.shelly && Number.isFinite(num(d.linkQuality)) ? `Link quality ${Math.round(num(d.linkQuality))}` : ''].filter(Boolean).join(' · ') || undefined), icon: d.shelly ? (d.switch ? 'circuit' : 'meter') : 'zigbee' };
}
// By group: the location's groups, nested as they are set up, with their devices. With power, a group
// shows what its devices draw together, counting a device and what is under it once.
function groupTree(states, nowMs, power = false) {
  const real = DEVICES.filter((d) => isMeasuring(d) && !d.virtual).sort(byName);
  const leaf = (d) => (power ? topoNode(d, states, nowMs, []) : connectionLeaf(d, states, nowMs));
  const drawn = (list) => (power && list.length ? liveReadings(countedIn(list), states, nowMs).power : null);
  const group = (p) => topoHub(p.id, p.name, [...placeChildren(p.id).map(group), ...real.filter((d) => d.place === p.id).map(leaf)], drawn(placedDevices(p.id)));
  const looseDevices = real.filter((d) => !d.place || d.place === currentLocation), loose = looseDevices.map(leaf);
  const kids = [...placeChildren(currentLocation).map(group), ...(loose.length ? [topoHub('place:loose', 'Not in a group', loose, drawn(looseDevices))] : [])];
  return { id: 'root', kind: 'location', name: placeById(currentLocation)?.name || 'All devices', sub: power ? 'Location' : 'Home Assistant', key: power ? '' : 'ok', down: false, w: power ? liveReadings(homeDevices(), states, nowMs).power : null, kids };
}
const networkTree = (states, nowMs) => groupTree(states, nowMs, false);
// By device, for the connection map: no groups at all. The location, then the devices at the top of the
// hierarchy (the main device first), each carrying the devices that have it as their parent. A virtual
// device is a node like any other; it has no connection of its own, so it says how the devices under it are.
// It is drawn as rings around the location (see ringLayout), in the same style as the connection map by group.
function deviceConnectionTree(states, nowMs) {
  const walk = (d) => {
    const kids = childrenOf(d.id).map(walk);
    if (d.virtual) { const n = topoHub(d.id, d.name, kids); return { ...n, kind: TREE.main === d.id ? 'main' : 'virtual', virtual: true, icon: 'virtual', device: true, real: false, sub: `Virtual · ${n.sub}` }; }
    return { ...connectionLeaf(d, states, nowMs), kids };
  };
  const main = mainDevice(), tops = topNodes(), order = main ? [main, ...tops.filter((d) => d.id !== main.id)] : tops;
  return { id: 'root', kind: 'location', name: placeById(currentLocation)?.name || 'All devices', sub: 'Home Assistant', key: 'ok', down: false, w: null, kids: order.map(walk) };
}
// Radial: each group gets a slice of the circle as wide as what it holds, and its devices fan out away from the centre.
// A slice is never narrower than the circle around everything in it, so groups cannot run into each other.
function radialLayout(root, shut, o = { leaf: 32, min: 70, label: 112, spread: 3.8 }) {
  const info = new Map(), isHub = (n) => n.kind === 'hub';
  const size = (n) => {
    const kids = shut.has(n.id) ? [] : n.kids;
    kids.forEach(size);
    const holds = (k) => isHub(k) || info.get(k.id).kids.length > 0;
    const widths = kids.map((k) => (holds(k) ? info.get(k.id).rho * 1.7 : o.leaf)), total = widths.reduce((t, v) => t + v, 0), isRoot = n === root;
    const dist = kids.length ? Math.max(isRoot ? o.min * 1.6 : o.min, total / (isRoot ? 2 * Math.PI : o.spread)) : 0;
    info.set(n.id, { kids, widths, total, dist, rho: kids.length ? dist + Math.max(...kids.map((k) => (holds(k) ? info.get(k.id).rho : o.label))) : 62 });
  };
  size(root);
  const nodes = [], links = [];
  const place = (n, x, y, dir, depth, parent) => {
    const me = { node: n, x, y, dir, depth };
    nodes.push(me);
    if (parent) links.push({ from: parent, to: me });
    const { kids, widths, total, dist } = info.get(n.id), arc = n === root ? 2 * Math.PI : Math.min(o.spread, Math.max(total / (dist || 1), 1.7));
    let a = dir - arc / 2;
    kids.forEach((k, i) => { const share = (arc * widths[i]) / total, at = a + share / 2; place(k, x + dist * Math.cos(at), y + dist * Math.sin(at), at, depth + 1, me); a += share; });
  };
  place(root, 0, 0, -Math.PI / 2, 0, null);
  const reach = (m) => (isHub(m.node) || m.node === root ? 70 : o.label), minX = Math.min(...nodes.map((m) => m.x - reach(m))), minY = Math.min(...nodes.map((m) => m.y - reach(m)));
  nodes.forEach((m) => { m.x -= minX; m.y -= minY; });
  return { nodes, links, width: Math.max(...nodes.map((m) => m.x + reach(m))), height: Math.max(...nodes.map((m) => m.y + reach(m))) };
}
// Rings: for a device hierarchy. Each level sits on its own ring around the location, and a device's
// share of the circle is as wide as the devices at the end of its branches. Unlike the layout above, a
// deep hierarchy does not push everything outwards: the picture only grows by one ring per level.
function ringLayout(root, shut, o = { ring: 124, first: 150, label: 112, leaf: 26 }) {
  const open = (n) => (shut.has(n.id) ? [] : n.kids), leaves = new Map();
  const count = (n) => { const kids = open(n), v = kids.length ? kids.reduce((t, k) => t + count(k), 0) : 1; leaves.set(n.id, v); return v; };
  const total = count(root), depthOf = (n) => 1 + Math.max(0, ...open(n).map(depthOf)), levels = depthOf(root) - 1;
  // Wide enough that the devices on the outermost ring do not touch.
  const ring = Math.max(o.ring, levels ? (total * o.leaf) / (2 * Math.PI * levels) : 0), radius = (depth) => (depth ? o.first + (depth - 1) * ring : 0);
  const nodes = [], links = [];
  const place = (n, from, to, depth, parent) => {
    const at = (from + to) / 2, r = radius(depth), me = { node: n, x: r * Math.cos(at), y: r * Math.sin(at), dir: at, depth };
    nodes.push(me);
    if (parent) links.push({ from: parent, to: me });
    let a = from;
    for (const k of open(n)) { const share = ((to - from) * leaves.get(k.id)) / leaves.get(n.id); place(k, a, a + share, depth + 1, me); a += share; }
  };
  place(root, -Math.PI / 2, (3 * Math.PI) / 2, 0, null);
  const reach = (m) => (m.node === root ? 70 : o.label), minX = Math.min(...nodes.map((m) => m.x - reach(m))), minY = Math.min(...nodes.map((m) => m.y - reach(m)));
  nodes.forEach((m) => { m.x -= minX; m.y -= minY; });
  return { nodes, links, width: Math.max(...nodes.map((m) => m.x + reach(m))), height: Math.max(...nodes.map((m) => m.y + reach(m))) };
}
// Icons from Material Design Icons, which Home Assistant itself uses.
const TOPO_ICONS = {
  location: 'm12.151 1.5882c-.3262 0-.6523.1291-.8996.3867l-8.3848 8.7354c-.0619.0644-.1223.1368-.1807.2154-.0588.0789-.1151.1638-.1688.2534-.2593.4325-.4552.9749-.5232 1.4555-.0026.018-.0076.0369-.0094.0548-.0121.0987-.0184.1944-.0184.2857v8.0124a1.2731 1.2731 0 001.2731 1.2731h7.8313l-3.4484-3.593a1.7399 1.7399 0 111.0803-1.125l2.6847 2.7972v-10.248a1.7399 1.7399 0 111.5276-0v7.187l2.6702-2.782a1.7399 1.7399 0 111.0566 1.1505l-3.7269 3.8831v2.7299h8.174a1.2471 1.2471 0 001.2471-1.2471v-8.0375c0-.0912-.0059-.1868-.0184-.2855-.0603-.4935-.2636-1.0617-.5326-1.5105-.0537-.0896-.1101-.1745-.1684-.253-.0588-.079-.1191-.1513-.181-.2158l-8.3848-8.7363c-.2473-.2577-.5735-.3866-.8995-.3864',
  hub: 'M20,18H4V8H20M20,6H12L10,4H4C2.89,4 2,4.89 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V8C22,6.89 21.1,6 20,6Z',
  circuit: 'M12,2A7,7 0 0,1 19,9C19,11.38 17.81,13.47 16,14.74V17A1,1 0 0,1 15,18H9A1,1 0 0,1 8,17V14.74C6.19,13.47 5,11.38 5,9A7,7 0 0,1 12,2M9,21V20H15V21A1,1 0 0,1 14,22H10A1,1 0 0,1 9,21M12,4A5,5 0 0,0 7,9C7,11.05 8.23,12.81 10,13.58V16H14V13.58C15.77,12.81 17,11.05 17,9A5,5 0 0,0 12,4Z',
  meter: 'M7,2V13H10V22L17,10H13L17,2H7Z',
  virtual: 'M18,6H8.83L14.83,12L8.83,18H18V20H6V18L12,12L6,6V4H18V6Z',
  zigbee: 'M4.06,6.15C3.97,6.17 3.88,6.22 3.8,6.28C2.66,7.9 2,9.87 2,12A10,10 0 0,0 12,22C15,22 17.68,20.68 19.5,18.6L17,18.85C14.25,19.15 11.45,19.19 8.66,18.96C7.95,18.94 7.24,18.76 6.59,18.45C5.73,18.06 5.15,17.23 5.07,16.29C5.06,16.13 5.12,16 5.23,15.87L7.42,13.6L15.03,5.7V5.6H10.84C8.57,5.64 6.31,5.82 4.06,6.15M20.17,17.5C20.26,17.47 20.35,17.44 20.43,17.39C21.42,15.83 22,14 22,12A10,10 0 0,0 12,2C9.22,2 6.7,3.13 4.89,4.97H5.17C8.28,4.57 11.43,4.47 14.56,4.65C15.5,4.64 16.45,4.82 17.33,5.17C18.25,5.53 18.89,6.38 19,7.37C19,7.53 18.93,7.7 18.82,7.82L9.71,17.19L9,17.95V18.06H13.14C15.5,18 17.84,17.81 20.17,17.5Z',
};
// Left to right. A leaf takes the next free row and a parent sits midway along its children, so nothing overlaps.
function layoutTree(root, shut, size = { w: 214, h: 50, gx: 64, gy: 10 }) {
  const nodes = [], links = [];
  let row = 0;
  const walk = (n, depth) => {
    const placed = (shut.has(n.id) ? [] : n.kids).map((k) => walk(k, depth + 1));
    const me = { node: n, depth, x: depth * (size.w + size.gx), y: placed.length ? (placed[0].y + placed[placed.length - 1].y) / 2 : row++ * (size.h + size.gy) };
    nodes.push(me);
    placed.forEach((c) => links.push({ from: me, to: c }));
    return me;
  };
  walk(root, 0);
  return { nodes, links, width: Math.max(...nodes.map((m) => m.x)) + size.w, height: Math.max(...nodes.map((m) => m.y)) + size.h, size };
}
// Long trees open three levels deep. Only rows with something under them can fold.
const shutBelow = (rows) => new Set(rows.filter((x, i) => x.depth >= 2 && rows[i + 1]?.depth > x.depth).map((x) => x.id));
function shutNodes(n, depth = 0, out = new Set()) {
  if (depth >= 3 && n.kids.length) out.add(n.id);
  n.kids.forEach((k) => shutNodes(k, depth + 1, out));
  return out;
}
function allParents(n, out = new Set()) {
  if (n.kids.length) out.add(n.id);
  n.kids.forEach((k) => allParents(k, out));
  return out;
}
// The switch only appears with more than one device to split it into.
function chartBox(title, key, parts, range, mode, W, tariff, vat = '') {
  const device = mode === 'device' && parts?.length > 1;
  const seg = parts?.length > 1 ? `<div class="seg" role="group" aria-label="${title}"><button data-chart="${key}" data-mode="total" class="${device ? '' : 'on'}" aria-pressed="${!device}">Total</button><button data-chart="${key}" data-mode="device" class="${device ? 'on' : ''}" aria-pressed="${device}">By device</button></div>` : '';
  return `<div class="box"><div class="chead"><h3>${title}</h3>${seg}</div>${energyChart(parts, range, device, W, tariff, vat)}</div>`;
}
function chartTips(m, setHover) {
  const hide = () => { setHover(false); m.querySelectorAll('.chart .tip').forEach((x) => { x.hidden = true; }); };
  const show = (e) => {
    const bar = e.target.closest && e.target.closest('rect.b'), box = e.target.closest && e.target.closest('.chart');
    if (!bar || !box) { hide(); return; }
    const t = box.querySelector('.tip');
    if (!t) return;
    setHover(true);
    const d = JSON.parse(decodeURIComponent(bar.dataset.tip));
    t.innerHTML = `<b>${d.when}</b>${d.note ? `<em>${d.note}</em>` : ''}${d.rows.map(([k, v]) => `<div><span>${esc(k)}</span><span>${v}</span></div>`).join('')}`;
    t.hidden = false;
    const segs = bar.parentNode.querySelectorAll('rect.v'), b = box.getBoundingClientRect(), a = (segs[segs.length - 1] || bar).getBoundingClientRect(), w = t.offsetWidth, above = a.top - b.top - t.offsetHeight - 8, right = a.right - b.left + 8;
    // Sit just above the visible bar; a tall bar has no room above, so go beside it.
    t.style.left = `${above >= 0 ? Math.max(0, Math.min(b.width - w, a.left - b.left + a.width / 2 - w / 2)) : right + w <= b.width ? right : Math.max(0, a.left - b.left - w - 8)}px`;
    t.style.top = `${Math.max(0, above)}px`;
  };
  m.addEventListener('pointermove', show);
  m.addEventListener('pointerdown', show);
  m.addEventListener('pointerleave', hide);
}
const fmtPower = (s) => { const v = parseFloat(s?.state); return Number.isFinite(v) ? powerText(v) : '—'; };

async function todayKwh(hass, ids) {
  const tz = hass.config.time_zone;
  const now = new Date();
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
  const [y, m, d] = day.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const off = new Date(guess).toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' });
  const start = new Date(guess - Number(off) * 3600000);
  const s = await statsWS(hass, { type: 'recorder/statistics_during_period', start_time: start.toISOString(), statistic_ids: ids, period: 'hour', types: ['change', 'state'] });
  // Statistics stop at the last finished hour, so add what the meter's counter has moved since.
  return Object.fromEntries(ids.map((id) => { const rows = s[id] || [], last = rows[rows.length - 1], since = last ? parseFloat(hass.states[id]?.state) - last.state : 0; return [id, rows.reduce((a, r) => a + (r.change > 0 && r.change < 20 ? r.change : 0), 0) + (since > 0 && since < 20 ? since : 0)]; }));
}
function hourTip(hour, today, yesterday, current, tariff, costLabel = 'Cost') {
  const pad = (x) => String(x).padStart(2, '0');
  const rows = [];
  if (today != null) rows.push(['Today', `${today.toFixed(2)} kWh`], [costLabel, `€ ${(today * tariff).toFixed(2)}`]);
  if (yesterday != null) rows.push(['Yesterday', `${yesterday.toFixed(2)} kWh`]);
  if (today != null && yesterday > 0 && hour !== current) {
    const d = Math.round(((today - yesterday) / yesterday) * 100);
    rows.push(['vs yesterday', `${d > 0 ? '+' : ''}${d}%`]);
  }
  return { when: `${pad(hour)}:00 to ${pad((hour + 1) % 24)}:00`, note: hour === current ? 'This hour so far' : today == null ? 'Later today' : null, rows };
}
// The drawer is redrawn every few seconds. While something typed in it is unsaved, it is left alone.
function paintDrawer(card, dr, html) { if (!dr._watched) { dr._watched = true; watchDrawer(card, dr); } if (dr.dataset.dirty) return; dr.innerHTML = html; }
function watchDrawer(card, dr) {
  dr.addEventListener('input', () => { dr.dataset.dirty = '1'; });
  dr.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) { delete dr.dataset.dirty; return; }
    const b = e.target.closest('[data-save-device]');
    if (!b) return;
    const name = dr.querySelector('#dname').value.trim(), place = dr.querySelector('#dplace').value, msg = dr.querySelector('#dmsg');
    try {
      if (name && name !== b.dataset.wasName) await card._hass.callWS({ ...clientArg(), type: 'optim_energy/device/update', device_id: b.dataset.saveDevice, name });
      if (place && place !== b.dataset.wasPlace) await card._hass.callWS({ ...clientArg(), type: 'optim_energy/device/assign', device_id: b.dataset.saveDevice, place });
      delete dr.dataset.dirty;
      treeLoad = null;
      await ensureTree(card._hass);
      card.paint();
    } catch (x) { msg.textContent = x?.message || 'Could not save the change.'; }
  });
}
function drawerHtml(d, st, now, totals) {
  const s = deviceStatus(d, st, now);
  const fresh = [d.power, d.energy, ...(d.alive || [])].map((id) => st[id]).filter(Boolean).map((x) => +new Date(x.last_updated));
  const last = fresh.length ? Math.round((now - Math.max(...fresh)) / 60000) : null;
  const up = nodeById(parentOf(d.id)), under = childrenOf(d.id), inTree = nodeIds.has(d.id);
  const u = inTree && totals ? unmeasuredOf([d.id], (id) => totals.devices[id]?.today ?? null, totals.stale) : null;
  const wiring = inTree ? `<div><span>Parent device</span><span>${up ? esc(up.name) : TREE.main === d.id ? 'The grid (main device)' : 'Top of the building'}</span></div>${under.length ? `<div><span>Supplies</span><span>${under.length} ${under.length === 1 ? 'device' : 'devices'}</span></div>` : ''}${u?.nodes[0]?.kwh != null ? `<div><span>Today</span><span>${u.nodes[0].kwh.toFixed(2)} kWh</span></div>` : ''}${u?.applies ? `<div><span>Unmeasured today</span><span>${u.gap ? 'Partial: a device has no reading' : `${u.kwh.toFixed(2)} kWh`}</span></div>` : ''}` : '';
  // What a client looks at first: power and energy. Everything else is for whoever looks after the installation.
  const KEY = /^(Power|Total energy|Channel \d+ power|Channel \d+ total energy)$/;
  const row = ([k, id, u]) => { const v = st[id]?.state; const ok = v != null && v !== 'unknown' && v !== 'unavailable'; return `<div><span>${k}</span><span>${ok ? valueText(v, u) : '—'}</span></div>`; };
  const rows = (d.readings || []).filter(([k]) => KEY.test(k)).map(row).join(''), tech = (d.readings || []).filter(([k]) => !KEY.test(k)).map(row).join('');
  return `<div class="dhead"><div><h2 style="font-size:24px">${esc(d.name)}</h2><span class="muted">${d.place ? esc(placeLabel(d.place)) : 'Not placed'}</span></div><button data-close aria-label="Close">Close</button></div>
  <div class="dline"><span class="pill ${s.key}">${s.label}</span>${last == null ? '' : `<span class="muted">${last < 1 ? 'just now' : `${last} min ago`}</span>`}</div>
  <div class="kvl"><div><span>Type</span><span>${typeLabel(d)}</span></div><div><span>Model</span><span>${esc(d.model || '')}</span></div>${wiring}</div>
  ${rows ? `<h3>Latest readings</h3><div class="kvl">${rows}</div>` : ''}
  ${tech ? `<details class="tech"><summary>Technical details</summary><div class="kvl">${tech}</div></details>` : ''}
  ${d.report ? `<button class="gold" data-report="${d.report}">Open report</button>` : ''}${deviceManageHtml(d)}`;
}
function navigate(path) {
  history.pushState(null, '', path);
  window.dispatchEvent(new CustomEvent('location-changed', { bubbles: true, composed: true }));
}
// From the menu, Reports starts on the whole location, not whichever circuit was opened last.
function openLocationReport() {
  try { const v = JSON.parse(localStorage.getItem('energyReportCard') || '{}'); delete v.view; v.p = { key: 'today', n: 12, unit: 'hours', from: '', to: '' }; localStorage.setItem('energyReportCard', JSON.stringify(v)); } catch (e) { /* private window */ }
}
function goToReport(view) {
  try { const v = JSON.parse(localStorage.getItem('energyReportCard') || '{}'); v.view = view; localStorage.setItem('energyReportCard', JSON.stringify(v)); } catch (e) { /* private window */ }
  navigate('/energy-reports/report');
}

if (typeof HTMLElement !== 'undefined') {
  class Base extends HTMLElement {
    setConfig(c) { this._c = c || {}; }
    getCardSize() { return 12; }
    getGridOptions() { return { columns: 'full' }; }
    set hass(h) {
      this.style.colorScheme = h.themes?.darkMode ? 'dark' : 'light';
      const before = this._hass?.states, changed = syncModel(h);
      this._hass = h;
      ensureTree(h);
      if (!this._built) { this._built = true; this.attachShadow({ mode: 'open' }); this.build(); this.locationBar(); this.loadingState(); this.refresh(); this._lastPaint = Date.now(); this.watchTree(); return; }
      this.loadingState();
      if (changed || Date.now() - this._lastPaint > (this.paintEvery || 10000) || controlChanged(before, h.states)) { this._lastPaint = Date.now(); this.paint(); }
    }
    watchTree() { if (!this._onTree) { this._onTree = () => { this.locationBar(); this.loadingState(); this.refresh(); this.paint(); }; window.addEventListener('portal-tree', this._onTree); } }
    disconnectedCallback() { clearInterval(this._t); this._t = null; window.removeEventListener('portal-tree', this._onTree); this._onTree = null; }
    connectedCallback() { if (this._built && !this._t) this.startTimer(); if (this._built) this.watchTree(); }
    // Until the tenant's locations and devices have arrived, a page shows that it is loading
    // rather than an empty location.
    loadingState() {
      const w = this.shadowRoot?.querySelector('.w');
      if (w && !this.noBar) w.classList.toggle('loading', !PORTAL.treeReady && !PORTAL.error);
    }
    // Every page says which location it is showing. A Home Assistant administrator looking at a
    // tenant's pages also sees whose they are, and the way back.
    locationBar() {
      const at = this.shadowRoot.querySelector('.w, #h'), name = placeById(currentLocation)?.name;
      let bar = this.shadowRoot.querySelector('.locbar');
      if (!at || this.noBar || !name) { bar?.remove(); return; }
      if (!bar) {
        bar = document.createElement('div');
        bar.className = 'locbar';
        bar.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) navigate(b.dataset.admin ? ADMIN_HOME_PATH : START_PATH); });
        if (at.id === 'h') at.before(bar); else at.prepend(bar);
      }
      const tenant = PORTAL.isRoot ? PORTAL.clientName : '';
      bar.innerHTML = `${PORTAL.isRoot ? '<button data-admin="1" aria-label="Back to Administration"><span class="lp"><ha-icon icon="mdi:arrow-left"></ha-icon>Administration</span></button>' : ''}<button aria-label="Location ${esc(name)}. Change location"><span class="lp"><ha-icon icon="mdi:map-marker-outline"></ha-icon>${tenant ? `${esc(tenant)} · ` : ''}${esc(name)}<ha-icon icon="mdi:chevron-down"></ha-icon></span></button>`;
    }
    startTimer() { this._t = setInterval(() => this.refresh(), 300000); }
    async refresh() {}
    paint() {}
  }

  class DevicesCard extends Base {
    build() {
      this.shadowRoot.innerHTML = `<style>${BASE}.link{cursor:pointer}.link:hover td{background:color-mix(in srgb,var(--accent) 8%,transparent)}td.num{white-space:nowrap}.row{flex-wrap:nowrap}#q{flex:1;min-width:0;width:0}#floor{max-width:46%}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--slate);margin-right:8px}.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}@media(max-width:700px){th:nth-child(3),td:nth-child(3),th:nth-child(5),td:nth-child(5){display:none}}</style><div class="w"><div class="row">
        <input id="q" type="search" placeholder="Search devices" aria-label="Search devices">
        <select id="floor" aria-label="Group"></select></div><div class="scroll"><table><thead><tr><th>Device</th><th>Type</th><th>Group</th><th class="num">Now</th><th class="num">Today</th></tr></thead><tbody id="rows"></tbody></table></div><div class="drawer" id="drawer" hidden></div></div>`;
      const r = this.shadowRoot;
      ['q', 'floor'].forEach((id) => r.getElementById(id).addEventListener('input', () => this.paint()));
      r.getElementById('rows').addEventListener('click', (e) => { const tr = e.target.closest('[data-device]'); if (tr) { this._open = tr.dataset.device; this.paint(); } });
      r.getElementById('drawer').addEventListener('click', (e) => {
        if (e.target.closest('[data-close]')) { this._open = null; this.paint(); return; }
        const g = e.target.closest('[data-report]'); if (g) goToReport(g.dataset.report);
      });
      this.startTimer();
    }
    async refresh() {
      try { this._kwh = await todayKwh(this._hass, DEVICES.filter((d) => d.energy).map((d) => d.energy)); } catch (e) { this._kwh = null; }
      try { this._totals = await portalTotals(this._hass); } catch (e) { this._totals = null; }
      this.paint();
    }
    paint() {
      const r = this.shadowRoot, st = this._hass.states, now = Date.now();
      const pick = r.getElementById('floor'), picked = pick.value, options = `<option value="">All groups</option>${flatPlaces().map((p) => `<option value="${p.id}">${'&nbsp;'.repeat(p.depth * 3)}${esc(p.name)}</option>`).join('')}`;
      if (this._placeOptions !== options) { this._placeOptions = options; pick.innerHTML = options; pick.value = placeById(picked) ? picked : ''; }
      // The main device first, then virtual ones, so the top of the tree reads first.
      const rank = (d) => (TREE.main === d.id ? 0 : d.virtual ? 1 : 2), shown = DEVICES.filter((d) => !d.channelOf).sort((a, b) => rank(a) - rank(b) || byName(a, b)), list = filterDevices(shown, r.getElementById('q').value, pick.value, '');
      r.getElementById('rows').innerHTML = list.map((d) => {
        const parts = d.virtual || d.channels ? readingsOf(d.id) : [d], s = deviceStatus(d, st, now), q = liveReadings(parts, st, now);
        const k = this._kwh && parts.length && parts.every((x) => x.energy) ? parts.reduce((t, x) => t + (this._kwh[x.energy] || 0), 0) : null;
        return `<tr class="link" data-device="${d.id}"><td><span class="dot ${s.key}" title="${esc(s.label)}"></span>${esc(d.name)}</td><td class="muted">${esc(typeLabel(d))}</td><td class="muted">${esc(placeParts(d.place).group || '—')}</td><td class="num">${s.key === 'bad' ? 'Offline' : d.power || d.virtual || d.channels ? (q.power == null ? '—' : fmtPower({ state: String(q.power) })) : '—'}</td><td class="num">${k == null ? '—' : `${k.toFixed(1)} kWh`}</td></tr>`;
      }).join('') || '<tr><td colspan="5" class="muted">No devices match.</td></tr>';
      const dr = r.getElementById('drawer'), open = DEVICES.find((d) => d.id === this._open);
      dr.hidden = !open;
      if (open) paintDrawer(this, dr, drawerHtml(open, st, now, this._totals));
    }
  }

  let groupsMemo = null; // Coming back from a report reopens the same group and tab.
  class SpacesCard extends Base {
    build() {
      const memo = groupsMemo?.at === currentLocation ? groupsMemo : null;
      this._place = memo?.place ?? null; this._detail = !!memo?.detail; this._modes = {};
      if (memo) memo.detail = false;
      this._open = null; this._shut = new Set();
      this.shadowRoot.innerHTML = `<style>${BASE}
.layout{display:grid;grid-template-columns:minmax(240px,290px) minmax(0,1fr);gap:20px;align-items:start}
.back{display:none}
@media(max-width:860px){.layout{grid-template-columns:minmax(0,1fr)}.layout.open .stack{display:none}.layout:not(.open) .main{display:none}.back{all:unset;display:inline-flex;align-items:center;min-height:44px;color:var(--accent);cursor:pointer;font-size:14px;margin:-8px 0}}
.stack{display:grid;gap:8px}
.f{all:unset;box-sizing:border-box;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px;padding:9px 12px;border-radius:var(--radius);background:var(--panel);border:1px solid var(--line);cursor:pointer;width:100%}
.f:hover{border-color:var(--slate)}.f:focus-visible{outline:2px solid var(--accent)}
@media(min-width:861px){.f.sel{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 14%,var(--panel))}}
.f b{font-weight:500;font-size:14px}.f span{font-size:12.5px;color:var(--muted);grid-column:1/-1}.f em{font-style:normal;font-size:13px;text-align:right}
ul.gtree,ul.gtree ul{list-style:none;margin:0;padding:0;display:grid;gap:5px}ul.gtree ul{margin-top:5px;padding-left:18px}ul.gtree ul>li{position:relative}
ul.gtree ul>li::before{content:"";position:absolute;left:-11px;top:-5px;bottom:0;border-left:1px solid var(--muted)}ul.gtree ul>li:last-child::before{bottom:auto;height:33px}ul.gtree ul>li::after{content:"";position:absolute;left:-11px;top:28px;width:10px;border-top:1px solid var(--muted)}
.dt{display:grid}.dr{display:grid;grid-template-columns:minmax(0,1fr) 78px 78px 62px;gap:8px;padding:7px 0;border-bottom:1px solid var(--line);font-size:13.5px;align-items:center}.dr:last-child{border-bottom:0}.dr>span:not(:first-child){text-align:right}.dr.h{font-size:12px;color:var(--muted)}.dr.um{color:var(--muted)}.dr.um.bad{color:var(--warn)}.dr .n{display:flex;gap:6px;align-items:center;min-width:0;overflow-wrap:anywhere}.dr .n a{cursor:pointer;color:inherit}.dr .n a:hover{color:var(--accent)}.fold{all:unset;cursor:pointer;width:16px;text-align:center;color:var(--muted);flex:none}.fold:focus-visible{outline:2px solid var(--accent)}.nofold{width:16px;flex:none}
@media(max-width:560px){.dr{grid-template-columns:minmax(0,1fr) 64px 72px}.dr>span:nth-child(4){display:none}}
.main{display:grid;gap:12px;min-width:0;scroll-margin-top:60px;align-content:start}
.head{display:flex;justify-content:space-between;gap:12px;align-items:baseline}.head b{font-size:15px;font-weight:600;white-space:nowrap}
.title{font-weight:650;letter-spacing:-.02em;font-size:24px;line-height:1.15;margin:0;min-width:0}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(105px,1fr));gap:10px}
.kpi{all:unset;box-sizing:border-box;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:12px 14px;display:grid;gap:2px}
.kpi span{font-size:12.5px;color:var(--muted)}.kpi b{font-weight:650;letter-spacing:-.02em;font-size:19px;line-height:1.15;white-space:nowrap}
.box{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px;display:grid;gap:8px;min-width:0;align-content:start}
${CHART_CSS}
</style><div class="w"><div class="layout"><div class="stack" id="stack"></div><div class="main" id="main"></div></div><div class="drawer" id="drawer" hidden></div></div>`;
      const r = this.shadowRoot;
      r.querySelector('.w').addEventListener('click', (e) => this.onClick(e));
      const m = r.getElementById('main');
      chartTips(m, (v) => { this._hover = v; });
      new ResizeObserver(() => { if (this._mainW !== m.clientWidth) { this._mainW = m.clientWidth; if (this._hass) this.paint(); } }).observe(m);
      // The phone's back button leaves the group, not the page.
      window.addEventListener('popstate', () => { if (this.isConnected && this._detail) { this._detail = false; this._pushed = false; this._open = null; this.paint(); } });
      this.startTimer();
    }
    onClick(e) {
      const q = (a) => e.target.closest(a);
      let b;
      if ((b = q('[data-chart]'))) { this._modes[b.dataset.chart] = b.dataset.mode; this.paint(); return; }
      if (q('[data-manage]')) { navigate(SETUP_PATH); return; }
      if ((b = q('[data-fold]'))) { const id = b.dataset.fold; if (this._shut.has(id)) this._shut.delete(id); else this._shut.add(id); this.paint(); return; }
      if (q('[data-back]')) { if (this._pushed) history.back(); else { this._detail = false; this.paint(); } return; }
      if ((b = q('[data-place]'))) { this._place = b.dataset.place || null; if (!this._detail && innerWidth <= 860) { history.pushState({ portalGroup: 1 }, ''); this._pushed = true; } this._detail = true; this.remember(); this.refresh(); this.paint(); if (innerWidth <= 860) this.shadowRoot.querySelector('.w').scrollIntoView({ block: 'start' }); return; }
      if (q('[data-close]')) { this._open = null; this.paint(); return; }
      if ((b = q('[data-device]'))) { this._open = b.dataset.device; this.paint(); return; }
      if ((b = q('[data-report]'))) { groupsMemo = { at: currentLocation, place: this._place, detail: this._detail }; goToReport(b.dataset.report); return; }
      if ((b = q('[data-nav]'))) navigate(b.dataset.nav);
    }
    remember() { groupsMemo = { at: currentLocation, place: this._place }; }
    // With no group chosen yet, the first group is the one on show.
    space() { if (!this._place) this._place = placeChildren(currentLocation)[0]?.id ?? null; return resolveSpace(this._place); }
    startTimer() { this._t = setInterval(() => this.refresh(true), 60000); }
    async refresh(quiet) {
      const h = this._hass, sp = this.space(), now = Date.now(), tz = h.config.time_zone;
      if (!quiet) { this._e = null; this._parts = null; }
      const ids = sp.energy ? [...sp.energies, ...sp.powers] : [];
      try {
        const st = ids.length ? await statsWS(h, { type: 'recorder/statistics_during_period', start_time: new Date(now - 9 * 86400000).toISOString(), statistic_ids: ids, period: 'hour', types: ['change', 'state', 'mean', 'min', 'max'] }) : {};
        const raw = sp.energy ? await h.callWS({ type: 'history/history_during_period', start_time: new Date(now - (now % HOUR_MS)).toISOString(), end_time: new Date(now).toISOString(), entity_ids: sp.energies, minimal_response: true, no_attributes: true, significant_changes_only: false }) : {};
        if (this.space().id !== sp.id) return;
        this._totals = await portalTotals(h).catch(() => null);
        if (sp.energy) { this._parts = sp.energies.map((id, i) => ({ name: DEVICES.find((d) => d.id === sp.meters[i])?.name || id, b: withLiveHour(bucketEnergy(spreadCatchUp(st[id] || [], st[sp.powers[i]] || []), parseFloat(h.states[id]?.state), now, tz), hourSoFar(historyPts(raw, id))) })); this._e = mergeEnergy(this._parts.map((p) => p.b)); }
      } catch (e) { /* the figures stay as dashes and the next refresh tries again */ }
      this.paint();
    }
    paint() {
      if (this._hover) return;
      if (this._place && !placeById(this._place)) this._place = null;
      const r = this.shadowRoot, st = this._hass.states, sp = this.space(), admin = portalCanManage();
      if (!placeById(currentLocation)) { r.getElementById('stack').innerHTML = '<span class="muted">Loading…</span>'; r.getElementById('main').innerHTML = ''; this._lastPaint = 0; return; }
      const countOf = (id) => { const under = placesUnder(id); return allNodes.filter((d) => !d.virtual && under.has(d.place)).length; };
      const row = (id, name, selected, target) => { const s = resolveSpace(id), n = countOf(id); return `<button class="f${selected ? ' sel' : ''}" data-place="${target}"><b>${esc(name)}</b><em>${s.energy ? spacePower(s, st) : ''}</em><span>${n} ${n === 1 ? 'device' : 'devices'}</span></button>`; };
      const branch = (parent) => { const kids = placeChildren(parent); return kids.length ? `<ul>${kids.map((p) => `<li>${row(p.id, p.name, this._place === p.id, p.id)}${branch(p.id)}</li>`).join('')}</ul>` : ''; };
      const kids = placeChildren(currentLocation);
      r.getElementById('stack').innerHTML = `${kids.length ? `<ul class="gtree">${kids.map((p) => `<li>${row(p.id, p.name, this._place === p.id, p.id)}${branch(p.id)}</li>`).join('')}</ul>` : '<span class="muted">No groups yet.</span>'}${admin ? '<button data-manage="1">Edit groups</button>' : ''}`;
      r.querySelector('.layout').classList.toggle('open', this._detail);
      r.getElementById('main').innerHTML = `<button class="back" data-back>‹ Groups</button><div class="head"><h2 class="title">${esc(sp.name)}</h2>${sp.energy ? `<b>${spacePower(sp, st)}</b>` : ''}</div>${this.energy(sp, st)}`;
      const dr = r.getElementById('drawer'), open = DEVICES.find((d) => d.id === this._open);
      dr.hidden = !open;
      if (open) paintDrawer(this, dr, drawerHtml(open, st, Date.now(), this._totals));
    }
    // Draw at the real on-screen width, so a wide screen gets a wider chart instead of a taller one.
    chartW() { const w = this.shadowRoot.getElementById('main')?.clientWidth; return w > 66 ? Math.max(280, w - 34) : 640; }
    energy(sp, st) {
      if (!sp.energy) return '<div class="box"><span class="muted">No devices here yet.</span></div>';
      const e = this._e, now = Date.now(), rule = priceRule(this._hass), vat = vatNote(rule), pr = chartPrice(LAST_TOTALS, rule.now);
      // Today's cost: each of the group's hours at that hour's price.
      const eur = e ? e.today.reduce((t, v, k) => t + (v || 0) * pr.hour(k), 0) : null;
      return `<div class="kpis"><div class="kpi"><span>Usage now</span><b>${spacePower(sp, st)}</b></div><div class="kpi"><span>Usage today</span><b>${e ? `${e.todayTotal.toFixed(1)} kWh` : '—'}</b></div><div class="kpi"><span>Cost today</span><b>${e ? `€ ${eur.toFixed(2)}` : '—'}</b><small>${vat}</small></div></div>${chartBox('Energy by hour, today', 'hours', this._parts, 'hours', this._modes.hours, this.chartW(), pr, vat)}${chartBox('Energy by day', 'days', this._parts, 'days', this._modes.days, this.chartW(), pr, vat)}${this.deviceTable(sp, st, now)}${sp.report ? `<button data-report="${sp.report}">Open full report</button>` : ''}`;
    }
    // Each device with what is under it and what none of them measured. Folds like the tree it shows.
    deviceTable(sp, st, now) {
      const t = this._totals, vat = vatNote(priceRule(this._hass));
      if (!t || !sp.roots?.length) return '';
      const { rows } = breakdownRows(sp.roots, (id) => t.devices[id]?.today ?? null, t.stale), cost = breakdownRows(sp.roots, (id) => t.devices[id]?.todayEur ?? null, t.stale).rows;
      if (this._shutFor !== sp.id) { this._shutFor = sp.id; this._shut = shutBelow(rows); }
      let skip = null;
      const html = rows.map((x, i) => {
        if (skip != null && x.depth > skip) return '';
        skip = null;
        const kids = rows[i + 1]?.depth > x.depth, shut = kids && this._shut.has(x.id), um = x.kind === 'unmeasured';
        if (shut) skip = x.depth;
        const w = um ? null : liveReadings(readingsOf(x.id), st, now).power;
        const name = um ? `<span class="nofold"></span>${x.over ? 'Unmeasured: check wiring' : 'Unmeasured'}` : `${kids ? `<button class="fold" data-fold="${x.id}" aria-expanded="${!shut}" aria-label="${shut ? 'Show' : 'Hide'} devices under ${esc(x.name)}">${shut ? '▸' : '▾'}</button>` : '<span class="nofold"></span>'}<a data-device="${x.id}">${esc(x.name)}</a>`;
        return `<div class="dr${um ? ' um' : ''}${x.over ? ' bad' : ''}"><span class="n" style="padding-left:${x.depth * 16}px">${name}</span><span>${um ? '—' : w == null ? '—' : fmtPower({ state: String(w) })}</span><span>${x.kwh == null ? '—' : `${x.kwh.toFixed(2)} kWh`}</span><span>${cost[i]?.kwh == null ? '—' : `€ ${cost[i].kwh.toFixed(2)}`}</span></div>`;
      }).join('');
      return `<div class="box"><h3>Devices today</h3><div class="dt"><div class="dr h"><span>Device</span><span>Now</span><span>Today</span><span>Cost, ${vat}</span></div>${html}</div></div>`;
    }
  }
  // Controls: Home Assistant's own tile cards, listed by what they are and then by group.
  const WAIT_MS = 8000; // how long a switch may take to report back before it shows No response
  const lightTile = (entity, name, icon) => ({ type: 'tile', entity, name, icon, color: 'amber', tap_action: { action: 'toggle' }, icon_tap_action: { action: 'toggle' }, hold_action: { action: 'more-info' } });
  const CTRL_BULB = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12,2A7,7 0 0,0 5,9C5,11.38 6.19,13.47 8,14.74V17A1,1 0 0,0 9,18H15A1,1 0 0,0 16,17V14.74C17.81,13.47 19,11.38 19,9A7,7 0 0,0 12,2M9,21A1,1 0 0,0 10,22H14A1,1 0 0,0 15,21V20H9V21Z"/></svg>';
  const CTRL_AC = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.59,0.66C8.93,-1.15 11.47,1.06 12.04,4.5C12.47,4.5 12.89,4.62 13.27,4.84C13.79,4.24 14.25,3.42 14.07,2.5C13.65,0.35 16.06,-1.39 18.35,1.58C20.16,3.92 17.95,6.46 14.5,7.03C14.5,7.46 14.39,7.89 14.16,8.27C14.76,8.78 15.58,9.24 16.5,9.06C18.65,8.64 20.39,11.05 17.42,13.34C15.08,15.15 12.54,12.94 11.97,9.5C11.54,9.5 11.11,9.37 10.73,9.15C10.22,9.75 9.76,10.57 9.94,11.5C10.36,13.64 7.95,15.39 5.66,12.42C3.85,10.08 6.06,7.54 9.5,6.97C9.5,6.54 9.63,6.11 9.85,5.73C9.25,5.22 8.43,4.76 7.5,4.94C5.36,5.36 3.61,2.95 6.59,0.66M5,16H7A2,2 0 0,1 9,18V24H7V22H5V24H3V18A2,2 0 0,1 5,16M5,18V20H7V18H5M12.93,16H15L12.07,24H10L12.93,16M18,16H21V18H18V22H21V24H18A2,2 0 0,1 16,22V18A2,2 0 0,1 18,16Z"/></svg>';
  const CTRL_RELAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1,11H4.17C4.58,9.83 5.69,9 7,9C8.31,9 9.42,9.83 9.83,11H11.5L19.5,6.5L20.5,8.25L13.9,12L20.5,15.75L19.5,17.5L11.5,13H9.83C9.42,14.17 8.31,15 7,15C5.69,15 4.58,14.17 4.17,13H1V11M7,11A1,1 0 0,0 6,12A1,1 0 0,0 7,13A1,1 0 0,0 8,12A1,1 0 0,0 7,11M21,11V13H23V11H21Z"/></svg>';
  const CTRL_PLUG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16,7V3H14V7H10V3H8V7H8C7,7 6,8 6,9V14.5L9.5,18V21H14.5V18L18,14.5V9C18,8 17,7 16,7Z"/></svg>';
  const CTRL_CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z"/></svg>';
  const CTRL_CSS = `.w{gap:12px}
.pills{display:flex;gap:4px;padding:4px;border-radius:24px;background:var(--panel);box-shadow:var(--shadow);overflow-x:auto;scrollbar-width:none}
.pills button{all:unset;box-sizing:border-box;flex:1 0 auto;text-align:center;cursor:pointer;padding:8px 12px;border-radius:20px;font-size:14px;font-weight:500;color:var(--muted);transition:background .2s,color .2s;white-space:nowrap}.pills button.on{background:var(--primary-color);color:#fff}.pills button:focus-visible{outline:2px solid var(--primary-color);outline-offset:1px}.pills em{font-style:normal;font-size:12px;opacity:.8;margin-left:4px}
.hero{position:relative;overflow:hidden;display:flex;align-items:center;gap:12px;padding:8px 10px 8px 12px;border-radius:18px;background:var(--panel);box-shadow:var(--shadow);transition:background .4s}
.hero.lit{background:radial-gradient(120% 160% at 0% 0%,color-mix(in srgb,#ffb300 34%,var(--panel)) 0%,color-mix(in srgb,#ffb300 8%,var(--panel)) 55%,var(--panel) 100%)}
.orb{width:34px;height:34px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--fg) 8%,transparent);color:var(--muted);transition:all .3s}.orb svg{width:20px;height:20px;fill:currentColor}
.hero.lit .orb{background:#ffb300;color:#3a2600;box-shadow:0 0 26px color-mix(in srgb,#ffb300 70%,transparent)}
.big{min-width:0;flex:1}.big b{display:block;font-size:17px;font-weight:650;line-height:1.2}.big span{font-size:13px;color:var(--muted)}
.killer{all:unset;cursor:pointer;flex:none;padding:8px 14px;border-radius:18px;font-size:13.5px;font-weight:600;background:color-mix(in srgb,var(--fg) 10%,transparent);transition:background .2s}.killer:hover{background:color-mix(in srgb,var(--fg) 16%,transparent)}.killer:focus-visible{outline:2px solid var(--primary-color)}.killer:disabled{opacity:.4;cursor:default}.killer.armed{background:var(--bad);color:#fff}
.gc{border-radius:16px;background:var(--panel);box-shadow:var(--shadow);padding:2px 8px 8px;min-width:0;transition:box-shadow .3s}.gc.lit{box-shadow:var(--shadow),inset 0 0 0 1px color-mix(in srgb,#ffb300 45%,transparent)}
.gh{display:flex;align-items:center;gap:8px;min-height:42px;min-width:0}
.fold{all:unset;cursor:pointer;display:flex;align-items:center;gap:10px;flex:1;min-width:0;padding:6px 0}.fold:focus-visible{outline:2px solid var(--primary-color)}
.dot{width:26px;height:26px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--fg) 8%,transparent);color:var(--muted);transition:all .3s}.dot svg{width:15px;height:15px;fill:currentColor}.gc.lit .dot{background:#ffb300;color:#3a2600;box-shadow:0 0 14px color-mix(in srgb,#ffb300 55%,transparent)}
.nm{min-width:0;flex:1}.nm b{display:block;font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nm small{display:block;font-size:11.5px;color:var(--muted)}
.chev{width:20px;height:20px;fill:var(--muted);flex:none;transition:transform .2s}.gc.shut .chev{transform:rotate(-90deg)}
.ioo{display:flex;flex:none;padding:3px;border-radius:18px;background:color-mix(in srgb,var(--fg) 8%,transparent)}.ioo button{all:unset;cursor:pointer;padding:4px 11px;border-radius:15px;font-size:13px;font-weight:600;color:var(--muted);transition:background .2s,color .2s}.ioo button:focus-visible{outline:2px solid var(--primary-color)}.ioo button.on{background:#ffb300;color:#3a2600}.ioo button.off{background:color-mix(in srgb,var(--fg) 18%,transparent);color:var(--fg)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,150px),1fr));gap:6px;min-width:0;padding-top:2px}.gc.shut .cards{display:none}@media(min-width:871px){.cards{grid-template-columns:repeat(auto-fill,minmax(230px,1fr))}}
.slot{min-width:0;min-height:56px;--ha-card-border-radius:14px;--ha-card-border-width:0;--ha-card-box-shadow:none;--ha-card-background:color-mix(in srgb,var(--fg) 5%,transparent)}.slot.lit{--ha-card-background:color-mix(in srgb,#ffb300 16%,transparent)}
.chips{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,138px),1fr));gap:5px;min-width:0}.gc.shut .chips{display:none}
.ch{all:unset;box-sizing:border-box;cursor:pointer;display:flex;align-items:center;gap:8px;padding:6px 9px;border-radius:11px;background:color-mix(in srgb,var(--fg) 5%,transparent);min-width:0;transition:background .2s}.ch:hover{background:color-mix(in srgb,var(--fg) 9%,transparent)}.ch:focus-visible{outline:2px solid var(--primary-color)}
.ch i{width:24px;height:24px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--fg) 8%,transparent);color:var(--muted);transition:all .2s}.ch i svg{width:14px;height:14px;fill:currentColor}
.ch span{min-width:0;display:grid}.ch b{font-weight:500;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ch small{font-size:11px;color:var(--muted)}
.ch.lit{background:color-mix(in srgb,#ffb300 17%,transparent)}.ch.lit i{background:#ffb300;color:#3a2600}.ch.busy small{color:var(--fg)}.ch.busy i{animation:pulse 1s ease-in-out infinite}.ch.fail small{color:var(--bad);font-weight:600}.ch.gone{opacity:.45;cursor:default}
@keyframes pulse{50%{opacity:.4}}
.note{font-size:12px;color:var(--muted);padding:0 4px}
.none{display:grid;justify-items:center;gap:8px;padding:36px 16px;border-radius:18px;background:var(--panel);box-shadow:var(--shadow);color:var(--muted);font-size:14px}.none svg{width:44px;height:44px;fill:currentColor;opacity:.6}
.newa{justify-self:end}.sec{display:grid;gap:10px;min-width:0}
`;
  class ControlsCard extends Base {
    build() {
      this._tiles = new Map();
      this._pend = new Map(); // entity -> { want, at }: switched here, not confirmed yet
      try { this._sec = localStorage.getItem('portalControlsTab') || 'lights'; this._shut = new Set(JSON.parse(localStorage.getItem('portalControlsShut') || '[]')); } catch (e) { this._sec = 'lights'; this._shut = new Set(); }
      this.shadowRoot.innerHTML = `<style>${BASE}${AUTO_CSS}${CTRL_CSS}</style><div class="w"><div class="pills" id="pills" role="tablist"></div><div class="sec" id="sec"></div></div>`;
      this.shadowRoot.querySelector('.w').addEventListener('click', (e) => this.onClick(e));
      this.startTimer();
    }
    // Draw straight away: nothing else asks for the first paint, and the regular redraw is 10 seconds off.
    async refresh() { this.paint(); }
    set hass(h) { super.hass = h; this._tiles?.forEach((c) => { c.hass = h; }); }
    onClick(e) {
      const q = (a) => e.target.closest(a);
      let b;
      if ((b = q('[data-sec]'))) { this._sec = b.dataset.sec; try { localStorage.setItem('portalControlsTab', this._sec); } catch (x) { /* private window */ } this.paint(); return; }
      if ((b = q('[data-all]'))) { this.pressAll(b); return; }
      if ((b = q('[data-tog]'))) { const id = b.dataset.tog, now = this._hass.states[id]?.state; if (now === 'on' || now === 'off') this.send([id], now === 'on' ? 'off' : 'on'); return; }
      if ((b = q('[data-fold]'))) { const k = b.dataset.fold; if (this._shut.has(k)) this._shut.delete(k); else this._shut.add(k); try { localStorage.setItem('portalControlsShut', JSON.stringify([...this._shut])); } catch (x) { /* private window */ } b.closest('.gc').classList.toggle('shut', this._shut.has(k)); return; }
    }
    lightsIn(key, st) {
      const list = key ? DEVICES.filter((d) => d.switch && d.place === key && !isKept(d)) : groupSwitches(resolveSpace());
      return list.filter((d) => st[d.switch] && st[d.switch].state !== 'unavailable');
    }
    // A group answers at once and offers Undo. The whole location asks first, naming how many.
    pressAll(b) {
      const key = b.dataset.pl, how = b.dataset.all, st = this._hass.states, ids = this.lightsIn(key, st).filter((d) => st[d.switch].state !== how).map((d) => d.switch);
      if (!ids.length) return;
      if (!key) {
        if (this._confirmAll !== how) { this._confirmAll = how; this._armedAt = Date.now(); clearTimeout(this._armT); this._armT = setTimeout(() => { this._confirmAll = null; this.paint(); }, 5000); this.paint(); return; }
        if (Date.now() - this._armedAt < 500) return;
        this._confirmAll = null; clearTimeout(this._armT);
      }
      this.send(ids, how);
      showToast(this, `${key ? (key === currentLocation ? 'No group' : placeById(key)?.name) : placeById(currentLocation)?.name}: ${ids.length} turned ${how}`, () => this.send(ids, how === 'on' ? 'off' : 'on'));
    }
    // Each switch shows it is waiting until the device reports back, or says it did not answer.
    send(ids, how) {
      const at = Date.now();
      ids.forEach((id) => this._pend.set(id, { want: how, at }));
      const byDomain = ids.reduce((m, id) => { const k = id.split('.')[0]; (m[k] = m[k] || []).push(id); return m; }, {});
      for (const [domain, list] of Object.entries(byDomain)) this._hass.callService(domain, `turn_${how}`, { entity_id: list }).catch(() => { list.forEach((id) => this._pend.set(id, { want: how, at: 0 })); this.paint(); });
      clearTimeout(this._pendT); this._pendT = setTimeout(() => this.paint(), WAIT_MS + 100);
      this.paint();
    }
    get paintEvery() { return 3000; }
    chip(id, name, icon, dev = '') { return `<button class="ch" data-tog="${id}" data-entity="${id}" data-dev="${dev}"><i>${icon}</i><span><b>${esc(name)}</b><small></small></span></button>`; }
    // Home Assistant's tile only needs a place to sit. Kept between redraws so it does not flicker.
    async mount(cfgs) {
      this._helpers = this._helpers || await window.loadCardHelpers();
      const r = this.shadowRoot;
      for (const [key, cfg] of cfgs) {
        const slot = [...r.querySelectorAll('[data-tile]')].find((x) => x.dataset.tile === key);
        if (!slot) continue;
        let el = this._tiles.get(key);
        if (!el) { el = this._helpers.createCardElement(cfg); this._tiles.set(key, el); }
        el.hass = this._hass;
        slot.replaceChildren(el);
      }
    }
    groupHtml(fold, name, icon, tiles, pl, chips = '') {
      const buttons = pl ? `<div class="ioo" role="group" aria-label="${esc(name)}"><button data-all="on" data-pl="${pl}">On</button><button data-all="off" data-pl="${pl}">Off</button></div>` : '';
      return `<div class="gc${this._shut.has(fold) ? ' shut' : ''}" data-pl-card="${pl || ''}"><div class="gh"><button class="fold" data-fold="${esc(fold)}" aria-label="Show or hide ${esc(name)}"><span class="dot">${icon}</span><span class="nm"><b>${esc(name)}</b><small data-count="${pl || ''}"></small></span>${CTRL_CHEVRON.replace('<svg', '<svg class="chev"')}</button>${buttons}</div>${chips ? `<div class="chips">${chips}</div>` : `<div class="cards">${tiles.map(([k, cfg]) => `<div class="slot" data-tile="${esc(k)}" data-entity="${cfg.entity}"></div>`).join('')}</div>`}</div>`;
    }
    paint() {
      const r = this.shadowRoot, h = this._hass, st = h.states, box = r.getElementById('sec');
      if (!placeById(currentLocation)) { box.innerHTML = '<span class="muted">Loading…</span>'; this._sig = null; this._lastPaint = 0; return; }
      const under = placesUnder(currentLocation), places = [...flatPlaces().filter((p) => under.has(p.id) && p.id !== currentLocation), placeById(currentLocation)];
      const tile = (cfg) => [JSON.stringify(cfg), cfg];
      const groups = places.map((p) => ({ p, list: [...DEVICES.filter((d) => d.switch && d.place === p.id && !isKept(d)).sort(byName).map((d) => [d.switch, d.name, d.id])] })).filter((g) => g.list.length);
      // Sockets and relays have their own tab: they are switched one at a time, never with the lights.
      const plugs = places.map((p) => ({ p, list: DEVICES.filter((d) => d.switch && d.place === p.id && ['socket', 'relay'].includes(kindOf(d))).sort(byName) })).filter((g) => g.list.length);
      // ponytail: an AC is a switch for now. A real climate.* entity becomes one tile with climate-hvac-modes and target-temperature features when the first one is connected.
      const climate = places.map((p) => ({ p, tiles: DEVICES.filter((d) => d.switch && d.place === p.id && kindOf(d) === 'ac').sort(byName).map((d) => tile({ ...lightTile(d.switch, d.name, 'mdi:air-conditioner'), color: 'light-blue' })) })).filter((g) => g.tiles.length);
      const live = this.lightsIn('', st), on = live.filter((d) => st[d.switch].state === 'on').length, armed = this._confirmAll;
      const plugsOn = plugs.flatMap((g) => g.list).filter((d) => st[d.switch]?.state === 'on').length;
      const SECS = [['lights', 'Lights', on || ''], ...(plugs.length ? [['plugs', 'Sockets & relays', plugsOn || '']] : []), ...(climate.length ? [['climate', 'Climate', '']] : [])];
      if (!SECS.some(([k]) => k === this._sec)) this._sec = 'lights';
      const pills = SECS.map(([k, n, c]) => `<button class="${this._sec === k ? 'on' : ''}" role="tab" aria-selected="${this._sec === k}" data-sec="${k}">${n}${c !== '' ? `<em>${c}</em>` : ''}</button>`).join('');
      if (r.getElementById('pills').innerHTML !== pills) r.getElementById('pills').innerHTML = pills;
      const cfgs = this._sec === 'climate' ? climate.flatMap((g) => g.tiles) : [];
      const sig = `${currentLocation}|${this._sec}|${this._sec === 'lights' ? groups.map((g) => g.list.map(([id]) => id).join()).join('|') : this._sec === 'plugs' ? plugs.map((g) => g.list.map((d) => d.id).join()).join('|') : cfgs.map(([k]) => k).join()}`;
      if (this._sig !== sig) {
        this._sig = sig;
        const lightsHtml = `<div class="hero" id="hero"><span class="orb">${CTRL_BULB}</span><div class="big"><b id="heroN"></b></div><button class="killer" id="killer" data-all="off" data-pl="">All off</button></div>${groups.map((g) => this.groupHtml(g.p.id, g.p.id === currentLocation ? 'No group' : g.p.name, CTRL_BULB, [], g.list.some(([id]) => id.startsWith('switch.')) ? g.p.id : '', g.list.map(([id, n, dev]) => this.chip(id, n, CTRL_BULB, dev)).join(''))).join('') || `<div class="none">${CTRL_BULB}No lights yet</div>`}`;
        const plugsHtml = `<span class="note">Switched one at a time. All off and the group buttons under Lights never touch these.</span>${plugs.map((g) => this.groupHtml(`plug:${g.p.id}`, g.p.id === currentLocation ? 'No group' : g.p.name, CTRL_PLUG, [], '', g.list.map((d) => this.chip(d.switch, d.name, kindOf(d) === 'socket' ? CTRL_PLUG : CTRL_RELAY, d.id)).join(''))).join('')}`;
        const climateHtml = climate.map((g) => this.groupHtml(`ac:${g.p.id}`, g.p.name, CTRL_AC, g.tiles, '')).join('') || `<div class="none">${CTRL_AC}No climate devices yet</div>`;
        box.innerHTML = this._sec === 'lights' ? lightsHtml : this._sec === 'plugs' ? plugsHtml : climateHtml;
        if (cfgs.length) this.mount(cfgs);
      }
      // A chip says On or Off as the device reports it; while waiting, what it was asked to do; past the wait, that it did not answer.
      const nowMs = Date.now();
      r.querySelectorAll('.ch[data-entity]').forEach((c) => {
        const id = c.dataset.entity, s = st[id]?.state, p = this._pend.get(id);
        if (p && s === p.want) this._pend.delete(id);
        const waiting = p && s !== p.want && nowMs - p.at < WAIT_MS, failed = p && !waiting && s !== p.want, gone = !s || s === 'unavailable';
        if (failed && nowMs - p.at > WAIT_MS + 6000) this._pend.delete(id);
        c.classList.toggle('lit', s === 'on'); c.classList.toggle('busy', !!waiting); c.classList.toggle('fail', !!failed); c.classList.toggle('gone', gone);
        c.setAttribute('aria-pressed', String(s === 'on'));
        const d = c.dataset.dev && DEVICES.find((x) => x.id === c.dataset.dev), w = d?.power ? devicePower(d, st) : '';
        c.querySelector('small').textContent = gone ? 'Offline' : waiting ? (p.want === 'on' ? 'Turning on…' : 'Turning off…') : failed ? 'No response' : `${s === 'on' ? 'On' : 'Off'}${w ? ` · ${w}` : ''}`;
      });
      if (this._pend.size) { clearTimeout(this._pendT); this._pendT = setTimeout(() => this.paint(), 1000); }
      // What changes with the state: only these, so nothing flickers.
      const hero = r.getElementById('hero');
      if (hero) {
        hero.classList.toggle('lit', on > 0);
        r.getElementById('heroN').textContent = `${on} of ${live.length} lights on · ${spacePower(resolveSpace(), st)}`;
        const k = r.getElementById('killer');
        k.disabled = !on; k.classList.toggle('armed', armed === 'off'); k.textContent = armed === 'off' ? `Turn off ${on}?` : 'All off';
      }
      r.querySelectorAll('[data-pl-card]').forEach((c) => {
        const key = c.dataset.plCard, label = c.querySelector('[data-count]'), slots = [...c.querySelectorAll('[data-entity]')];
        slots.forEach((x) => x.classList.toggle('lit', st[x.dataset.entity]?.state === 'on'));
        if (!label) return;
        const lit = slots.some((x) => x.classList.contains('lit'));
        c.classList.toggle('lit', lit);
        const devs = slots.map((x) => DEVICES.find((d) => d.id === x.dataset.dev)).filter((d) => d?.power), w = devs.length ? liveReadings(devs, st, Date.now()).power : null, watts = w == null ? '' : ` · ${powerText(w)}`;
        if (!key) { label.textContent = `${slots.length === 1 ? (lit ? 'On' : 'Off') : `${slots.filter((x) => x.classList.contains('lit')).length} of ${slots.length} on`}${watts}`; return; }
        const lights = this.lightsIn(key, st), n = lights.filter((d) => st[d.switch].state === 'on').length;
        label.textContent = `${n === lights.length && n ? (n === 1 ? 'On' : 'All on') : n ? `${n} of ${lights.length} on` : 'Off'}${watts}`;
        c.querySelector('[data-all="on"]').className = n && n === lights.length ? 'on' : '';
        c.querySelector('[data-all="off"]').className = n ? '' : 'off';
      });
    }
  }
  class Building3dCard extends Base {
    build() {
      this._ang = -0.35; this._sel = null;
      this.shadowRoot.innerHTML = `<style>${BASE}
.stage{position:relative;border-radius:22px;overflow:hidden;background:radial-gradient(120% 90% at 50% 0%,color-mix(in srgb,var(--primary-color) 10%,var(--panel)) 0%,var(--panel) 70%);box-shadow:var(--shadow);touch-action:pan-y;cursor:grab;user-select:none}
.stage.drag{cursor:grabbing}svg{display:block;width:100%;height:auto;max-height:62vh}
.rot{position:absolute;right:10px;bottom:10px;display:flex;gap:6px}.rot button{all:unset;cursor:pointer;width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--fg) 12%,var(--panel));font-size:18px}.rot button:focus-visible{outline:2px solid var(--primary-color)}
.sum{display:flex;align-items:baseline;gap:8px;font-size:13px;color:var(--muted)}.sum b{font-size:22px;color:var(--fg);font-weight:650}
.info{display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:18px;background:var(--panel);box-shadow:var(--shadow)}.info div{flex:1;min-width:0}.info b{display:block;font-size:16px}.info span{font-size:13px;color:var(--muted)}
.room{cursor:pointer}.room text{pointer-events:none}
</style><div class="w"><div class="sum" id="sum"></div><div class="stage" id="stage"><svg id="svg" role="img" aria-label="3D view of the location"></svg><div class="rot"><button data-rot="-1" aria-label="Turn left">⟲</button><button data-rot="1" aria-label="Turn right">⟳</button></div></div><div id="info"></div></div>`;
      const r = this.shadowRoot, stage = r.getElementById('stage');
      let start = null;
      stage.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; start = { x: e.clientX, a: this._ang, moved: false }; });
      stage.addEventListener('pointermove', (e) => { if (!start) return; const dx = e.clientX - start.x; if (Math.abs(dx) > 4) { start.moved = true; stage.classList.add('drag'); stage.setPointerCapture?.(e.pointerId); } if (start.moved) { this._ang = start.a + dx / 160; this.draw(); } });
      const end = (e) => { if (start && !start.moved) { const g = e.target.closest?.('[data-room]'); this._sel = g ? (this._sel === g.dataset.room ? null : g.dataset.room) : null; this.draw(); } start = null; stage.classList.remove('drag'); };
      stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', () => { start = null; stage.classList.remove('drag'); });
      r.querySelector('.w').addEventListener('click', (e) => { const b = e.target.closest('[data-rot]'); if (b) this.turn(Number(b.dataset.rot) * Math.PI / 2); const n = e.target.closest('[data-nav]'); if (n) navigate(n.dataset.nav); });
      this.startTimer();
    }
    async refresh() { this.paint(); }
    // A quarter turn, eased, so the building is seen to rotate.
    turn(by) {
      const from = this._ang, to = from + by, t0 = performance.now();
      const step = (t) => { const k = Math.min(1, (t - t0) / 450), e = 1 - (1 - k) ** 3; this._ang = from + (to - from) * e; this.draw(); if (k < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    }
    paint() {
      const st = this._hass.states, now = Date.now();
      if (!placeById(currentLocation)) { this.shadowRoot.getElementById('sum').textContent = 'Loading…'; this._lastPaint = 0; return; }
      const under = placesUnder(currentLocation), places = [...flatPlaces().filter((p) => under.has(p.id)), placeById(currentLocation)];
      const rooms = places.map((p) => {
        const sp = resolveSpace(p.id), w = p.id === currentLocation ? null : sp.meters ? liveReadings(DEVICES.filter((d) => sp.meters.includes(d.id)), st, now).power : null;
        const lights = DEVICES.filter((d) => d.switch && d.place === p.id).sort(byName).map((d) => ({ id: d.id, name: d.name, on: st[d.switch]?.state === 'on', kept: isKept(d) }));
        return { id: p.id, name: p.id === currentLocation ? 'No group' : p.name, w, lights };
      }).filter((r) => r.lights.length || r.w != null);
      this._rooms = layoutRooms(rooms);
      this._whole = spacePower(resolveSpace(), st);
      this.draw();
    }
    draw() {
      const rooms = this._rooms;
      if (!rooms) return;
      const r = this.shadowRoot, S = 34, H = 0.9, maxW = Math.max(1, ...rooms.map((x) => x.w || 0));
      const xs = rooms.flatMap((x) => [x.x0, x.x1]), ys = rooms.flatMap((x) => [x.y0, x.y1]);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2, R = Math.hypot(Math.max(...xs) - cx, Math.max(...ys) - cy) + 0.6;
      const c = Math.cos(this._ang), sn = Math.sin(this._ang);
      const rot = (x, y) => [cx + (x - cx) * c - (y - cy) * sn, cy + (x - cx) * sn + (y - cy) * c];
      const P = (x, y, z) => { const [a, b] = rot(x, y); return [((a - cx) - (b - cy)) * 0.866 * S, ((a - cx) + (b - cy)) * 0.5 * S - z * S]; };
      const poly = (pts) => pts.map((q) => q.map((v) => v.toFixed(1)).join(',')).join(' ');
      const depth = (x, y) => { const [a, b] = rot(x, y); return a + b; };
      const x0 = Math.min(...xs) - 0.6, x1 = Math.max(...xs) + 0.6, y0 = Math.min(...ys) - 0.6, y1 = Math.max(...ys) + 0.6;
      const slab = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      // The frame fits the ground at any angle, so turning never makes the picture jump in size.
      const reach = Math.max(...Array.from({ length: 16 }, (_, i) => { const a = (i / 16) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a); return Math.max(...slab.map(([x, y]) => Math.abs(((x - cx) * ca - (y - cy) * sa) - ((x - cx) * sa + (y - cy) * ca)))); }));
      const halfW = reach * 0.866 * S, top = reach * 0.5 * S + (H + 1.2) * S, bottom = reach * 0.5 * S + 8;
      let out = `<defs><filter id="glow" x="-1" y="-1" width="3" height="3"><feGaussianBlur stdDeviation="${(S * 0.22).toFixed(1)}"/></filter></defs>`;
      out += `<polygon points="${poly(slab.map(([x, y]) => P(x, y, -0.15)))}" fill="color-mix(in srgb,var(--primary-text-color) 6%,transparent)"/>`;
      const sorted = [...rooms].sort((a, b) => depth((a.x0 + a.x1) / 2, (a.y0 + a.y1) / 2) - depth((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2));
      for (const m of sorted) {
        const corners = [[m.x0, m.y0], [m.x1, m.y0], [m.x1, m.y1], [m.x0, m.y1]], sel = this._sel === m.id, heat = m.w ? Math.min(1, m.w / maxW) : 0;
        const walls = corners.map((a, i) => { const b = corners[(i + 1) % 4], nx = b[1] - a[1], ny = a[0] - b[0], [rx, ry] = rot(cx + nx, cy + ny); return { a, b, back: (rx - cx) + (ry - cy) < 0 }; });
        const wall = (w, op) => `<polygon points="${poly([P(...w.a, 0), P(...w.b, 0), P(...w.b, H), P(...w.a, H)])}" fill="color-mix(in srgb,var(--primary-text-color) ${op}%,var(--card-background-color))" stroke="color-mix(in srgb,var(--primary-text-color) 18%,transparent)" stroke-width="0.6"/>`;
        let g = `<g class="room" data-room="${m.id}">`;
        g += `<polygon points="${poly(corners.map(([x, y]) => P(x, y, 0)))}" fill="color-mix(in srgb,#ff7a00 ${Math.round(8 + heat * 42)}%,var(--card-background-color))" stroke="${sel ? 'var(--primary-color)' : 'color-mix(in srgb,var(--primary-text-color) 22%,transparent)'}" stroke-width="${sel ? 2.5 : 0.8}"/>`;
        g += walls.filter((w) => w.back).map((w) => wall(w, 16)).join('');
        for (const l of m.spots) {
          const [fx, fy] = P(l.x, l.y, 0), [bx, by] = P(l.x, l.y, H * 0.85);
          if (l.on) g += `<ellipse cx="${fx.toFixed(1)}" cy="${fy.toFixed(1)}" rx="${(S * 0.75).toFixed(1)}" ry="${(S * 0.43).toFixed(1)}" fill="#ffb300" opacity="0.55" filter="url(#glow)"/>`;
          g += `<line x1="${bx.toFixed(1)}" y1="${(by - S * 0.5).toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="color-mix(in srgb,var(--primary-text-color) 30%,transparent)" stroke-width="0.8"/>`;
          if (l.on) g += `<circle cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="${(S * 0.36).toFixed(1)}" fill="#ffb300" opacity="0.8" filter="url(#glow)"/>`;
          g += `<circle cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="${(S * 0.13).toFixed(1)}" fill="${l.on ? '#ffd166' : 'color-mix(in srgb,var(--primary-text-color) 35%,var(--card-background-color))'}"><title>${esc(l.name)}: ${l.on ? 'on' : 'off'}</title></circle>`;
        }
        g += walls.filter((w) => !w.back).map((w) => wall(w, 4).replace('<polygon', '<polygon fill-opacity="0.35"')).join('');
        const [tx, ty] = P((m.x0 + m.x1) / 2, (m.y0 + m.y1) / 2, H + 0.55);
        g += `<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="middle" font-size="12" font-weight="600" fill="var(--primary-text-color)" paint-order="stroke" stroke="var(--card-background-color)" stroke-width="3">${esc(m.name)}</text></g>`;
        out += g;
      }
      const svg = r.getElementById('svg'), vbW = 2 * halfW + 20, vbH = top + bottom;
      svg.setAttribute('viewBox', `${(-halfW - 10).toFixed(0)} ${(-top).toFixed(0)} ${vbW.toFixed(0)} ${vbH.toFixed(0)}`);
      const k = Math.min((svg.clientWidth || 340) / vbW, (svg.clientHeight || Infinity) / vbH);
      out = out.replace(/font-size="12"/g, `font-size="${(12 / k).toFixed(1)}"`).replace(/stroke-width="3">/g, `stroke-width="${(3 / k).toFixed(1)}">`);
      svg.innerHTML = out;
      const all = rooms.flatMap((m) => m.spots), on = all.filter((l) => l.on).length;
      r.getElementById('sum').innerHTML = `<b>${on} of ${all.length} lights on</b>${this._whole} now`;
      const m = rooms.find((x) => x.id === this._sel);
      r.getElementById('info').innerHTML = m ? `<div class="info"><div><b>${esc(m.name)}</b><span>${m.spots.filter((l) => l.on).length} of ${m.spots.length} lights on${m.w != null ? ` · ${powerText(m.w)}` : ''}</span></div><button class="gold" data-nav="/energy-controls/controls">Controls</button></div>` : '<span class="muted">Drag to turn the building. Tap a room for details.</span>';
    }
  }
  class SchedulesCard extends Base {
    build() {
      this.shadowRoot.innerHTML = `<style>${BASE}${AUTO_CSS}
${SHEET_CSS}</style><div class="w"><div class="chead"><h2>Automations</h2><button class="gold" id="new" data-new="1" hidden>+ New</button></div><div class="slist" id="list"></div>
<dialog id="dlg" aria-labelledby="dlgT"><div class="dh"><h3 id="dlgT"></h3><button class="x" data-cancel="1" aria-label="Close">×</button></div><div class="db" id="form"></div><div class="df" id="foot"></div></dialog></div>`;
      const r = this.shadowRoot;
      r.querySelector('.w').addEventListener('click', (e) => this.onClick(e));
      // Escape or a tap outside closes it without saving.
      const dlg = r.getElementById('dlg');
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); this._form = null; this.paintForm(); });
      dlg.addEventListener('click', (e) => { if (e.target === dlg) { this._form = null; this.paintForm(); } });
      r.getElementById('form').addEventListener('input', (e) => {
        const k = e.target.dataset.fld, f = this._form;
        if (!k || !f) return;
        f[k] = e.target.value;
        if (k === 'place') { this.devicesFor(f); this.paintForm(); }
      });
      this.startTimer();
    }
    async refresh() {
      // What each automation switches, so the list can say so and the form can change it. Only an admin can read it.
      this._cfgs = AUTO_CFG;
      for (const a of automationsIn(resolveSpace())) { try { this._cfgs[a.entity] = portalCanManageHA() ? (await this._hass.callWS({ type: 'automation/config', entity_id: a.entity })).config : (await this._hass.callWS({ ...clientArg(), type: 'optim_energy/automation/get', entity_id: a.entity })).config; } catch (e) { /* listed without its devices */ } }
      this.paint();
    }
    // Lights are ticked; sockets, relays and the rest are left out unless someone ticks them.
    // A group offers its own devices, lights ticked. Choosing devices, or changing an automation, offers every device of the location.
    devicesFor(f) {
      const all = this.switchable().map((d) => d.switch);
      if (f.entity) { const had = cfgSwitches(this._cfgs?.[f.entity]); f.switches = [...new Set([...had, ...all])]; f.on = new Set(had); return; }
      if (f.target === 'devices') { f.switches = all; f.on = new Set([...(f.on || [])].filter((x) => all.includes(x))); return; }
      const ids = switchesIn(resolveSpace(f.place)).map((d) => d.switch);
      f.switches = ids; f.on = new Set(ids.filter((id) => switchInfo(this._hass, id).kind === 'lights'));
    }
    // A Home Assistant automation can have an area or a label, not a floor, so with sites from Home Assistant a floor is not offered.
    groupsWithSwitches() { const under = placesUnder(currentLocation); return flatPlaces().filter((p) => under.has(p.id) && !p.id.startsWith('floor:') && groupSwitches(resolveSpace(p.id)).length); }
    // Everything in the location that can be switched, for an automation of one device.
    switchable() { return switchesIn(resolveSpace()).sort(byName); }
    async openForm({ entity, place } = {}) {
      const a = entity && portalAutomations().find((x) => x.entity === entity);
      // Its devices come from its own settings, read fresh, so what shows is what it does.
      if (a) { try { AUTO_CFG[entity] = (portalCanManageHA() ? await this._hass.callWS({ type: 'automation/config', entity_id: entity }) : await this._hass.callWS({ ...clientArg(), type: 'optim_energy/automation/get', entity_id: entity })).config; } catch (e) { /* shows what was read before */ } }
      this._form = a ? { entity, name: autoTitle(a), place: a.place, how: a.how || 'off', at: a.at, days: a.days || [...DAY_KEY] } : { name: '', target: 'group', place: place || this.groupsWithSwitches()[0]?.id, how: 'off', at: '18:00', days: [...DAY_KEY] };
      this.devicesFor(this._form);
      this.paintForm();
      this.shadowRoot.getElementById('form').scrollTop = 0;
    }
    paintForm() {
      const f = this._form, r = this.shadowRoot, dlg = r.getElementById('dlg'), box = r.getElementById('form');
      if (!f) { if (dlg.open) dlg.close(); return; }
      const groups = this.groupsWithSwitches(), keep = box.scrollTop;
      const seg = (name, list, now, attr) => `<div class="seg" role="group" aria-label="${name}">${list.map(([k, n]) => `<button class="${now === k ? 'on' : ''}" ${attr}="${k}" aria-pressed="${now === k}">${n}</button>`).join('')}</div>`;
      // Devices sorted into their groups, so a long list is easy to scan.
      const byGroup = new Map();
      for (const id of f.switches || []) { const d = DEVICES.find((x) => x.switch === id), k = d?.place && d.place !== currentLocation ? placeById(d.place)?.name || '' : ''; if (!byGroup.has(k)) byGroup.set(k, []); byGroup.get(k).push(id); }
      const devChip = (id) => { const i = switchInfo(this._hass, id); return `<button class="${f.on.has(id) ? 'on' : ''}" data-dev="${id}" aria-pressed="${f.on.has(id)}">${esc(i.name)}${i.kind === 'lights' ? '' : `<em>${KIND_LABEL[i.kind]}</em>`}</button>`; };
      const devices = f.switches?.length ? `<div><div class="lab"><span>Devices · ${f.on.size} chosen</span>${f.on.size ? '<button class="quick" data-none="1">Clear</button>' : ''}</div>${[...byGroup].sort(([a], [b]) => !a - !b || a.localeCompare(b)).map(([g, ids]) => `<div class="devg">${byGroup.size > 1 ? `<small>${esc(g || 'No group')}</small>` : ''}<div class="devs" role="group" aria-label="Devices${g ? ` in ${esc(g)}` : ''}">${ids.map(devChip).join('')}</div></div>`).join('')}</div>` : '';
      const what = f.entity ? '' : `<div><div class="lab">Switches</div>${seg('What it switches', [['group', 'A group'], ['devices', 'Choose devices']], f.target, 'data-target')}</div>${f.target === 'devices' ? '' : `<div><div class="lab">Group</div><select class="gp" data-fld="place">${groups.map((p) => `<option value="${p.id}"${p.id === f.place ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>`}`;
      r.getElementById('dlgT').textContent = f.entity ? 'Change automation' : 'New automation';
      box.innerHTML = `<div><div class="lab">Name</div><input class="nm" data-fld="name" type="text" value="${esc(f.name || '')}" placeholder="For example: Lights off in the evening" maxlength="80"></div>
<div><div class="lab">When</div><div class="row">${seg('Action', [['off', 'Turn off'], ['on', 'Turn on']], f.how, 'data-how')}<input class="tm" type="time" data-fld="at" value="${esc(f.at)}" aria-label="Time"></div></div>
<div><div class="lab"><span>Days</span><span>${[['Every day', DAY_KEY], ['Mon to Fri', DAY_KEY.slice(0, 5)]].map(([n, d]) => `<button class="quick" data-days="${d.join()}">${n}</button>`).join(' · ')}</span></div><div class="days" role="group" aria-label="Days">${DAY_KEY.map((d, i) => `<button class="${f.days.includes(d) ? 'on' : ''}" data-day="${d}" aria-pressed="${f.days.includes(d)}">${DAY_SHORT[i].slice(0, 2)}</button>`).join('')}</div></div>
${what}${devices}<span class="err">${f.err || ''}</span>`;
      box.scrollTop = keep;
      r.getElementById('foot').innerHTML = `${f.entity ? `<button class="del${f.confirm ? ' armed' : ''}" data-del="1"${f.busy ? ' disabled' : ''}>${f.confirm ? 'Tap again to delete' : 'Delete'}</button>` : ''}<span class="sp"></span><button data-cancel="1">Cancel</button><button class="gold" data-save="1"${f.busy ? ' disabled' : ''}>${f.busy ? 'Saving…' : 'Save'}</button>`;
      if (!dlg.open) { dlg.showModal(); if (!f.entity) r.querySelector('input.nm')?.focus(); }
    }
    onClick(e) {
      const q = (a) => e.target.closest(a), f = this._form;
      let b;
      if ((b = q('[data-auto]'))) { toggleAutomation(this, b.dataset.auto, b.dataset.on === 'true'); return; }
      if (!this._c?.manage) return;
      if (q('[data-new]')) { this.openForm(); return; }
      if ((b = q('[data-ha-auto]'))) { navigate(`/config/automation/edit/${b.dataset.haAuto}`); return; }
      if ((b = q('[data-sched]'))) { this.openForm({ entity: b.dataset.sched }); return; }
      if (!f) return;
      if (q('[data-cancel]')) { this._form = null; this.paintForm(); return; }
      if ((b = q('[data-how]'))) { f.how = b.dataset.how; this.paintForm(); return; }
      if ((b = q('[data-target]'))) { f.target = b.dataset.target; f.on = new Set(); if (f.target === 'group') f.place = this.groupsWithSwitches()[0]?.id; this.devicesFor(f); this.paintForm(); return; }
      if ((b = q('[data-dev]'))) { const id = b.dataset.dev; if (f.on.has(id)) f.on.delete(id); else f.on.add(id); this.paintForm(); return; }
      if ((b = q('[data-days]'))) { f.days = b.dataset.days.split(','); this.paintForm(); return; }
      if (q('[data-none]')) { f.on = new Set(); this.paintForm(); return; }
      if ((b = q('[data-day]'))) { const d = b.dataset.day; f.days = DAY_KEY.filter((x) => (x === d ? !f.days.includes(d) : f.days.includes(x))); this.paintForm(); return; }
      if (q('[data-save]')) { this.save(); return; }
      if (q('[data-del]')) this.remove();
    }
    fail(text) { this._form.err = text; this._form.busy = false; this.paintForm(); }
    async save() {
      const f = this._form, h = this._hass, old = f.entity && portalAutomations().find((a) => a.entity === f.entity);
      if (!f.name?.trim()) { this.fail('Give it a name.'); return; }
      if (!f.at) { this.fail('Choose a time.'); return; }
      if (!f.days.length) { this.fail('Choose at least one day.'); return; }
      const name = f.name.trim(), switches = (f.switches || []).filter((x) => f.on.has(x));
      if (f.entity || f.target === 'devices') { const at = [...new Set(switches.map((x) => DEVICES.find((d) => d.switch === x)?.place).filter(Boolean))]; f.place = at.length === 1 ? at[0] : currentLocation; }
      if (!switches.length) { this.fail('Choose at least one device.'); return; }
      f.busy = true; f.err = ''; this.paintForm();
      const id = old ? h.states[old.entity]?.attributes?.id : `portal_${Date.now().toString(36)}`;
      try {
        if (!id) throw new Error('no id');
        const alias = `${placeById(currentLocation)?.name}: ${name}`;
        let entity = old?.entity;
        if (!portalCanManageHA()) {
          const saved = await h.callWS({ ...clientArg(), type: 'optim_energy/automation/save_schedule', ...(old?.entity ? { entity_id: old.entity } : {}), name: alias, place: f.place, how: f.how, at: f.at, days: f.days, switches });
          entity = saved.entity_id;
          AUTO_CFG[entity] = saved.config;
          treeLoad = null;
          await ensureTree(h);
        } else {
          const base = old ? (await h.callWS({ type: 'automation/config', entity_id: old.entity })).config : null;
          const made = scheduleConfig(base, { alias, how: f.how, at: f.at, days: f.days, switches });
          await h.callApi('POST', `config/automation/config/${id}`, made);
          AUTO_CFG[old?.entity || ''] = made;
          for (let i = 0; i < 30 && !entity; i += 1) { await new Promise((res) => setTimeout(res, 500)); entity = Object.values(this._hass.states).find((s) => s.entity_id.startsWith('automation.') && s.attributes.id === id)?.entity_id; }
          if (!entity) { await h.callApi('DELETE', `config/automation/config/${id}`).catch(() => {}); throw new Error('not started'); }
          AUTO_CFG[entity] = made;
          await saveTree(h, { ...TREE, automations: [...TREE.automations.filter((a) => a.entity !== entity), { entity, name: alias, at: f.at, place: f.place, devices: switches.length, how: f.how, days: f.days }] });
        }
        this._form = null; this.paintForm();
        treeLoad = null; await ensureTree(h);
        this.paint();
        showToast(this, 'Automation saved');
      } catch (e) { this.fail('Could not save. Try again.'); }
    }
    async remove() {
      const f = this._form, h = this._hass;
      if (!f.confirm) { f.confirm = true; this.paintForm(); return; }
      f.busy = true; this.paintForm();
      try {
        if (portalCanManageHA()) {
          await h.callApi('DELETE', `config/automation/config/${h.states[f.entity]?.attributes?.id}`);
          await saveTree(h, { ...TREE, automations: TREE.automations.filter((a) => a.entity !== f.entity) });
        } else {
          await h.callWS({ ...clientArg(), type: 'optim_energy/automation/delete', entity_id: f.entity });
          treeLoad = null; await ensureTree(h);
        }
        this._form = null; this.paintForm();
        treeLoad = null; await ensureTree(h);
        this.paint();
        showToast(this, 'Automation deleted');
      } catch (e) { f.confirm = false; this.fail('Could not delete. Try again.'); }
    }
    paint() {
      if (!this._cfgs) return;
      const r = this.shadowRoot, st = this._hass.states, whole = resolveSpace(), admin = portalCanManage() && this._c?.manage;
      r.getElementById('new').hidden = !admin || !this.groupsWithSwitches().length;
      const list = schedulesSorted(automationsIn(whole));
      const note = (a) => { const ids = cfgSwitches(this._cfgs?.[a.entity]); if (!ids.length) return ''; const odd = ids.map((id) => switchInfo(this._hass, id)).filter((x) => x.kind !== 'lights'); return ` · ${ids.length} device${ids.length === 1 ? '' : 's'}${odd.length ? `<span class="warnx"> · also ${odd.map((x) => `${esc(x.name)} (${KIND_LABEL[x.kind]})`).join(', ')}</span>` : ''}`; };
      r.getElementById('list').innerHTML = list.map((a) => scheduleRow(a, st, admin, note(a))).join('') || '<span class="muted">No automations yet.</span>';
    }
  }

  // Alert rules, under Setup. Each is Home Assistant's own Threshold helper: it is on while a reading is past its limit,
  // checked by Home Assistant all the time. The Portal alert label shows it in Alerts; Critical makes it red.
  // ponytail: a Threshold has no "for so many minutes"; a short spike counts. A Template helper with a delay does that, made in Home Assistant.
  class AlertRulesCard extends Base {
    build() {
      this.shadowRoot.innerHTML = `<style>${BASE}${AUTO_CSS}${SHEET_CSS}
.rl{all:unset;box-sizing:border-box;cursor:pointer;flex:1;min-width:0;display:flex;align-items:center;gap:10px;padding:7px 0}.rl:focus-visible{outline:2px solid var(--accent)}.rl i{width:10px;height:10px;border-radius:50%;background:var(--ok);flex:none}.rl i.warn{background:var(--warn)}.rl i.bad{background:var(--bad)}.rl i.off{background:var(--slate)}.rl span{min-width:0}.rl b{display:block;font-weight:500;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rl small{display:block;color:var(--muted);font-size:11.5px}
.now{font-size:12.5px;color:var(--muted)}
</style><div class="w"><div class="chead"><h2>Alert rules</h2><button class="gold" data-new="1">+ New</button></div><span class="muted" style="font-size:12.5px">A rule watches one reading and turns on while it is past the limit. It shows under Alerts.</span><div class="slist" id="list"></div>
<dialog id="dlg" aria-labelledby="dlgT"><div class="dh"><h3 id="dlgT"></h3><button class="x" data-cancel="1" aria-label="Close">×</button></div><div class="db" id="form"></div><div class="df" id="foot"></div></dialog></div>`;
      const r = this.shadowRoot, dlg = r.getElementById('dlg');
      r.querySelector('.w').addEventListener('click', (e) => this.onClick(e));
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); this._form = null; this.paintForm(); });
      dlg.addEventListener('click', (e) => { if (e.target === dlg) { this._form = null; this.paintForm(); } });
      r.getElementById('form').addEventListener('input', (e) => {
        const k = e.target.dataset.fld, f = this._form;
        if (!k || !f) return;
        f[k] = e.target.value;
        if (k === 'name') f.named = true;
        if (k === 'dev') f.sensor = this.readings(f.dev)[0]?.[1] || '';
        this.paintForm(k === 'name' || k === 'value');
      });
    }
    async refresh() { this.paint(); }
    // What can be watched: every device here that measures, and virtual devices through their Sum sensor.
    devices() { return DEVICES.filter((d) => (d.power && !d.link) || (d.virtual && TREE.sums?.[d.id]?.power?.entity)).sort(byName); }
    readings(id) {
      const d = DEVICES.find((x) => x.id === id);
      if (!d) return [];
      if (d.virtual) return [['Power', TREE.sums[d.id].power.entity, 'W']];
      return (d.readings || []).filter(([, e, u]) => e && ['W', 'V', 'A', '°C'].includes(u) && !/apparent/i.test(e));
    }
    rules() { return alarmRules().filter((x) => !x.place || placesUnder(currentLocation).has(x.place)); }
    labelId(name) { return LABELS.find((l) => cleanName(l.name).toLowerCase() === name)?.label_id; }
    // Home Assistant ties a Threshold to the device of the reading it watches and puts that device's name in front, so the rule's own name leaves it out.
    devName(sensor) { const e = this._hass.entities[sensor], d = e?.device_id && this._hass.devices[e.device_id]; return d ? d.name_by_user || d.name : ''; }
    ownName(name, sensor) { const dn = this.devName(sensor), n = name.trim(); return dn && n.startsWith(`${dn} `) ? n.slice(dn.length + 1) : n; }
    openForm(entity) {
      const st = this._hass.states;
      if (entity) {
        const a = st[entity]?.attributes || {}, src = a.entity_id, dev = DEVICES.find((d) => this.readings(d.id).some(([, e]) => e === src)), up = a.upper != null, lim = up ? a.upper : a.lower, unit = st[src]?.attributes?.unit_of_measurement;
        this._form = { entity, notify: null, named: true, name: this.ownName(a.friendly_name || '', src), dev: dev?.id || '', sensor: src, op: up ? 'above' : 'below', value: String(unit === 'W' ? lim / 1000 : lim), sev: (this._hass.entities[entity]?.labels || []).includes(this.labelId('critical')) ? 'critical' : 'warn', other: !('upper' in a) };
      } else {
        const d = this.devices()[0];
        this._form = { name: '', dev: d?.id || '', sensor: d ? this.readings(d.id)[0]?.[1] : '', op: 'above', value: '', sev: 'warn', notify: new Set(notifyTargets(this._hass).map(([k]) => k)) };
      }
      this.paintForm();
      // A rule being changed shows who it tells now, read from its automation. One that tells no one yet starts with HA notifications on.
      if (entity) {
        const automationEntity = `automation.${ruleAutoId(entity)}`;
        const read = portalCanManageHA()
          ? this._hass.callApi('GET', `config/automation/config/${ruleAutoId(entity)}`)
          : this._hass.callWS({ ...clientArg(), type: 'optim_energy/automation/get', entity_id: automationEntity }).then((r) => r.config);
        read.then((c) => ruleTargets(c), () => notifyTargets(this._hass).map(([k]) => k)).then((t) => { if (this._form?.entity === entity) { this._form.notify = new Set(t); this.paintForm(); } });
      }
    }
    // The name follows the choices until someone types their own.
    autoName(f) {
      const d = DEVICES.find((x) => x.id === f.dev), rd = this.readings(f.dev).find(([, e]) => e === f.sensor), unit = rd?.[2] === 'W' ? 'kW' : rd?.[2] || '';
      if (!d || !rd || f.value === '') return '';
      return this.devName(f.sensor) ? `${rd[0]} ${f.op} ${f.value} ${unit}` : `${d.name} ${rd[0].toLowerCase()} ${f.op} ${f.value} ${unit}`;
    }
    paintForm(soft) {
      const f = this._form, r = this.shadowRoot, dlg = r.getElementById('dlg'), box = r.getElementById('form');
      if (!f) { if (dlg.open) dlg.close(); return; }
      if (!f.named) f.name = this.autoName(f);
      const st = this._hass.states, rd = this.readings(f.dev).find(([, e]) => e === f.sensor), unit = rd?.[2] === 'W' ? 'kW' : rd?.[2] || '', raw = parseFloat(st[f.sensor]?.state);
      const now = Number.isFinite(raw) ? `It reads ${valueText(raw, rd?.[2] || '')} now.` : '';
      if (soft) { const n = r.querySelector('input.nm'); if (n && !f.named) n.value = f.name; return; }
      const seg = (name, list, cur, attr) => `<div class="seg" role="group" aria-label="${name}">${list.map(([k, n]) => `<button class="${cur === k ? 'on' : ''}" ${attr}="${k}" aria-pressed="${cur === k}">${n}</button>`).join('')}</div>`;
      r.getElementById('dlgT').textContent = f.entity ? 'Change alert rule' : 'New alert rule';
      box.innerHTML = `<div><div class="lab">Device</div><select class="gp" data-fld="dev">${this.devices().map((d) => `<option value="${d.id}"${d.id === f.dev ? ' selected' : ''}>${esc(d.name)}${d.place && d.place !== currentLocation ? ` · ${esc(placeById(d.place)?.name || '')}` : ''}</option>`).join('')}</select></div>
<div><div class="lab">Watch</div><select class="gp" data-fld="sensor">${this.readings(f.dev).map(([n, e]) => `<option value="${e}"${e === f.sensor ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></div>
<div><div class="lab"><span>Alert when it is</span><span class="now">${now}</span></div><div class="row">${seg('Above or below', [['above', 'Above'], ['below', 'Below']], f.op, 'data-op')}<div style="display:flex;gap:6px;align-items:center"><input class="tm" type="number" inputmode="decimal" step="any" data-fld="value" value="${esc(f.value)}" aria-label="Limit"><span class="muted">${esc(unit)}</span></div></div></div>
<div><div class="lab">Level</div>${seg('Level', [['warn', 'Warning'], ['critical', 'Critical']], f.sev, 'data-sev')}</div>
<div><div class="lab">Tell</div>${f.notify && !notifyTargets(this._hass).length ? '<span class="muted">Nothing to send to yet.</span>' : f.notify ? `<div class="devs" role="group" aria-label="Who to tell">${notifyTargets(this._hass).map(([k, n]) => `<button class="${f.notify.has(k) ? 'on' : ''}" data-tell="${k}" aria-pressed="${f.notify.has(k)}">${esc(n)}</button>`).join('')}</div>` : '<span class="muted">Loading…</span>'}</div>
<div><div class="lab">Name</div><input class="nm" data-fld="name" type="text" value="${esc(f.name)}" maxlength="80"></div><span class="err">${f.err || ''}</span>`;
      r.getElementById('foot').innerHTML = `${f.entity ? `<button class="del${f.confirm ? ' armed' : ''}" data-del="1"${f.busy ? ' disabled' : ''}>${f.confirm ? 'Tap again to delete' : 'Delete'}</button>` : ''}<span class="sp"></span><button data-cancel="1">Cancel</button><button class="gold" data-save="1"${f.busy ? ' disabled' : ''}>${f.busy ? 'Saving…' : 'Save'}</button>`;
      if (!dlg.open) dlg.showModal();
    }
    onClick(e) {
      const q = (a) => e.target.closest(a), f = this._form;
      let b;
      if (q('[data-new]')) { this.openForm(); return; }
      if ((b = q('[data-rule]'))) { this.openForm(b.dataset.rule); return; }
      if ((b = q('[data-ha-rule]'))) { navigate(`/config/entities?search=${encodeURIComponent(b.dataset.haRule)}`); return; }
      if (!f) return;
      if (q('[data-cancel]')) { this._form = null; this.paintForm(); return; }
      if ((b = q('[data-op]'))) { f.op = b.dataset.op; this.paintForm(); return; }
      if ((b = q('[data-sev]'))) { f.sev = b.dataset.sev; this.paintForm(); return; }
      if ((b = q('[data-tell]'))) { const k = b.dataset.tell; if (f.notify.has(k)) f.notify.delete(k); else f.notify.add(k); this.paintForm(); return; }
      if (q('[data-save]')) { this.save(); return; }
      if (q('[data-del]')) this.remove();
    }
    fail(t) { this._form.err = t; this._form.busy = false; this.paintForm(); }
    async entryOf(entity) { return portalCanManageHA() ? (await this._hass.callWS({ type: 'config/entity_registry/get', entity_id: entity })).config_entry_id : null; }
    async save() {
      const f = this._form, h = this._hass, d = DEVICES.find((x) => x.id === f.dev), rd = this.readings(f.dev).find(([, e]) => e === f.sensor), n = Number(f.value);
      if (!d || !rd) { this.fail('Choose a device and a reading.'); return; }
      if (f.value === '' || !Number.isFinite(n)) { this.fail('Enter the limit.'); return; }
      if (!f.name.trim()) { this.fail('Give it a name.'); return; }
      const name = this.ownName(f.name, f.sensor) || f.name.trim();
      const limit = rd[2] === 'W' ? n * 1000 : n, bound = f.op === 'above' ? { upper: limit } : { lower: limit };
      const alert = this.labelId('portal alert'), crit = this.labelId('critical');
      if (!alert) { this.fail('The Portal alert label is missing in Home Assistant.'); return; }
      f.busy = true; f.err = ''; this.paintForm();
      try {
        let entity = f.entity;
        const keep = (h.entities[entity]?.labels || []).filter((x) => x !== alert && x !== crit);
        const labels = [...keep, alert, ...(f.sev === 'critical' && crit ? [crit] : [])];
        const allowed = notifyTargets(h).map(([k]) => k), targets = [...(f.notify || [])].filter((k) => allowed.includes(k));
        const autoName = this.devName(f.sensor) ? `${this.devName(f.sensor)} ${name}` : name;
        if (!portalCanManageHA()) {
          const saved = await h.callWS({ ...clientArg(), type: 'optim_energy/helper/threshold/save', ...(f.entity ? { entity_id: f.entity } : {}), name, sensor: f.sensor, hysteresis: 0, ...bound, place: d.place || currentLocation, labels });
          entity = saved.entity_id;
          const id = ruleAutoId(entity);
          if (targets.length) await h.callWS({ ...clientArg(), type: 'optim_energy/automation/save_alert', rule_entity: entity, name: autoName, sensor: f.sensor, unit: rd[2], severity: f.sev, targets });
          else await h.callWS({ ...clientArg(), type: 'optim_energy/automation/delete', entity_id: `automation.${id}` }).catch(() => {});
          treeLoad = null; await ensureTree(h);
        } else {
          if (entity) {
            const fl = await h.callApi('POST', 'config/config_entries/options/flow', { handler: await this.entryOf(entity) });
            const r2 = await h.callApi('POST', `config/config_entries/options/flow/${fl.flow_id}`, { entity_id: f.sensor, hysteresis: 0, ...bound });
            if (r2.type !== 'create_entry') throw new Error('not changed');
          } else {
            const fl = await h.callApi('POST', 'config/config_entries/flow', { handler: 'threshold' });
            const r2 = await h.callApi('POST', `config/config_entries/flow/${fl.flow_id}`, { name, entity_id: f.sensor, hysteresis: 0, ...bound });
            if (r2.type !== 'create_entry') throw new Error('not created');
            for (let i = 0; i < 20 && !entity; i += 1) { await new Promise((res) => setTimeout(res, 300)); entity = (await h.callWS({ type: 'config/entity_registry/list' })).find((x) => x.config_entry_id === r2.result.entry_id)?.entity_id; }
            if (!entity) throw new Error('no entity');
          }
          // Where it shows: the device's group, or its location. And how it shows: the Portal alert label, Critical for red.
          await h.callWS({ type: 'config/entity_registry/update', entity_id: entity, name, area_id: placePath(d.place)[0]?.area_id || null, labels });
          const id = ruleAutoId(entity);
          if (targets.length) await h.callApi('POST', `config/automation/config/${id}`, ruleAutomation(entity, autoName, f.sensor, rd[2], f.sev, targets));
          else await h.callApi('DELETE', `config/automation/config/${id}`).catch(() => {});
        }
        this._form = null; this.paintForm();
        treeLoad = null; await ensureTree(h);
        showToast(this, 'Alert rule saved');
      } catch (err) { this.fail('Could not save. Try again.'); }
    }
    async remove() {
      const f = this._form;
      if (!f.confirm) { f.confirm = true; this.paintForm(); return; }
      f.busy = true; this.paintForm();
      try {
        const h = this._hass, id = ruleAutoId(f.entity);
        if (portalCanManageHA()) {
          await h.callApi('DELETE', `config/automation/config/${id}`).catch(() => {});
          await h.callService('persistent_notification', 'dismiss', { notification_id: id }).catch(() => {});
          await h.callApi('DELETE', `config/config_entries/entry/${await this.entryOf(f.entity)}`);
        } else {
          await h.callWS({ ...clientArg(), type: 'optim_energy/automation/delete', entity_id: `automation.${id}` }).catch(() => {});
          await h.callService('persistent_notification', 'dismiss', { notification_id: id }).catch(() => {});
          await h.callWS({ ...clientArg(), type: 'optim_energy/helper/delete', entity_id: f.entity });
          treeLoad = null; await ensureTree(h);
        }
        this._form = null; this.paintForm(); showToast(this, 'Alert rule deleted');
      } catch (err) { f.confirm = false; this.fail('Could not delete. Try again.'); }
    }
    paint() {
      const r = this.shadowRoot, st = this._hass.states, list = this.rules();
      const row = (x) => {
        const e = st[x.entity], a = e?.attributes || {}, thr = 'upper' in a, on = e?.state === 'on', unit = st[a.entity_id]?.attributes?.unit_of_measurement || '';
        const lim = a.upper ?? a.lower, what = thr ? `${a.upper != null ? 'Above' : 'Below'} ${valueText(lim, unit)} · now ${a.sensor_value == null ? '—' : valueText(a.sensor_value, unit)}` : 'Made in Home Assistant';
        return `<div class="sc"><button class="rl" ${thr ? `data-rule="${x.entity}"` : `data-ha-rule="${x.entity}"`}><i class="${!e || e.state === 'unavailable' ? 'off' : on ? (x.sev === 'critical' ? 'bad' : 'warn') : ''}"></i><span><b>${esc(x.name)}</b><small>${what} · ${x.sev === 'critical' ? 'Critical' : 'Warning'}${on ? ' · active now' : ''}</small></span></button></div>`;
      };
      r.getElementById('list').innerHTML = list.map(row).join('') || '<span class="muted">No alert rules yet.</span>';
    }
  }
  // Now, the last 7 days, and for admins the alarm rules. Three questions, one tab each.
  class AlertsCard extends Base {
    build() {
      this._openGroups = new Set();
      this._dirty = new Set();
      this._tab = 'now';
      this._form = null;
      this.shadowRoot.innerHTML = `<style>${BASE}${ALERT_CSS}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);overflow-x:auto}.tab{all:unset;cursor:pointer;padding:9px 14px;font-size:14px;color:var(--muted);border-bottom:2px solid transparent;white-space:nowrap}.tab.on{color:var(--fg);border-bottom-color:var(--accent)}.tab:focus-visible{outline:2px solid var(--accent)}
.pane{display:grid;gap:14px;min-width:0}.pane[hidden]{display:none}
.top{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center}
.box{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px;display:grid;gap:12px;min-width:0}
.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr));gap:10px;align-items:end}.fields label{display:grid;gap:4px;font-size:12.5px;color:var(--muted);min-width:0}.fields input,.fields select{width:100%;box-sizing:border-box;height:36px;min-width:0}.fields .wide{grid-column:span 2}@media(max-width:520px){.fields .wide{grid-column:auto}}
.val2{display:grid;grid-template-columns:minmax(0,1fr) 68px;gap:6px}
.say{font-size:14.5px}.say small{display:block;color:var(--muted);font-size:12.5px;margin-top:2px}
.acts{display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:flex-end}.acts.left{justify-content:flex-start}
.rl{all:unset;box-sizing:border-box;cursor:pointer;display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--line);min-width:0}.rl:first-child{border-top:0}.rl:focus-visible{outline:2px solid var(--accent)}.rl i{width:10px;height:10px;border-radius:50%;background:var(--slate);flex:none}.rl i.ok{background:var(--ok)}.rl i.warn{background:var(--warn)}.rl i.bad{background:var(--bad)}.rl span{min-width:0;flex:1}.rl b{display:block;font-weight:500;font-size:14px;overflow-wrap:anywhere}.rl small{display:block;color:var(--muted);font-size:12.5px}.rl em{font-style:normal;font-size:12.5px;color:var(--muted)}
.err{color:var(--bad);font-size:13px}.err:empty{display:none}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px;display:grid;gap:4px}
.panel[hidden]{display:none}
.pnote{margin:0 0 6px;color:var(--muted);font-size:13px}
.panel h3{padding-top:10px}
.set{display:grid;grid-template-columns:minmax(190px,1.6fr) 96px 190px 170px;gap:6px 14px;align-items:center;padding:11px 0;border-top:1px solid var(--line)}
.set.hl{background:color-mix(in srgb,var(--accent) 10%,transparent);box-shadow:0 0 0 6px color-mix(in srgb,var(--accent) 10%,transparent)}
@media(max-width:700px){.set{grid-template-columns:1fr}}
.set b{font-weight:500;font-size:14px;display:block}.set small{color:var(--muted);font-size:12.5px}
.onoff{display:inline-flex;gap:7px;align-items:center;font-size:13.5px;cursor:pointer}.onoff input{accent-color:var(--accent);width:16px;height:16px}
.lim{display:grid;gap:3px}.lim div{display:flex;gap:6px;align-items:center}.lim input{width:84px}.lim small{white-space:nowrap}
button:disabled{opacity:.45;cursor:default}
.chips2{display:flex;flex-wrap:wrap;gap:6px}.chips2 button{border-radius:16px;padding:6px 12px;font-size:13px}.chips2 button.on{background:var(--accent);color:#fff}.ntf{display:grid;gap:10px}.ntf .hd{display:flex;align-items:center;justify-content:space-between;gap:8px}
.msg{grid-column:1/-1;font-size:12.5px;min-height:0}.msg:empty{display:none}.msg.err{color:var(--bad)}.msg.warn{color:var(--warn)}.msg.ok{color:var(--ok)}
</style><div class="w"><div class="tabs" id="tabs" role="tablist"></div><div class="pane" id="now"><span class="muted">Loading…</span></div><div class="pane" id="history" hidden></div><div class="pane" id="runs" hidden></div></div>`;
      const r = this.shadowRoot, w = r.querySelector('.w');
      w.addEventListener('toggle', (e) => { const g = e.target.dataset?.group; if (g) { if (e.target.open) this._openGroups.add(g); else this._openGroups.delete(g); } }, true);
      r.getElementById('tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) this.show(b.dataset.tab); });
      // Only an admin can open a device's page in Home Assistant.
      for (const k of ['now', 'history']) r.getElementById(k).addEventListener('click', (e) => { const b = e.target.closest('[data-config]'); if (b && portalCanManageHA()) navigate(`/config/devices/device/${b.dataset.config.split(':')[0]}`); });
      this.startTimer();
    }
    show(tab) {
      this._tab = tab;
      this.paint();
    }
    // What each automation did: when it ran, and which devices it switched.
    paintRuns() {
      const box = this.shadowRoot.getElementById('runs'), st = this._hass.states, autos = automationsIn(resolveSpace());
      if (this._runs === undefined) { box.innerHTML = '<span class="muted">Loading…</span>'; return; }
      if (this._runs === null) { box.innerHTML = '<span class="muted">Could not load the automation history.</span>'; return; }
      const nameOf = (id) => DEVICES.find((d) => d.switch === id)?.name || st[id]?.attributes?.friendly_name || id;
      const rows = this._runs.map((x, i) => {
        const a = autos.find((y) => y.entity === x.entity) || { entity: x.entity, name: st[x.entity]?.attributes?.friendly_name };
        const by = x.changed.reduce((m, c) => { (m[c.state] = m[c.state] || []).push(nameOf(c.entity)); return m; }, {});
        const did = Object.entries(by).map(([s, n]) => `turned ${s} ${n.length}`).join(', ') || 'nothing needed switching';
        return `<details class="ar" data-group="run:${i}"${this._openGroups.has(`run:${i}`) ? ' open' : ''}><summary><i></i><span><b>${esc(autoTitle(a))}</b><small>Ran ${whenShort(x.at)} · ${did}</small></span></summary><div class="more">${Object.entries(by).map(([s, n]) => `<span>Turned ${s}: ${n.map(esc).join(', ')}</span>`).join('') || '<span>Every device was already as it should be.</span>'}</div></details>`;
      }).join('');
      box.innerHTML = rows ? `<div class="astack">${rows}</div>` : '<span class="muted">No automation ran in the last 7 days.</span>';
    }
    async refresh() {
      fetchRuns(this._hass).then((x) => { this._runs = x; if (this._tab === 'runs') this.paintRuns(); }).catch(() => { this._runs = null; if (this._tab === 'runs') this.paintRuns(); });
      try { this._data = await fetchAlerts(this._hass); this._failed = false; } catch (e) { this._failed = true; this._data = this._data || { net: [], meters: {} }; }
      this.paint();
    }
    paint() {
      const r = this.shadowRoot, admin = portalCanManage(), active = computeActive(this._hass.states, Date.now()).filter((a) => a.sev !== 'info').length;
      const tabs = [['now', active ? `Now (${active})` : 'Now'], ['history', 'Last 7 days'], ['runs', 'Automations']];
      const bar = tabs.map(([k, n]) => `<button class="tab${this._tab === k ? ' on' : ''}" role="tab" aria-selected="${this._tab === k}" data-tab="${k}">${n}</button>`).join('');
      if (r.getElementById('tabs').innerHTML !== bar) r.getElementById('tabs').innerHTML = bar;
      for (const k of ['now', 'history', 'runs']) r.getElementById(k).hidden = this._tab !== k;
      if (this._tab === 'runs') this.paintRuns();
      if (!this._data) return;
      const net = Boolean(networkPlace());
      const loadNote = this._failed ? '<span class="muted">History could not load.</span>' : '';
      if (this._tab === 'now') r.getElementById('now').innerHTML = loadNote + alertsHtml(this._data, this._hass.states, Date.now(), this._hass.config.time_zone, () => true, this._openGroups, net, 'now');
      if (this._tab === 'history') r.getElementById('history').innerHTML = loadNote + alertsHtml(this._data, this._hass.states, Date.now(), this._hass.config.time_zone, () => true, this._openGroups, net, 'history');
      if (!admin) r.querySelectorAll('.cfg').forEach((b) => b.remove());
    }
  }

  const reg = (n, c, title) => { if (!customElements.get(n)) customElements.define(n, c); window.customCards = window.customCards || []; window.customCards.push({ type: n, name: title }); };
  reg('building-devices-card', DevicesCard, 'Building devices');
  reg('building-spaces-card', SpacesCard, 'Groups');
  class DeviceMapCard extends Base {
    build() {
      this._confirm = null;
      this.shadowRoot.innerHTML = `<style>${BASE}
.intro{display:grid;gap:4px}.warn{color:var(--warn);font-size:13px}.err{color:var(--bad);font-size:13px}
.addg{padding-top:8px;flex-wrap:nowrap}.addg input{flex:1 1 auto;width:0}.addg button{flex:none}.hint{font-size:12px}
ul.gtree,ul.gtree ul{list-style:none;margin:0;padding:0;display:grid;gap:5px}ul.gtree ul{margin-top:5px;padding-left:18px}ul.gtree ul>li{position:relative}
ul.gtree ul>li::before{content:"";position:absolute;left:-11px;top:-5px;bottom:0;border-left:1px solid var(--muted)}ul.gtree ul>li:last-child::before{bottom:auto;height:28px}ul.gtree ul>li::after{content:"";position:absolute;left:-11px;top:23px;width:10px;border-top:1px solid var(--muted)}
.gr{position:relative}.gr .f{width:100%}.gr .f>span:last-child{grid-column:1/-1;padding-right:84px;min-width:0}.cnt{all:unset;position:absolute;right:12px;bottom:8px;cursor:pointer;font-size:12.5px;color:var(--accent);white-space:nowrap}.cnt:hover{text-decoration:underline}.cnt:focus-visible{outline:2px solid var(--accent)}
.add{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
ul.tree,ul.tree ul{list-style:none;margin:0;padding:0;display:grid;gap:6px}
ul.tree ul{margin-top:6px;padding-left:22px}
ul.tree ul>li{position:relative}
ul.tree ul>li::before{content:"";position:absolute;left:-14px;top:-6px;bottom:0;border-left:1px solid var(--muted)}
ul.tree ul>li:last-child::before{bottom:auto;height:26px}
ul.tree ul>li::after{content:"";position:absolute;left:-14px;top:20px;width:12px;border-top:1px solid var(--muted)}
.node{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:9px 12px;display:grid;grid-template-columns:minmax(170px,1fr) repeat(3,88px);gap:4px 10px;align-items:center}
.node.main{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
.node.hl{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 55%,transparent);background:color-mix(in srgb,var(--accent) 12%,var(--panel))}
.node.virtual{border-style:dashed}
.node.um{background:transparent;border-style:dotted;color:var(--muted)}.node.um.bad{color:var(--warn)}
.who{display:grid;gap:2px;min-width:0}.who b,.who .open{font-weight:500;font-size:14px;overflow-wrap:anywhere}.who .open{all:unset;font-weight:500;font-size:14px;cursor:pointer}.who .open:hover{color:var(--accent)}.who .open:focus-visible{outline:2px solid var(--accent)}.fold{all:unset;cursor:pointer;display:inline-block;width:18px;text-align:center;color:var(--muted)}.fold:hover{color:var(--fg)}.fold:focus-visible{outline:2px solid var(--accent)}.who small{color:var(--muted);font-size:12px}
.val{text-align:right;font-size:13.5px}.val small{display:block;color:var(--muted);font-size:11px}
.ctl{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:12.5px;color:var(--muted);border-top:1px solid var(--line);padding-top:7px;margin-top:3px}
.ctl select,.ctl button,.who input{font-size:12.5px;padding:4px 7px}
.ctl details{flex:1 1 100%}.ctl summary{cursor:pointer;color:var(--fg)}.unders{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,220px),1fr));gap:4px 12px;padding:8px 0 2px}.unders label{display:flex;gap:7px;align-items:center;color:var(--fg);font-size:13px}.unders input{accent-color:var(--accent);width:16px;height:16px;flex:none}.unders small{color:var(--muted)}.who input{width:min(240px,100%)}
@media(max-width:620px){.node{grid-template-columns:repeat(3,minmax(0,1fr))}.who{grid-column:1/-1}.val{text-align:left}}
</style><div class="w"><div class="intro"><span class="muted" id="sum"></span><span class="warn" id="warn"></span><span class="err" id="err"></span></div><div class="add" id="add"></div><ul class="tree" id="tree"></ul></div>`;
      const r = this.shadowRoot;
      r.getElementById('add').addEventListener('click', (e) => { if (e.target.closest('[data-wiring]')) { navigate('/energy-setup/devices'); return; } const all = e.target.closest('[data-fold-all]'); if (all) { this._shut = new Set(all.dataset.foldAll === 'shut' ? treeNodes().filter((d) => childrenOf(d.id).length).map((d) => d.id) : []); this.paint(); return; } if (e.target.closest('[data-new]')) { const i = r.getElementById('vname'), name = i.value.trim(); if (name) { const id = `virt:${Date.now().toString(36)}`; this._openUnder = id; this.commit(treeWithDevicePlaced(treeWithVirtual(TREE, name, id), id, currentLocation), `${name} added. Tick the devices under it.`); } } });
      r.getElementById('tree').addEventListener('click', (e) => this.onClick(e));
      r.getElementById('tree').addEventListener('toggle', (e) => { const id = e.target.dataset?.underBox; if (id) this._openUnder = e.target.open ? id : this._openUnder === id ? null : this._openUnder; }, true);
      r.getElementById('tree').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.dataset.rename) e.target.blur(); });
      r.getElementById('tree').addEventListener('focusout', () => { if (this._hl) { this._hl = null; setTimeout(() => this.paint(), 300); } });
      r.getElementById('tree').addEventListener('change', (e) => {
        const t = e.target;
        if (t.dataset.under) { const [up, id] = t.dataset.under.split('|'), dev = nodeById(id); this._openUnder = up; this.commit(treeWithParent(TREE, id, t.checked ? up : null), `${dev?.name || 'Device'} ${t.checked ? `is now under ${nodeById(up)?.name}` : 'is no longer under it'}`); }
        if (t.dataset.rename) this._hl = null;
        if (t.dataset.rename && t.value.trim()) {
          if (TREE.virtual.some((v) => v.id === t.dataset.rename)) this.commit({ ...TREE, virtual: TREE.virtual.map((v) => (v.id === t.dataset.rename ? { ...v, name: t.value.trim() } : v)) });
          else (portalCanManageHA()
            ? this._hass.callWS({ type: 'config/device_registry/update', device_id: t.dataset.rename, name_by_user: t.value.trim() })
            : this._hass.callWS({ ...clientArg(), type: 'optim_energy/device/update', device_id: t.dataset.rename, name: t.value.trim() })).catch(() => { r.getElementById('err').textContent = 'Could not rename the device. Try again.'; });
        }
      });
      this.startTimer();
    }
    startTimer() { this._t = setInterval(() => this.refresh(), 60000); }
    connectedCallback() { super.connectedCallback(); if (this._built && wiringFocus) this.paint(); }
    onClick(e) {
      const q = (a) => e.target.closest(a);
      let b;
      if ((b = q('[data-fold]'))) { const id = b.dataset.fold; if (this._shut.has(id)) this._shut.delete(id); else this._shut.add(id); this.paint(); return; }
      if ((b = q('[data-report]'))) { goToReport(b.dataset.report); return; }
      if ((b = q('[data-main]'))) { this.commit(treeWithMain(TREE, b.dataset.main)); return; }
      if (q('[data-unmain]')) { this.commit({ ...TREE, main: null }); return; }
      if ((b = q('[data-del]'))) {
        if (this._confirm === b.dataset.del) { this._confirm = null; this.commit(treeWithoutVirtual(TREE, b.dataset.del)); } else { this._confirm = b.dataset.del; this.paint(); }
      }
    }
    commit(next, label) { return commitTree(this, next, label); }
    async refresh() {
      try { this._totals = await portalTotals(this._hass); } catch (e) { /* keeps the last figures */ }
      if (this._c?.manage) syncSums(this._hass);
      this.paint();
    }
    paint() {
      const r = this.shadowRoot, active = r.activeElement;
      if (active && (active.tagName === 'SELECT' || (active.tagName === 'INPUT' && active.type !== 'checkbox'))) return;
      const st = this._hass.states, now = Date.now(), admin = this._c?.manage && portalCanWire(), canName = portalCanManage(), t = this._totals, main = mainDevice();
      const tops = topNodes(), others = main ? tops.filter((d) => d.id !== main.id) : tops;
      const energy = (key) => { const out = new Map(); const flat = (n) => { out.set(n.id, n); n.kids.forEach(flat); }; if (t) tops.forEach((d) => flat(nodeEnergy(d.id, (id) => t.devices[id]?.[key] ?? null, t.stale))); return out; };
      const today = energy('today'), month = energy('month');
      const kwh = (n) => (!n || n.kwh == null ? '—' : `${n.kwh.toFixed(2)} kWh`), val = (label, v) => `<div class="val"><small>${label}</small>${v}</div>`;
      const left = (n) => (!n || n.unmeasured == null ? 'Partial' : `${n.unmeasured.toFixed(2)} kWh`);
      if (!this._shut) { const set = new Set(), mark = (d, depth) => { if (depth >= 2 && childrenOf(d.id).length) set.add(d.id); childrenOf(d.id).forEach((c) => mark(c, depth + 1)); }; tops.forEach((d) => mark(d, 0)); this._shut = set; }
      let focusNow = false;
      if (this._c?.manage && wiringFocus && nodeById(wiringFocus)) { this._hl = wiringFocus; wiringFocus = null; focusNow = true; ancestorsOf(this._hl).forEach((id) => this._shut.delete(id)); }
      const under = (id) => childrenOf(id).reduce((n, c) => n + 1 + under(c.id), 0);
      const row = (d) => {
        const kids = childrenOf(d.id), parts = readingsOf(d.id), live = liveReadings(parts, st, now), s = deviceStatus(d, st, now), isMain = TREE.main === d.id, a = today.get(d.id), m = month.get(d.id);
        const fresh = TREE.known && !TREE.known.includes(d.id);
        // Any device can go under this one, except the main device and anything this one is already under.
        const pick = treeNodes().filter((x) => x.id !== d.id && TREE.main !== x.id && !wouldLoop(x.id, d.id)).sort((x, y) => (parentOf(y.id) === d.id) - (parentOf(x.id) === d.id) || byName(x, y));
        const box = pick.map((x) => { const p = parentOf(x.id), on = p === d.id; return `<label><input type="checkbox" data-under="${d.id}|${x.id}"${on ? ' checked' : ''}><span>${esc(x.name)}${!on && p ? ` <small>now under ${esc(nodeById(p)?.name || '')}</small>` : ''}</span></label>`; }).join('');
        const sum = d.virtual && TREE.sums?.[d.id], helpers = sum ? ['energy', 'power'].map((k) => sum[k]?.entity).filter(Boolean) : [];
        const ctl = admin ? `<div class="ctl"><details${this._openUnder === d.id ? ' open' : ''} data-under-box="${d.id}"><summary>Devices under it (${kids.length})${d.virtual ? ' · it adds them up' : ''}</summary><div class="unders">${box || '<span class="muted">No other devices here.</span>'}</div></details>${helpers.length ? `<span>In Home Assistant: ${helpers.map(esc).join(', ')}</span>` : ''}${d.virtual ? `<button data-del="${d.id}">${this._confirm === d.id ? 'Confirm delete' : 'Delete'}</button>` : ''}${parts.length ? `<button data-report="${d.report}">Open report</button>` : ''}</div>` : '';
        const title = canName ? `<input data-rename="${d.id}" value="${esc(d.name)}" aria-label="Name of ${esc(d.name)}">` : !admin && parts.length ? `<button class="open" data-report="${d.report}" title="Open report">${esc(d.name)}</button>` : `<b>${esc(d.name)}</b>`;
        const tags = `${isMain ? '<span class="demo">Main</span>' : ''}${d.virtual ? '<span class="demo">Virtual</span>' : ''}${fresh ? '<span class="demo">New</span>' : ''}`;
        const partial = a?.partial ? ` · ${a.reporting} of ${kids.length} devices sending data` : '';
        const leftover = !d.virtual && kids.length ? `<li><div class="node um${a?.over || m?.over ? ' bad' : ''}"><div class="who"><b>Unmeasured</b><small>${a?.over || m?.over ? 'The devices under it add up to more than it. Check the wiring.' : `Energy of ${d.name} that no device under it measured`}</small></div><div class="val"></div>${val('Today', left(a))}${val('This month', left(m))}</div></li>` : '';
        const shut = this._shut.has(d.id), sub = !shut && (kids.length || leftover) ? `<ul>${kids.map(row).join('')}${leftover}</ul>` : '';
        const fold = kids.length ? `<button class="fold" data-fold="${d.id}" aria-expanded="${!shut}" aria-label="${shut ? 'Show' : 'Hide'} devices under ${esc(d.name)}">${shut ? '▸' : '▾'}</button>` : '';
        return `<li><div class="node${isMain ? ' main' : ''}${d.virtual ? ' virtual' : ''}${this._hl === d.id ? ' hl' : ''}"><div class="who"><div>${fold}${title}${tags}</div><small><span class="pill ${s.key}">${s.label}</span>${d.place ? ` · ${esc(placeLabel(d.place))}` : ''}${partial}${shut ? ` · ${under(d.id)} under it` : ''}</small></div>${val('Now', parts.length ? (live.power == null ? 'No reading' : fmtPower({ state: String(live.power) })) : '—')}${val('Today', kwh(a))}${val('This month', kwh(m))}${ctl}</div>${sub}</li>`;
      };
      r.getElementById('sum').textContent = main ? `Main device: ${main.name}` : 'No main device set';
      r.getElementById('warn').textContent = main && others.length ? `Not counted: ${others.map((d) => d.name).join(', ')}.` : '';
      r.getElementById('add').innerHTML = `${admin ? '<input id="vname" type="text" placeholder="Name of virtual device" aria-label="Name of virtual device"><button class="gold" data-new="1">Add virtual device</button><span class="muted">It adds up the devices you tick under it, and appears in Home Assistant as a Sum helper for energy and power.</span>' : portalCanWire() ? '<button data-wiring="1">Change the wiring</button>' : ''}<button data-fold-all="open">Expand all</button><button data-fold-all="shut">Collapse all</button>`;
      r.getElementById('tree').innerHTML = [...(main ? [main] : []), ...others].map(row).join('') || '<li class="muted">No devices in this location yet. An administrator adds them under Setup.</li>';
      if (focusNow) { const i = r.querySelector(`input[data-rename="${CSS.escape(this._hl)}"]`); if (i) { i.focus({ preventScroll: true }); i.select(); setTimeout(() => i.scrollIntoView({ block: 'center' }), 500); } }
    }
  }
  // The global default panel must stay visible to every account, so it is a
  // neutral landing card rather than Administration or Locations.
  class PortalStartCard extends Base {
    get noBar() { return true; }
    build() {
      this.shadowRoot.innerHTML = `<style>${BASE}.opening{display:grid;place-items:center;min-height:220px;color:var(--muted);font-size:14px}</style><div class="w"><div class="opening">Opening Optim Energy…</div></div>`;
    }
    async refresh() {
      await ensureTree(this._hass);
      if (!PORTAL.ready) return;
      if (PORTAL.isRoot) { navigate(ADMIN_HOME_PATH); return; }
      const assigned = PORTAL.locations || [];
      if (PORTAL.role === 'user' && assigned.length <= 1) {
        const only = assigned[0] || TREE.places.find((p) => p.kind === 'location')?.id || null;
        if (only) { setLocation(only); navigate(HOME_PATH); return; }
      }
      navigate(START_PATH);
    }
  }
  // The way in: choose a location, and everything after it shows only that location.
  class LocationPickerCard extends Base {
    get noBar() { return true; }
    async refresh() { this.paint(); }
    build() {
      this.shadowRoot.innerHTML = `<style>${BASE}
.locs{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr));gap:12px}
.loc{all:unset;box-sizing:border-box;cursor:pointer;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:16px 18px;display:grid;gap:4px}.loc:hover{border-color:var(--muted)}.loc:focus-visible{outline:2px solid var(--accent)}.loc.on{border-color:var(--accent)}
.loc b{font-weight:650;letter-spacing:-.02em;font-size:24px;line-height:1.2;overflow-wrap:anywhere}.loc span{font-size:13px;color:var(--muted)}
.add{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.err{color:var(--bad);font-size:13px}.clientpick{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px;font-size:13px;color:var(--muted)}.clientpick select{min-width:220px;max-width:100%}
.addg{padding-top:8px;flex-wrap:nowrap}.addg input{flex:1 1 auto;width:0}.addg button{flex:none}.hint{font-size:12px}
ul.gtree,ul.gtree ul{list-style:none;margin:0;padding:0;display:grid;gap:5px}ul.gtree ul{margin-top:5px;padding-left:18px}ul.gtree ul>li{position:relative}
ul.gtree ul>li::before{content:"";position:absolute;left:-11px;top:-5px;bottom:0;border-left:1px solid var(--muted)}ul.gtree ul>li:last-child::before{bottom:auto;height:28px}ul.gtree ul>li::after{content:"";position:absolute;left:-11px;top:23px;width:10px;border-top:1px solid var(--muted)}
.gr{position:relative}.gr .f{width:100%}.gr .f>span:last-child{grid-column:1/-1;padding-right:84px;min-width:0}.cnt{all:unset;position:absolute;right:12px;bottom:8px;cursor:pointer;font-size:12.5px;color:var(--accent);white-space:nowrap}.cnt:hover{text-decoration:underline}.cnt:focus-visible{outline:2px solid var(--accent)}
</style><div class="w"><h2>Choose a location</h2><div id="client"></div><div class="locs" id="locs"></div><div class="add" id="add"></div><span class="err" id="err"></span><span class="muted" id="free"></span></div>`;
      const r = this.shadowRoot;
      r.getElementById('locs').addEventListener('click', (e) => { const b = e.target.closest('[data-loc]'); if (b) { setLocation(b.dataset.loc); announceTree(); navigate(HOME_PATH); } });
      r.getElementById('client').addEventListener('change', (e) => { if (e.target.id === 'clientSwitch') switchPortalClient(this._hass, e.target.value); });
    }
    paint() {
      const r = this.shadowRoot, active = r.activeElement;
      if (active && ['INPUT', 'SELECT'].includes(active.tagName)) return;
      if (!PORTAL.isRoot && PORTAL.role === 'user' && (PORTAL.locations || []).length <= 1) {
        const only = (PORTAL.locations || [])[0] || TREE.places.find((p) => p.kind === 'location')?.id || null;
        if (only) setLocation(only);
        navigate(HOME_PATH);
        return;
      }
      const admin = portalCanManage(), list = TREE.places.filter((p) => p.kind === 'location').sort(byName), real = allNodes.filter((d) => !d.virtual);
      const clients = PORTAL.clients || [];
      r.getElementById('client').innerHTML = PORTAL.isRoot && clients.length ? `<label class="clientpick"><span>Tenant</span><select id="clientSwitch" aria-label="Tenant">${clients.map((c) => `<option value="${esc(c.id)}"${c.id === portalClient ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>` : PORTAL.clientName ? `<div class="clientpick"><span>Tenant · ${esc(PORTAL.clientName)}</span></div>` : '';
      r.getElementById('locs').innerHTML = list.map((p) => { const under = placesUnder(p.id), n = real.filter((d) => under.has(d.place)).length, g = under.size - 1; return `<button class="loc${p.id === currentLocation ? ' on' : ''}" data-loc="${p.id}"><b>${esc(p.name)}</b><span>${n} ${n === 1 ? 'device' : 'devices'} · ${g} ${g === 1 ? 'group' : 'groups'}${p.id === currentLocation ? ' · Open now' : ''}</span></button>`; }).join('') || '<span class="muted">No locations yet.</span>';
      r.getElementById('err').textContent = PORTAL.error || '';
      const free = real.filter((d) => !d.place).length;
      r.getElementById('free').textContent = admin && free ? `${free} ${free === 1 ? 'device is' : 'devices are'} not in a location yet. An administrator assigns them under Administration.` : '';
    }
  }
  // Adds new devices and registers them to a location, without going through Home Assistant's settings.
  // Home: the location as one thing. How much now, today and this month, then the same as charts, split by device only when asked.
  class HomeCard extends Base {
    build() {
      this._modes = {};
      this.shadowRoot.innerHTML = `<style>${BASE}${CHART_CSS}
#status:empty{display:none}.kpi .tip b{font-size:12px;font-weight:600;letter-spacing:0}.kpi .tip span,.kpi .key span{font-size:12px}.kpi .tip div span:last-child{color:var(--fg)}.status{display:flex;align-items:center;gap:8px;min-height:36px;padding:0 12px;border-radius:10px;font-size:13px;font-weight:600;background:color-mix(in srgb,var(--warn) 14%,var(--panel))}.status i{width:8px;height:8px;border-radius:50%;background:var(--warn);flex:none}
.kpi.al b{display:flex;align-items:center;gap:6px;min-height:26px}.kpi.al svg{width:24px;height:24px;fill:var(--ok);flex:none}.kpi.al.on svg{fill:var(--bad)}
.toplist{display:grid;gap:9px}.tu{all:unset;box-sizing:border-box;cursor:pointer;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 10px;font-size:13.5px}.tu:hover{color:var(--accent)}.tu:focus-visible{outline:2px solid var(--accent)}.tu span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tu .b{grid-column:1/-1;height:6px;border-radius:3px;background:var(--track);overflow:hidden}.tu .b i{display:block;height:100%;border-radius:3px;background:var(--accent)}
.top{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}
.now{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px;display:grid;gap:6px;align-content:start;min-width:0}.now>span{font-size:13px;color:var(--muted)}.now>b{font-weight:650;letter-spacing:-.02em;font-size:clamp(34px,4vw,44px);line-height:1.1}.now small{color:var(--muted);font-size:12.5px}
.rows{display:grid;margin-top:4px;border-top:1px solid var(--line);padding-top:6px}.r{all:unset;box-sizing:border-box;display:flex;justify-content:space-between;gap:10px;font-size:13.5px;padding:3px 0;cursor:pointer;min-width:0}.r:hover{color:var(--accent)}.r:focus-visible{outline:2px solid var(--accent)}.r span:first-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}.r span:last-child{white-space:nowrap}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:8px;align-content:start}.kpi{all:unset;box-sizing:border-box;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:8px 11px;display:grid;gap:1px;align-content:start;min-width:0}button.kpi{cursor:pointer}button.kpi:hover{border-color:var(--muted)}button.kpi:focus-visible{outline:2px solid var(--accent)}.kpi span{font-size:12.5px;color:var(--muted)}.kpi b{font-weight:650;letter-spacing:-.02em;font-size:18px;line-height:1.25;white-space:nowrap}.kpi small{color:var(--muted);font-size:12px}.kpi.warn{border-color:var(--warn)}.kpi.bad{border-color:var(--bad)}.kpi.ok{border-color:var(--ok)}
.charts{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;min-width:0}.charts.wide{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
</style><div class="w"><div id="status"></div><div class="top" id="top"></div><div class="charts" id="charts"></div></div>`;
      const r = this.shadowRoot, c = r.getElementById('charts');
      r.querySelector('.w').addEventListener('click', (e) => {
        const q = (a) => e.target.closest(a);
        let b;
        if ((b = q('[data-chart]'))) { this._modes[b.dataset.chart] = b.dataset.mode; this.paint(); return; }
        if ((b = q('[data-report]'))) { goToReport(b.dataset.report); return; }
        if ((b = q('[data-nav]'))) navigate(b.dataset.nav);
      });
      chartTips(c, (v) => { this._hover = v; });
      chartTips(r.getElementById('top'), (v) => { this._hover = v; });
      new ResizeObserver(() => { if (this._w !== c.clientWidth) { this._w = c.clientWidth; if (this._hass) this.paint(); } }).observe(c);
      this.startTimer();
    }
    startTimer() { this._t = setInterval(() => this.refresh(), 60000); }
    async refresh() {
      if (!PORTAL.treeReady) return;
      const h = this._hass, now = Date.now(), tz = h.config.time_zone, meters = homeDevices().filter((d) => d.energy);
      loadPriceMemory(h);
      // Another tenant or location than last time: what was shown is not this one's.
      const key = `${portalClient}|${currentLocation}`;
      if (this._key !== key) { this._key = key; this._loaded = false; this._parts = null; this._totals = null; this._failed = false; this.paint(); }
      if (!meters.length) { this._parts = []; this._loaded = true; this.paint(); return; }
      const mine = () => this._key === key;
      try {
        const ids = meters.map((d) => d.energy);
        const [st, raw, totals] = await Promise.all([
          statsWS(h, { type: 'recorder/statistics_during_period', start_time: new Date(now - 9 * 86400000).toISOString(), statistic_ids: ids, period: 'hour', types: ['change', 'state'] }),
          h.callWS({ type: 'history/history_during_period', start_time: new Date(now - (now % HOUR_MS)).toISOString(), end_time: new Date(now).toISOString(), entity_ids: ids, minimal_response: true, no_attributes: true, significant_changes_only: false }),
          portalTotals(h).catch(() => null),
        ]);
        if (!mine()) return;
        this._parts = meters.map((d) => ({ name: d.name, b: withLiveHour(bucketEnergy(st[d.energy] || [], parseFloat(h.states[d.energy]?.state), now, tz), hourSoFar(historyPts(raw, d.energy))) }));
        this._totals = totals;
        this._failed = !totals;
      } catch (e) { if (!mine()) return; this._failed = true; /* keeps the last figures, and says so */ }
      this._loaded = true;
      this.paint();
    }
    paint() {
      if (this._hover) return;
      const r = this.shadowRoot, h = this._hass, st = h.states, now = Date.now(), n = nowPanel(st, now), t = this._totals, tariff = t?.tariff ?? priceOf(h);
      const c = r.getElementById('charts'), W = c.clientWidth || 640, wide = W >= 900;
      const act = computeActive(st, now).filter((a) => a.sev !== 'info');
      if (!DEVICES.some(isMeasuring)) { r.getElementById('top').innerHTML = `<div class="now"><span>No devices in this location yet.</span>${portalCanManageHA() ? '<button data-nav="/config/areas/dashboard">Give devices an area in Home Assistant ›</button>' : ''}</div>`; c.innerHTML = ''; return; }
      if (!this._loaded) { r.getElementById('status').innerHTML = ''; r.getElementById('top').innerHTML = '<span class="sk" style="height:132px" role="status" aria-label="Loading"></span>'; c.innerHTML = '<span class="sk" style="height:240px"></span>'; return; }
      const several = homeDevices().length > 1;
      const kpi = (label, value, sub) => `<div class="kpi"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
      const rule = priceRule(h), vat = vatNote(rule), money = (eur) => `€ ${eur.toFixed(2)} ${vat}`, pr = chartPrice(t, tariff);
      r.getElementById('status').innerHTML = this._failed ? '<div class="status"><i></i>Some figures could not load</div>' : '';
      const alarms = `<button class="kpi al ${act.length ? 'on' : ''}" data-nav="/energy-alerts/alerts" aria-label="${act.length || 'No'} active alert${act.length === 1 ? '' : 's'}"><span>Alerts</span><b>${BELL_SVG}${act.length || ''}</b></button>`;
      // What uses the most today, from each top-level device's own total.
      const shareOf = (d) => readingsOf(d.id).reduce((s, x) => s + (t?.devices?.[x.id]?.today || 0), 0);
      const ranked = n.tops.map(nodeById).filter(Boolean).map((d) => ({ d, kwh: shareOf(d) })).filter((x) => x.kwh > 0).sort((a, b) => b.kwh - a.kwh), sum = ranked.reduce((s, x) => s + x.kwh, 0);
      const usage = ranked.slice(0, 6).map(({ d, kwh }) => `<button class="tu" data-report="${d.report}" title="Open report"><span>${esc(d.name)}</span><span>${kwh.toFixed(1)} kWh · ${Math.round(kwh / sum * 100)}%</span><span class="b"><i style="width:${Math.round(kwh / ranked[0].kwh * 100)}%"></i></span></button>`).join('');
      const since = t?.firstRow && fmtDay(t.firstRow, h) > `${fmtDay(now, h).slice(0, 7)}-01` && fmtDay(t.firstRow, h).startsWith(fmtDay(now, h).slice(0, 7)) ? `since ${new Date(t.firstRow).toLocaleString('en-GB', { timeZone: h.config.time_zone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}<br>` : '';
      // The price now: the location's price with margin, fees and VAT, and how it stands against the rest of today.
      const pnow = rule.now, dayAvg = priceDayAverage(h, now), diff = dayAvg ? Math.round((pnow / dayAvg - 1) * 100) : null;
      const priceSub = `${vat} · ${rule.missing ? 'No exchange price, helper used' : rule.mode === 'exchange' ? (diff == null ? 'Exchange price' : diff === 0 ? "Today's average" : `${Math.abs(diff)}% ${diff > 0 ? 'above' : 'below'} today's average`) : rule.mode === 'fixed' ? 'Custom fixed price' : rule.mode === 'bill' ? 'Bill price' : 'Price helper'}${rule.mode === 'exchange' || rule.missing ? `<br>${priceStatusChip(h)}` : ''}`;
      // Today first, then the moment: power and price now; then the month and its busiest hour; then alerts.
      r.getElementById('top').innerHTML = `<div class="kpis">
${kpi('Usage today', t ? `${t.today.toFixed(1)} kWh` : '—', t ? `${money(t.todayEur ?? t.today * tariff)}` : '')}${kpi('Usage now', powerText(n.total))}${kpi('Price now', `€ ${pnow.toFixed(3)}<small style="font-size:11px;font-weight:500;color:var(--muted)"> /kWh</small>`, priceSub)}
${kpi('Usage this month', t ? `${t.month.toFixed(0)} kWh` : '—', t ? `${since}${money(t.monthEur ?? t.month * tariff)}` : '')}${kpi('Highest demand', t?.peak ? powerText(t.peak.w) : '—', t?.peak ? `This month · ${new Date(t.peak.t).toLocaleString('en-GB', { timeZone: h.config.time_zone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : '')}${alarms}</div>`;
      c.classList.toggle('wide', wide);
      const inner = (share) => Math.max(240, Math.round((wide ? (W - 12) * share : W) - 34));
      const half = inner(1 / 2);
      c.innerHTML = `${usage ? `<div class="box"><div class="chead"><h3>What uses the most today</h3></div><div class="toplist">${usage}</div></div>` : ''}${chartBox('Energy by hour, today', 'hours', this._parts, 'hours', this._modes.hours, half, pr, vat)}${chartBox('Energy by day', 'days', this._parts, 'days', this._modes.days, half, pr, vat)}${pricePanel(h, half)}`;
    }
  }
  // Setup: every location and group in one tree, for admins. Pick one on the left, change it on the right.
  // Locations, floors and areas live in Home Assistant. Here they are only listed, with the one thing that is still the portal's: the main device.
  // A table-first administration surface. The old client-facing cards are
  // intentionally not used here: the job is to inspect and change the tenant
  // model quickly, not to browse one client's energy workspace.
  // The location chosen in Administration. Every Administration page is its own card, so the choice
  // is kept here and in the session, and each page opens on it.
  const ADMIN_LOCATION_KEY = 'portalAdminLocation';
  let adminLocation = null;
  try { adminLocation = sessionStorage.getItem(ADMIN_LOCATION_KEY) || null; } catch (e) { /* private window */ }
  class AdminTableCard extends Base {
    get _selectedLocation() { return adminLocation; }
    set _selectedLocation(id) {
      adminLocation = id || null;
      try { if (adminLocation) sessionStorage.setItem(ADMIN_LOCATION_KEY, adminLocation); else sessionStorage.removeItem(ADMIN_LOCATION_KEY); } catch (e) { /* private window */ }
    }
    setConfig(c) {
      super.setConfig(c);
      this._section = c?.section || this._section || 'clients';
      this._scope = c?.scope || this._scope || 'admin';
    }
    get noBar() { return true; }
    build() {
      this._users = [];
      this._summaries = [];
      this._adminDevices = {};
      this._editor = null;
      this._role = 'all';
      this._allTenants = false;
      this._error = '';
      this._inbox = null;
      this._inboxFilter = 'waiting';
      this._picked = new Set();
      this._deviceView = 'devices';
      // What is typed into each search box, by the box's id.
      this._q = { clientSearch: '', locationSearch: '', peopleSearch: '', inboxSearch: '', wiringSearch: '' };
      this.shadowRoot.innerHTML = `<style>${BASE}${ADMIN_CSS}${ADMIN_TABLE_CSS}</style><div class="w admin"><div id="admin"></div><dialog class="admin-modal" id="editorDlg" aria-label="Edit"><div id="editorBody"></div></dialog><div class="flash" id="flash" role="status"></div></div>`;
      const dlg = this.shadowRoot.getElementById('editorDlg');
      const dismiss = () => { this._editor = null; this.paint(true); };
      // Esc and a click outside the box close the dialog without saving; Enter in a field saves.
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); dismiss(); });
      dlg.addEventListener('mousedown', (e) => { if (e.target === dlg) dismiss(); });
      dlg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') { e.preventDefault(); this.saveEditor(); } });
      const w = this.shadowRoot.querySelector('.w');
      w.addEventListener('click', (e) => this.onClick(e));
      w.addEventListener('change', (e) => this.onChange(e));
      w.addEventListener('input', (e) => this.onInput(e));
      this.startTimer();
    }
    async refresh() { await this.load(); this.paint(); }
    async load() {
      if (!PORTAL.ready || !TREE.places.length) await ensureTree(this._hass);
      const seq = (this._loadSeq || 0) + 1;
      this._loadSeq = seq;
      const client = portalClient;
      const root = PORTAL.isRoot;
      if (!root && this._scope !== 'setup') {
        navigate(START_PATH);
        return;
      }
      try {
        const [users, allDevices, allEntities] = await Promise.all([
          this._hass.callWS({
            type: 'optim_energy/user/list',
            ...(root && client && !this.everyTenant() ? { client } : {}),
          }),
          root ? this._hass.callWS({ type: 'optim_energy/registry/list', kind: 'device' }).catch(() => []) : [],
          root ? this._hass.callWS({ type: 'optim_energy/registry/list', kind: 'entity' }).catch(() => []) : [],
        ]);
        // Every Home Assistant device with where it is.
        const inbox = root ? await this._hass.callWS({ type: 'optim_energy/device/inbox' }).catch(() => null) : null;
        let summaries = [];
        if (root) {
          summaries = await Promise.all((PORTAL.clients || []).map(async (item) => {
            try {
              const [treePayload, clientUsers] = await Promise.all([
                this._hass.callWS({ type: 'optim_energy/tree/get', client: item.id }),
                this._hass.callWS({ type: 'optim_energy/user/list', client: item.id }),
              ]);
              const tree = treePayload?.tree || {};
              const places = Array.isArray(tree.places) ? tree.places : [];
              return {
                ...item,
                places,
                locations: places.filter((p) => p.kind === 'location').length,
                groups: places.filter((p) => p.kind === 'group').length,
                // The same count the device list shows: real devices, a multi-channel meter once, no virtual devices.
                devices: Array.isArray(inbox) ? inbox.filter((d) => d.client === item.id).length : Object.keys(tree.placed || {}).filter((k) => !k.startsWith('virt:')).length,
                people: clientUsers.length,
                active: clientUsers.filter((u) => u.is_active).length,
              };
            } catch (e) {
              return { ...item, locations: 0, groups: 0, devices: 0, people: 0, active: 0 };
            }
          }));
        }
        if (seq !== this._loadSeq || client !== portalClient) return;
        this._users = Array.isArray(users) ? users : [];
        this._summaries = summaries;
        this._inbox = Array.isArray(inbox) ? inbox : null;
        this._picked = new Set([...this._picked].filter((id) => (this._inbox || []).some((d) => d.id === id)));
        // The wiring table and its Add dialog offer what the inbox recognised, from any integration,
        // on top of the older Zigbee2MQTT and Shelly rule.
        const recognised = new Set((Array.isArray(inbox) ? inbox : []).filter((d) => d.status === 'assigned' || (d.kind && d.status !== 'ignored')).map((d) => d.id));
        const offered = root ? [...adminDeviceCatalog(allDevices, allEntities, TREE.placed), ...(allDevices || []).filter((d) => recognised.has(d.id))] : [];
        this._adminDevices = Object.fromEntries(offered.map((d) => [d.id, d]));
        this._error = '';
      } catch (e) {
        if (seq !== this._loadSeq || client !== portalClient) return;
        this._users = [];
        this._error = e?.message || String(e);
      }
    }
    selectedClient() {
      return (PORTAL.clients || []).find((item) => item.id === portalClient) || { id: portalClient, name: PORTAL.clientName || portalClient || 'No tenant' };
    }
    locations() { return TREE.places.filter((p) => p.kind === 'location').sort(byName); }
    allPlaces() {
      const out = [], walk = (id, depth) => placeChildren(id).forEach((p) => { out.push({ ...p, depth }); walk(p.id, depth + 1); });
      this.locations().forEach((p) => { out.push({ ...p, depth: 0 }); walk(p.id, 1); });
      return out;
    }
    placeName(id) { return id ? (placeById(id)?.name || placeLabel(id) || id) : '—'; }
    // Users of every tenant at once: only on the Users page, and only for a Home Assistant administrator.
    everyTenant() { return this._allTenants && PORTAL.isRoot && this._section === 'people'; }
    anyPlaceName(id) { return placeById(id)?.name || (this._summaries || []).flatMap((x) => x.places || []).find((p) => p.id === id)?.name || id; }
    userLocations(user) {
      const list = Array.isArray(user?.locations) ? user.locations : user?.location ? [user.location] : [];
      return list.map((id) => this.anyPlaceName(id)).filter(Boolean).join(' · ') || 'Unassigned';
    }
    roleName(role) { return role === 'client_admin' ? 'Tenant admin' : 'User'; }
    typeOf(device) {
      if (device.virtual) return 'Virtual';
      const labels = device.labels || [];
      if (labels.includes('light')) return 'Light';
      if (labels.includes('socket')) return 'Socket';
      if (labels.includes('relay')) return 'Relay';
      if (labels.includes('ac')) return 'AC';
      if (labels.includes('energy_meter')) return 'Energy meter';
      // The same recognition the inbox uses, so both tables call a device the same thing.
      const seen = (this._inbox || []).find((d) => d.id === device.id)?.kind;
      if (seen) return { meter: 'Energy meter', relay: 'Relay', socket: 'Socket', light: 'Light', ac: 'AC' }[seen];
      if (/1PM/i.test(device.model || '')) return 'Relay';
      return 'Energy meter';
    }
    deviceRows(locationId = null) {
      const devices = PORTAL.isRoot && Object.keys(this._adminDevices || {}).length ? this._adminDevices : (HASS?.devices || {});
      const native = NATIVE ? nativePlaced(devices, NATIVE) : {};
      const rows = Object.values(devices).map((device) => ({
        ...device,
        virtual: false,
        name: device.name_by_user || device.name || device.id,
        place: TREE.placed[device.id] || native[device.id] || null,
      }));
      for (const item of TREE.virtual || []) rows.push({ ...item, virtual: true, name: item.name || item.id, place: TREE.placed[item.id] || null });
      const under = locationId ? placesUnder(locationId) : null;
      // With the device list available, this table is about the selected client's own devices only;
      // a device nobody has yet belongs under Devices, not here.
      // A device with no place belongs under Unassigned, and a channel of a placed meter is part of that meter.
      const own = (row) => row.virtual || (!!row.place && !(row.via_device_id && TREE.placed[row.via_device_id]));
      return rows.filter((row) => own(row) && (!under || (row.place && under.has(row.place))));
    }
    // ---- shared pieces: every section is one card with its filters in the head and its table edge to edge ----
    table(headers, rows, id = '', empty = 'No rows yet.') {
      const th = (h) => (typeof h === 'string' ? `<th${h === 'Actions' ? ' class="act"' : ''}>${esc(h)}</th>` : `<th class="${h.cls || ''}">${h.html ?? esc(h.text || '')}</th>`);
      return `<div class="admin-table-wrap"${id ? ` id="${id}"` : ''}><table class="admin-table"><thead><tr>${headers.map(th).join('')}</tr></thead><tbody>${rows.length ? rows.map((row) => (typeof row === 'string' ? `<tr>${row}</tr>` : `<tr class="${row.cls || ''}">${row.html}</tr>`)).join('') : `<tr><td class="admin-empty" colspan="${headers.length}">${esc(empty)}</td></tr>`}</tbody></table></div>`;
    }
    action(label, attrs = '', cls = 'table-action') { return `<button class="${cls}" ${attrs}>${esc(label)}</button>`; }
    card(head, body, foot = '') { return `<section class="admin-card">${head ? `<div class="admin-card-head">${head}</div>` : ''}${body}${foot ? `<div class="admin-card-foot">${foot}</div>` : ''}</section>`; }
    chips(attr, items, current) { return `<div class="chips">${items.map(([value, label, count]) => `<button class="chip${value === current ? ' on' : ''}" data-${attr}="${esc(value)}" aria-pressed="${value === current}">${esc(label)}${count == null ? '' : `<span>${count}</span>`}</button>`).join('')}</div>`; }
    search(id, placeholder) { return `<label class="admin-search"><ha-icon icon="mdi:magnify"></ha-icon><input id="${id}" type="search" value="${esc(this._q[id] || '')}" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}"></label>`; }
    // Does any of these texts contain what was typed into that search box?
    matches(id, ...texts) { const q = (this._q[id] || '').trim().toLowerCase(); return !q || texts.some((x) => String(x || '').toLowerCase().includes(q)); }
    sorted(list, ...keys) { const text = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'en', { numeric: true, sensitivity: 'base' }); return [...list].sort((a, b) => { for (const k of keys) { const c = text(k(a), k(b)); if (c) return c; } return 0; }); }
    // Ask before anything that deletes or cuts someone off. run() does the work and ends by calling afterChange.
    confirm(title, text, label, run) { this._editor = { kind: 'confirm', title, text, label, run }; this.paint(true); }

    // ---- the dialog: every edit and every confirmation ----
    renderEditor() {
      const e = this._editor;
      if (!e) return '';
      const locs = this.allPlaces(), locations = this.locations(), clients = PORTAL.clients || [];
      const text = (id, label, value = '', more = '') => `<label class="field wide">${esc(label)}<input id="${id}" maxlength="80" value="${esc(value)}" autocomplete="off"${more}></label>`;
      const pick = (id, label, options, wide = true) => `<label class="field${wide ? ' wide' : ''}">${esc(label)}<select id="${id}">${options}</select></label>`;
      let title = 'Edit', fields = '', save = 'Save', danger = false;
      if (e.kind === 'confirm') {
        title = e.title; save = e.label; danger = true;
        fields = `<p class="confirm-text">${esc(e.text)}</p>`;
      } else if (e.kind === 'client') {
        title = e.id ? 'Edit tenant' : 'New tenant';
        save = e.id ? 'Save' : 'Create tenant';
        fields = `${text('editorName', 'Tenant name', e.name || '')}${e.id ? '' : `<p class="admin-note">A floor with this name is created in Home Assistant. Add its locations next.</p>`}`;
      } else if (e.kind === 'location') {
        title = e.id ? 'Edit location' : `New location for ${this.selectedClient().name}`;
        save = e.id ? 'Save' : 'Create location';
        fields = `${text('editorName', 'Location name', e.name || '')}<p class="admin-note">A location is an area in Home Assistant on this tenant's floor, under the same name, so no other area may have that name. A device given that area lands in this location.</p>`;
      } else if (e.kind === 'location-move') {
        title = `Move ${e.name} to another tenant`; save = 'Move location';
        fields = `${pick('editorClient', 'New tenant', clients.filter((x) => x.id !== portalClient).map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join(''))}<p class="admin-note">The location moves with its groups, devices, price, schedules and alert rules. Its users stay with the old tenant, so remove it from them first.</p>`;
      } else if (e.kind === 'person') {
        const current = e.user, role = e.role || current?.role || 'user';
        // With all tenants listed, the user's own tenant decides which locations are offered.
        const tenant = current?.client || e.client || portalClient, tenantName = clients.find((x) => x.id === tenant)?.name || this.selectedClient().name;
        const sites = PORTAL.isRoot && tenant !== portalClient ? this.clientPlaces(tenant).filter((p) => p.kind === 'location') : locations;
        title = current ? `Edit ${current.name || current.username}` : `New user for ${tenantName}`;
        save = current ? 'Save' : 'Create user';
        const selected = e.locations || current?.locations || (current?.location ? [current.location] : []);
        const pickTenant = !current && this._allTenants ? pick('personClient', 'Tenant', clients.map((x) => `<option value="${esc(x.id)}"${x.id === tenant ? ' selected' : ''}>${esc(x.name)}</option>`).join('')) : '';
        fields = `${pickTenant}<label class="field"><span class="field-top">Name</span><input id="editorName" maxlength="80" value="${esc(current?.name || '')}" autocomplete="off"></label><label class="field"><span class="field-top">Username</span><input id="editorUsername" maxlength="80" value="${esc(current?.username || '')}" autocomplete="off"${current ? ' disabled' : ''}></label><div class="field"><span class="field-top"><label for="editorPassword">${current ? 'New password' : 'Password'}</label><button type="button" class="inline-action" data-generate-password="1">Generate</button></span><input id="editorPassword" type="${e.shown ? 'text' : 'password'}" minlength="8" autocomplete="new-password" placeholder="${current ? 'Leave empty to keep it' : 'At least 8 characters'}"></div><label class="field"><span class="field-top">Role</span><select id="editorRole"><option value="user">User</option>${PORTAL.isRoot ? `<option value="client_admin"${role === 'client_admin' ? ' selected' : ''}>Tenant admin</option>` : ''}</select></label>${role === 'client_admin' ? '<p class="admin-note">A tenant admin sees every location of the tenant and manages its users, groups and settings.</p>' : `<div class="field wide"><span class="field-top">Locations this user can see</span><div class="checks" id="editorLocations">${sites.map((p) => `<label class="check"><input type="checkbox" data-loc-check="${esc(p.id)}"${selected.includes(p.id) ? ' checked' : ''}> ${esc(p.name)}</label>`).join('') || '<span class="admin-note">This tenant has no location yet. Add one under Locations first.</span>'}</div></div>`}`;
      } else if (e.kind === 'assign') {
        const names = e.devices.map((id) => (this._inbox || []).find((d) => d.id === id)?.name || id);
        title = names.length === 1 ? `Assign ${names[0]}` : `Assign ${names.length} devices`;
        save = 'Assign';
        const client = e.client || portalClient, places = this.clientPlaces(client), sites = places.filter((p) => p.kind === 'location');
        const location = sites.some((p) => p.id === e.location) ? e.location : sites[0]?.id || '';
        const under = (id) => places.filter((p) => p.parent === id).flatMap((p) => [p, ...under(p.id)]);
        const groups = location ? under(location) : [];
        fields = `${pick('assignClient', 'Tenant', clients.map((x) => `<option value="${esc(x.id)}"${x.id === client ? ' selected' : ''}>${esc(x.name)}</option>`).join(''))}${pick('assignLocation', 'Location', sites.map((p) => `<option value="${esc(p.id)}"${p.id === location ? ' selected' : ''}>${esc(p.name)}</option>`).join(''), false)}${pick('assignGroup', 'Group', `<option value="">No group</option>${groups.map((p) => `<option value="${esc(p.id)}"${p.id === e.group ? ' selected' : ''}>${esc(this.placeNameIn(places, p.id).split(' › ').slice(1).join(' › '))}</option>`).join('')}`, false)}${sites.length ? '' : '<p class="admin-note">This tenant has no location yet. Add one under Locations first.</p>'}${names.length > 1 ? `<p class="admin-note">${esc(names.join(', '))}</p>` : ''}`;
      } else if (e.kind === 'group') {
        title = e.id ? `Edit ${e.name || 'group'}` : 'New group'; save = e.id ? 'Save' : 'Create group';
        const location = locations.some((p) => p.id === e.location) ? e.location : locations[0]?.id || '';
        const own = e.id ? placesUnder(e.id) : new Set();
        const inside = [...placesUnder(location)].filter((id) => id !== location && !own.has(id)).map((id) => TREE.places.find((p) => p.id === id)).filter(Boolean);
        const parent = inside.some((p) => p.id === e.parent) ? e.parent : '';
        const devices = this.sorted(this.deviceRows(location).filter((d) => !d.virtual), (d) => d.name);
        const inGroup = devices.filter((d) => e.members.has(d.id)).length;
        fields = `${text('editorName', 'Group name', e.name || '')}${pick('groupLocation', 'Location', locations.map((p) => `<option value="${esc(p.id)}"${p.id === location ? ' selected' : ''}>${esc(p.name)}</option>`).join(''), false)}${pick('groupParent', 'Inside group', `<option value="">None</option>${inside.map((p) => `<option value="${esc(p.id)}"${p.id === parent ? ' selected' : ''}>${esc(placeLabel(p.id).split(' › ').slice(1).join(' › '))}</option>`).join('')}`, false)}<div class="field wide"><span class="field-top">Devices in this group<span class="field-hint" id="groupCount">${inGroup} of ${devices.length}</span></span><div class="checks tall" id="groupDevices">${devices.map((d) => `<label class="check"><input type="checkbox" data-group-device="${esc(d.id)}"${e.members.has(d.id) ? ' checked' : ''}> <span>${esc(d.name)}</span>${d.place && d.place !== location && d.place !== e.id ? `<span class="check-sub">${esc(placeById(d.place)?.name || '')}</span>` : ''}</label>`).join('') || '<span class="admin-note">This location has no devices yet.</span>'}</div></div>`;
      } else if (e.kind === 'device-edit') {
        // Everything about one device in one place: its name, where it is, its parent device, and whether it is the main one.
        const d = this.deviceRows().find((x) => x.id === e.device) || { id: e.device, name: '' }, was = placePath(d.place)[0]?.id || '';
        title = `Edit ${d.name}`;
        const tenant = e.client || portalClient, elsewhere = tenant !== portalClient;
        const places = elsewhere ? this.clientPlaces(tenant) : TREE.places, sites = this.sorted(places.filter((p) => p.kind === 'location'), (p) => p.name);
        const location = sites.some((p) => p.id === e.location) ? e.location : (!elsewhere && sites.some((p) => p.id === was) ? was : sites[0]?.id || '');
        const under = (id) => places.filter((p) => p.parent === id).flatMap((p) => [p, ...under(p.id)]);
        const groups = location ? under(location) : [], group = groups.some((p) => p.id === e.group) ? e.group : '';
        const others = this.sorted(this.deviceRows().filter((x) => x.id !== d.id && !wouldLoop(d.id, x.id)), (x) => x.name);
        const pickTenant = PORTAL.isRoot && !d.virtual && clients.length > 1 ? pick('deviceClient', 'Tenant', clients.map((x) => `<option value="${esc(x.id)}"${x.id === tenant ? ' selected' : ''}>${esc(x.name)}</option>`).join('')) : '';
        fields = `${text('editorName', 'Name', d.name)}${pickTenant}${pick('deviceLocation', 'Location', sites.map((p) => `<option value="${esc(p.id)}"${p.id === location ? ' selected' : ''}>${esc(p.name)}</option>`).join(''), false)}${pick('deviceGroup', 'Group', `<option value="">No group</option>${groups.map((p) => `<option value="${esc(p.id)}"${p.id === group ? ' selected' : ''}>${esc(this.placeNameIn(places, p.id).split(' › ').slice(1).join(' › '))}</option>`).join('')}`, false)}${elsewhere ? '<p class="admin-note">Moving to another tenant: the old tenant stops seeing this device at once.</p>' : !portalCanWire() ? '' : `${pick('editorParent', 'Parent device', `<option value="">None</option>${others.map((x) => `<option value="${esc(x.id)}"${TREE.parents?.[d.id] === x.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}`)}<label class="check wide"><input type="checkbox" id="editorMain"${was && TREE.mains?.[was] === d.id ? ' checked' : ''}> Main device</label>`}`;
      } else if (e.kind === 'price') {
        // One place for what a kWh costs at a location. The three sources stay saved; one is in use.
        const p = TREE.prices?.[e.loc] || {}, h = this._hass, eur = (v) => `€ ${Number(v).toFixed(3)}`, rule = priceRule(h, e.loc);
        title = `Price for ${placeById(e.loc)?.name || ''}`; save = 'Use this price';
        const tabs = [['exchange', 'IBEX'], ['bill', 'Bill'], ['fixed', 'Fixed']];
        const inUse = { bill: 'the bill', exchange: 'IBEX', fixed: 'a fixed price', helper: 'nothing yet' }[rule.mode];
        let part = '';
        if (e.mode === 'exchange') {
          const sensor = ibexSensor(h, e.loc), ex = sensor ? priceRule(h, e.loc, 'exchange') : null;
          part = `<div class="price-big"><span>Exchange price now${ex?.stale ? ', last known' : ''}</span><b>${ex && ex.mode === 'exchange' ? eur(ex.now) : '—'}</b></div><div class="field wide"><span class="field-top">Source${priceStatusChip(h)}</span></div><label class="field wide"><span class="field-top">Margin above IBEX, before VAT (€ per kWh)</span><input id="priceExtra" inputmode="decimal" autocomplete="off" placeholder="0.050" value="${esc(e.extra ?? String(Number(p.extra) || 0))}"></label><p class="admin-note">The price follows the exchange every 15 minutes. 20% VAT is added to the exchange price plus the margin.</p>`;
        } else if (e.mode === 'fixed') {
          part = `<label class="field wide"><span class="field-top">Price per kWh, VAT included (€)</span><input id="priceFixed" inputmode="decimal" autocomplete="off" placeholder="0.320" value="${esc(e.fixed ?? (Number(p.fixed) > 0 ? String(p.fixed) : ''))}"></label><p class="admin-note">One price at all hours.</p>`;
        } else {
          const b = e.bill, saved = Number(p.bill) > 0 ? `<div class="price-big"><span>Saved bill price${p.billSource?.from ? `, ${billDay(p.billSource.from)} - ${billDay(p.billSource.to)}` : ''}</span><b>${eur(p.bill)}</b></div>` : '';
          let read = '';
          if (b?.step === 'busy') read = `<p class="admin-note" role="status">Reading ${esc(b.files)}… This can take up to a minute.</p>`;
          else if (b?.step === 'error') read = `<p class="form-error" style="display:block">${esc(b.msg)}</p>`;
          else if (b?.step === 'done') { const pr = billPrices(b.bill, null); read = `<div class="price-big new"><span>From ${esc(b.files)}: ${Number(b.bill.kwh).toLocaleString('en-GB')} kWh, € ${Number(pr.totalIncl).toFixed(2)} with VAT</span><b>${eur(pr.fixed)}</b></div>`; }
          part = `${b?.step === 'done' ? '' : saved}${read}<label class="field wide"><span class="field-top">${saved ? 'Upload a newer bill' : 'Upload a bill'} (PDF or photos of its pages)</span><input type="file" id="billFile" accept="application/pdf,image/jpeg,image/png,image/webp" multiple${b?.step === 'busy' ? ' disabled' : ''}></label><p class="admin-note">The bill is read to find its total and its kWh; the price is the total with VAT divided by the kWh. Nothing changes until you press Use this price.</p>`;
        }
        fields = `<div class="wide"><div class="seg-tabs full" role="tablist">${tabs.map(([v, l]) => `<button type="button" class="${e.mode === v ? 'on' : ''}" data-price-tab="${v}" role="tab" aria-selected="${e.mode === v}">${l}</button>`).join('')}</div></div><p class="admin-note">In use now: <b>${esc(inUse)}</b>, ${eur(rule.now)} per kWh ${vatNote(rule)}.</p>${part}`;
      } else if (e.kind === 'virtual') {
        title = 'New virtual device'; save = 'Create virtual device';
        fields = `${text('editorName', 'Name')}${pick('editorPlace', 'Location or group', locs.map((p) => `<option value="${esc(p.id)}"${p.id === this._selectedLocation ? ' selected' : ''}>${esc(placeLabel(p.id))}</option>`).join(''))}<p class="admin-note">A virtual device adds up the devices that have it as their parent device.</p>`;
      }
      return `<div class="admin-editor"><header><h3>${esc(title)}</h3><button type="button" class="x" data-cancel-editor="1" aria-label="Close">×</button></header><div class="form-grid">${fields}</div><p class="form-error" id="editorError" role="alert"></p><div class="form-actions"><button type="button" class="quiet" data-cancel-editor="1">Cancel</button><button type="button" class="${danger ? 'danger' : 'primary'}" data-save-editor="1">${esc(save)}</button></div></div>`;
    }

    // ---- sections ----
    renderClients() {
      const list = this.sorted((this._summaries || []).filter((x) => this.matches('clientSearch', x.name)), (x) => x.name || x.id);
      const rows = list.map((item) => `<td><button class="table-name" data-open-client="${esc(item.id)}">${esc(item.name || item.id)}</button></td><td class="num">${item.locations || 0}</td><td class="num">${item.people || 0}</td><td class="num">${item.devices || 0}</td><td><div class="table-actions">${this.action('Open', `data-open-client="${esc(item.id)}"`)}${this.action('Preview', `data-preview-client="${esc(item.id)}"`)}${this.action('Edit', `data-edit-client="${esc(item.id)}" data-name="${esc(item.name || '')}"`)}${this.action('Delete', `data-delete-client="${esc(item.id)}"`, 'table-action danger')}</div></td>`);
      const head = `${this.search('clientSearch', 'Search tenants')}<span class="sp"></span><span class="toolbar-label">${list.length} ${list.length === 1 ? 'tenant' : 'tenants'}</span>`;
      const empty = this._q.clientSearch ? 'No tenant matches the search.' : 'No tenants yet. Start with New tenant.';
      const table = this.card(head, this.table(['Tenant', { text: 'Locations', cls: 'num' }, { text: 'Users', cls: 'num' }, { text: 'Devices', cls: 'num' }, 'Actions'], rows, '', empty), 'Open a tenant to manage its locations, users and devices. Preview shows the portal as that tenant sees it.');
      return table;
    }
    renderPeople() {
      const all = this._users || [], n = (role) => all.filter((u) => u.role === role).length;
      // Client administrators first, then by name.
      const every = this.everyTenant(), tenantOf = (u) => (PORTAL.clients || []).find((x) => x.id === u.client)?.name || u.client || '';
      const at = every ? null : this._selectedLocation, here = (u) => !at || u.role === 'client_admin' || (Array.isArray(u.locations) ? u.locations : u.location ? [u.location] : []).includes(at);
      const users = this.sorted(all.filter((u) => here(u) && (this._role === 'all' || u.role === this._role) && this.matches('peopleSearch', u.name, u.username, this.userLocations(u), every ? tenantOf(u) : '')), (u) => (every ? tenantOf(u) : ''), (u) => (u.role === 'client_admin' ? 0 : 1), (u) => u.name || u.username);
      const mine = this._hass.user?.id;
      const rows = users.map((u) => `<td><b>${esc(u.name || u.username || u.id)}</b>${u.id === mine ? ' <span class="pill muted">you</span>' : ''}<span class="table-sub">@${esc(u.username || 'no username')}</span></td>${every ? `<td>${esc(tenantOf(u))}</td>` : ''}<td><span class="pill${u.role === 'client_admin' ? ' accent' : ''}">${esc(this.roleName(u.role))}</span></td><td class="hide-s">${u.role === 'client_admin' ? '<span class="table-sub">All locations</span>' : esc(this.userLocations(u))}</td><td><span class="pill${u.is_active ? '' : ' warn'}"><span class="dot${u.is_active ? ' ok' : ''}"></span>${u.is_active ? 'Active' : 'Disabled'}</span></td><td><div class="table-actions">${this.action('Edit', `data-edit-person="${esc(u.id)}"`)}${PORTAL.isRoot || (u.role !== 'client_admin' && u.id !== mine) ? `${this.action(u.is_active ? 'Disable' : 'Enable', `data-toggle="${esc(u.id)}"`)}${this.action('Delete', `data-delete="${esc(u.id)}"`, 'table-action danger')}` : ''}</div></td>`);
      const head = `${this.chips('people-role', [['all', 'All', all.length], ['client_admin', 'Tenant admins', n('client_admin')], ['user', 'Users', n('user')]], this._role)}<span class="sp"></span>${this.search('peopleSearch', 'Search by name, username or location')}`;
      const empty = this._q.peopleSearch || this._role !== 'all' || at ? 'No user matches.' : 'No users yet. Add the first one with New user.';
      const foot = `${every ? '<span>Users of every tenant.</span>' : `<span id="locationmap">Locations of ${esc(this.selectedClient().name)}: <b>${esc(this.locations().map((x) => x.name).join(' · ') || 'none yet')}</b></span>`}<span>${users.length} of ${all.length} shown</span>`;
      return this.card(head, this.table(['User', ...(every ? ['Tenant'] : []), 'Role', { text: 'Locations', cls: 'hide-s' }, 'Status', 'Actions'], rows, 'people', empty), foot);
    }
    // The devices table: where each device of the selected tenant sits, its parent device, and which one is the main device.
    deviceRowsHtml(locationId = null) {
      const list = this.sorted(this.deviceRows(locationId).filter((d) => this.matches('wiringSearch', d.name, d.model, placeLabel(d.place))), (d) => placeParts(d.place).location, (d) => placeParts(d.place).group, (d) => d.name);
      const names = Object.fromEntries(this.deviceRows().map((d) => [d.id, d.name]));
      const listed = new Set(this.hasInbox() ? this._inbox.filter((d) => d.status === 'assigned').map((d) => d.id) : []);
      const rows = list.map((d) => {
        const root = placePath(d.place)[0]?.id || null, main = root ? TREE.mains?.[root] === d.id : false, parts = placeParts(d.place), parent = TREE.parents?.[d.id];
        return `<td><b>${esc(d.name)}</b>${main ? ' <span class="pill accent">Main</span>' : ''}<span class="table-sub">${esc(d.virtual ? 'Virtual device' : d.model || '')}</span></td><td class="hide-s">${esc(this.typeOf(d))}</td><td>${esc(parts.location || '—')}<span class="table-sub">${esc(parts.group || '')}</span></td><td class="hide-s">${esc(names[parent] || '—')}</td><td><div class="table-actions">${d.virtual && !portalCanWire() ? '' : this.action('Edit', `data-edit-device="${esc(d.id)}"`)}${d.virtual ? (portalCanWire() ? this.action('Delete', `data-delete-virtual="${esc(d.id)}"`, 'table-action danger') : '') : listed.has(d.id) ? this.action('Remove', `data-inbox-remove="${esc(d.id)}"`, 'table-action danger') : ''}</div></td>`;
      });
      const empty = this._q.wiringSearch ? 'No device matches the search.' : locationId ? (this.hasInbox() ? 'No devices in this location yet. Assign one from Unassigned.' : 'No devices in this location yet. Your administrator assigns them.') : 'No devices yet.';
      return this.table(['Device', { text: 'Type', cls: 'hide-s' }, 'Place', { text: 'Parent device', cls: 'hide-s' }, 'Actions'], rows, '', empty);
    }
    renderLocations() {
      const selected = this._selectedLocation && this.locations().find((p) => p.id === this._selectedLocation);
      const list = this.locations().filter((l) => this.matches('locationSearch', l.name)), owner = this.owner();
      const rows = list.map((l) => {
        const groups = placesUnder(l.id).size - 1, devices = this.deviceRows(l.id).length, main = TREE.mains?.[l.id] ? (this.deviceRows().find((d) => d.id === TREE.mains[l.id])?.name || TREE.mains[l.id]) : '—';
        const rule = priceRule(this._hass, l.id), source = { bill: 'Bill', exchange: 'IBEX', fixed: 'Fixed', helper: 'Not set' }[rule.mode] || '';
        const price = `<b>€ ${rule.now.toFixed(3)}</b><span class="table-sub">${esc(source)}${rule.stale ? ' · last known' : ''}</span>`;
        const own = owner ? `${this.action('Edit', `data-edit-location="${esc(l.id)}" data-name="${esc(l.name)}"`)}${(PORTAL.clients || []).length > 1 ? this.action('Move', `data-move-location="${esc(l.id)}" data-name="${esc(l.name)}"`) : ''}${this.action('Delete', `data-delete-location="${esc(l.id)}"`, 'table-action danger')}` : '';
        return { cls: selected?.id === l.id ? 'sel' : '', html: `<td><button class="table-name" data-select-location="${esc(l.id)}">${esc(l.name)}</button></td><td class="num">${groups}</td><td class="num">${devices}</td><td>${price}</td><td class="hide-s">${esc(main)}</td><td><div class="table-actions">${this.action('Manage groups', `data-select-location="${esc(l.id)}"`)}${this.action('Price', `data-price="${esc(l.id)}"`)}${own}</div></td>` };
      });
      const head = `${this.search('locationSearch', 'Search locations')}<span class="sp"></span><span class="toolbar-label">${list.length} ${list.length === 1 ? 'location' : 'locations'}</span>`;
      const empty = this._q.locationSearch ? 'No location matches the search.' : owner ? 'This tenant has no location yet. Add one with New location; devices and users are assigned to locations.' : 'No location yet. Your administrator adds locations.';
      const main = this.card(head, this.table(['Location', { text: 'Groups', cls: 'num' }, { text: 'Devices', cls: 'num' }, 'Price per kWh', { text: 'Main device', cls: 'hide-s' }, 'Actions'], rows, '', empty), selected ? '' : (list.length ? 'Manage groups shows a location\'s groups. Price sets what a kWh costs there.' : ''));
      if (!selected) return main;
      const groupList = this.sorted([...placesUnder(selected.id)].filter((id) => id !== selected.id).map((id) => TREE.places.find((p) => p.id === id)).filter(Boolean), (g) => placeLabel(g.id));
      const groupRows = groupList.map((g) => `<td><b>${esc(g.name)}</b></td><td>${esc(placeLabel(g.parent))}</td><td class="num">${this.deviceRows().filter((d) => d.place === g.id).length}</td><td><div class="table-actions">${this.action('Edit', `data-edit-group="${esc(g.id)}" data-name="${esc(g.name)}"`)}${this.action('Delete', `data-delete-group="${esc(g.id)}"`, 'table-action danger')}</div></td>`);
      const groups = this.card(`<h2>Groups in ${esc(selected.name)}<small>Groups organise this location's devices. Edit a group to choose its devices.</small></h2><span class="sp"></span><button class="quiet" data-new-group="${esc(selected.id)}">New group</button>`, this.table(['Group', 'Inside', { text: 'Devices', cls: 'num' }, 'Actions'], groupRows, '', 'No groups yet. Groups are optional.'));
      return `${main}${groups}`;
    }
    hasInbox() { return PORTAL.isRoot && Array.isArray(this._inbox); }
    // Administration, where a Home Assistant administrator creates, moves and deletes locations.
    // Setup shows the same tables to a tenant admin without those.
    owner() { return PORTAL.isRoot && this._scope !== 'setup'; }
    // Places of any client, not only the active one, for the assign dialog.
    clientPlaces(client) { return (this._summaries || []).find((x) => x.id === client)?.places || []; }
    placeNameIn(places, id) { const out = []; const seen = new Set(); let p = places.find((x) => x.id === id); while (p && !seen.has(p.id)) { seen.add(p.id); out.unshift(p.name); p = places.find((x) => x.id === p.parent); } return out.join(' › '); }
    // What still has no tenant: a device the portal recognises, or any device that carries a label.
    // Everything else Home Assistant knows (add-ons, services, bridges) is left out.
    waiting() { return (this._inbox || []).filter((d) => d.status === 'unassigned' || (d.status === 'other' && (d.labels || []).length)); }
    inboxRows() {
      const list = (this._inboxFilter === 'ignored' ? (this._inbox || []).filter((d) => d.status === 'ignored') : this.waiting()).filter((d) => this.matches('inboxSearch', d.name, d.model, (d.integrations || []).join(' '), (d.labels || []).join(' ')));
      return this.sorted(list, (d) => d.name);
    }
    viewTabs() {
      if (!this.hasInbox()) return '';
      const n = this.waiting().length;
      return `<div class="seg-tabs" role="tablist">${[['devices', 'Devices'], ['unassigned', `Unassigned${n ? ` (${n})` : ''}`]].map(([v, l]) => `<button class="${this._deviceView === v ? 'on' : ''}" data-device-view="${v}" role="tab" aria-selected="${this._deviceView === v}">${l}</button>`).join('')}</div>`;
    }
    // Devices that no tenant has yet.
    renderUnassigned() {
      const rows = this.inboxRows(), ignored = (this._inbox || []).filter((d) => d.status === 'ignored').length;
      const kind = { meter: 'Energy meter', relay: 'Relay', socket: 'Socket', light: 'Light', ac: 'AC' };
      const pickable = rows.filter((d) => d.status !== 'ignored'), allPicked = pickable.length > 0 && pickable.every((d) => this._picked.has(d.id));
      const html = rows.map((d) => {
        const acts = d.status === 'ignored' ? this.action('Stop ignoring', `data-inbox-unignore="${esc(d.id)}"`) : `${this.action('Assign', `data-inbox-assign="${esc(d.id)}"`)}${this.action('Ignore', `data-inbox-ignore="${esc(d.id)}"`)}`;
        return { cls: this._picked.has(d.id) ? 'sel' : '', html: `<td class="pick"><input type="checkbox" data-pick="${esc(d.id)}" aria-label="Select ${esc(d.name)}"${this._picked.has(d.id) ? ' checked' : ''}${d.status === 'ignored' ? ' disabled' : ''}></td><td><b>${esc(d.name)}</b><span class="table-sub">${esc([d.model, (d.integrations || []).join(', ')].filter(Boolean).join(' · '))}</span></td><td${d.why ? ` title="Recognised by its ${esc(d.why)}"` : ''}>${esc(kind[d.kind] || '—')}</td><td class="hide-s">${(d.labels || []).map((x) => `<span class="pill">${esc(x)}</span>`).join(' ') || '—'}</td><td><div class="table-actions">${acts}</div></td>` };
      });
      const empty = this._q.inboxSearch ? 'No device matches the search.' : this._inboxFilter === 'ignored' ? 'No ignored devices.' : 'Nothing is waiting. A new device shows up here once the portal recognises it or it has a label in Home Assistant.';
      const picked = this._picked.size, to = this._selectedLocation ? this.placeName(this._selectedLocation) : this.selectedClient().name;
      const head = `${this.viewTabs()}${this.chips('inbox-filter', [['waiting', 'Waiting', this.waiting().length], ['ignored', 'Ignored', ignored]], this._inboxFilter)}<span class="sp"></span>${this.search('inboxSearch', 'Search by name, model, integration or label')}`;
      const bulk = picked ? `<div class="admin-bulk"><b>${picked} selected</b><span class="sp"></span><button class="quiet" data-clear-picked="1">Clear</button><button class="primary" data-assign-picked="1">Assign…</button></div>` : '';
      const table = this.table([{ cls: 'pick', html: `<input type="checkbox" data-pick-all="1" aria-label="Select all shown"${allPicked ? ' checked' : ''}${pickable.length ? '' : ' disabled'}>` }, 'Device', 'Type', { text: 'Labels', cls: 'hide-s' }, 'Actions'], html, 'inbox', empty);
      return this.card(head, `${bulk}${table}`, `<span>Assign puts a device in a location; it opens on <b>${esc(to)}</b>. Giving a device a location's area in Home Assistant assigns it too.</span><span>${rows.length} shown</span>`);
    }
    // The devices of the selected tenant, narrowed to the selected location.
    renderDevices() {
      if (this.hasInbox() && this._deviceView === 'unassigned') return this.renderUnassigned();
      const at = this._selectedLocation, n = this.deviceRows(at).length;
      const head = `${this.viewTabs()}<span class="toolbar-label">${n} ${n === 1 ? 'device' : 'devices'} in <b>${esc(at ? this.placeName(at) : this.selectedClient().name)}</b></span><span class="sp"></span>${this.search('wiringSearch', 'Search devices')}${portalCanWire() ? '<button class="quiet" data-new-virtual="1">New virtual device</button>' : ''}`;
      return this.card(head, this.deviceRowsHtml(at), portalCanWire() ? 'Edit a device to rename it, move it, set its parent device, or make it the main device.' : 'Edit a device to rename it or move it to another location or group.');
    }
    shell(title, lede, actions, body) {
      const clients = PORTAL.clients || [], setup = this._scope === 'setup';
      // Which tenant and which location the page is about, on every page but the list of tenants.
      const perClient = this._section !== 'clients', at = this._selectedLocation;
      const every = this.everyTenant();
      const tenant = PORTAL.isRoot && clients.length
        ? `<label class="admin-control"><span>Tenant</span><select id="clientSwitch">${this._section === 'people' ? `<option value=""${every ? ' selected' : ''}>All tenants</option>` : ''}${this.sorted(clients, (x) => x.name).map((x) => `<option value="${esc(x.id)}"${!every && x.id === portalClient ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>`
        : `<span class="toolbar-label">Tenant · <b>${esc(this.selectedClient().name)}</b></span>`;
      const where = `<label class="admin-control"><span>Location</span><select id="locationSwitch"><option value="">All locations</option>${this.locations().map((l) => `<option value="${esc(l.id)}"${l.id === at ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>`;
      const picker = perClient ? `${tenant}${every ? '' : where}` : '';
      return `<div class="admin-head"><div><span class="admin-kicker">Optim Energy / ${setup ? 'Setup' : 'Administration'}</span><h1>${esc(title)}</h1><p>${esc(lede)}</p></div><div class="admin-actions">${picker}${setup ? '' : '<button class="quiet" data-refresh="1">Refresh</button>'}${actions || ''}</div></div>${body}`;
    }
    paint(force = false) {
      const r = this.shadowRoot;
      if (!r) return;
      // A routine redraw waits while something is being typed. A dialog that has just been saved or
      // dismissed is not "being typed in" any more, even though its field still has the focus.
      const active = r.activeElement, closing = !this._editor && r.getElementById('editorDlg')?.contains(active);
      if (!force && !closing && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active?.tagName)) return;
      // Only once this tenant's locations are known, so a page that is still loading does not forget the choice.
      if (this._selectedLocation && this.locations().length && !this.locations().some((x) => x.id === this._selectedLocation)) this._selectedLocation = null;
      const name = this.selectedClient().name, spot = this._selectedLocation ? `${this.placeName(this._selectedLocation)}, ${name}` : name;
      const copy = {
        clients: ['Tenants', 'Every tenant, with its locations, users and devices.'],
        locations: ['Locations', `The locations of ${name} and their groups.`],
        people: ['Users', this.everyTenant() ? 'Everyone who can sign in, across all tenants.' : `Who can sign in for ${spot}, and what they can see.`],
        devices: ['Devices', this.hasInbox() && this._deviceView === 'unassigned' ? 'Devices that no tenant has yet.' : `The devices of ${spot} and where they are.`],
      }[this._section] || ['Tenants', ''];
      const body = this._section === 'people' ? this.renderPeople() : this._section === 'locations' ? this.renderLocations() : this._section === 'devices' ? this.renderDevices() : this.renderClients();
      const actions = this._section === 'people' ? '<button class="primary" data-new-person="1">New user</button>'
        : this._section === 'locations' ? (this.owner() ? '<button class="primary" data-new-location="1">New location</button>' : '')
          : this._section === 'devices' ? '' : '<button class="primary" data-new-client="1">New tenant</button>';
      r.getElementById('admin').innerHTML = this.shell(copy[0], copy[1], actions, body);
      this.paintDialog();
      r.getElementById('flash').textContent = '';
    }
    // The dialog lives outside the repainted area, so the page can refresh behind it without touching it.
    // It is drawn when it opens, and again only when a choice inside it changes what it offers (the role,
    // the client being assigned to). What was typed so far is carried across that redraw.
    paintDialog() {
      const r = this.shadowRoot, dlg = r.getElementById('editorDlg'), body = r.getElementById('editorBody');
      if (!this._editor) { this._paintedEditor = null; body.innerHTML = ''; if (dlg.open) dlg.close(); return; }
      if (this._paintedEditor === this._editor && !this._editorStale) return;
      this._editorStale = false;
      const typed = this._paintedEditor === this._editor
        ? [...body.querySelectorAll('input[id], select[id]')].filter((x) => x.type !== 'file').map((x) => [x.id, x.type === 'checkbox' ? x.checked : x.value])
        : [];
      const error = this._paintedEditor === this._editor ? r.getElementById('editorError')?.textContent : '';
      body.innerHTML = this.renderEditor();
      for (const [id, value] of typed) {
        const el = r.getElementById(id);
        if (!el) continue;
        if (typeof value === 'boolean') el.checked = value;
        else if (el.tagName !== 'SELECT' || [...el.options].some((o) => o.value === value)) el.value = value;
      }
      if (error) r.getElementById('editorError').textContent = error;
      const fresh = this._paintedEditor !== this._editor;
      this._paintedEditor = this._editor;
      if (!dlg.open) { if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', ''); }
      if (fresh) (this._editor.kind === 'confirm' ? body.querySelector('.form-actions [data-cancel-editor]') : body.querySelector('input:not([disabled]):not([type=checkbox]), select') || body.querySelector('[data-save-editor]'))?.focus();
    }
    flash(text, bad = false) {
      const el = this.shadowRoot?.getElementById('flash');
      if (!el) return;
      const inDialog = bad && this._editor ? this.shadowRoot.getElementById('editorError') : null;
      if (inDialog) { inDialog.textContent = text; return; }
      el.textContent = text;
      el.classList.toggle('bad', bad);
      clearTimeout(this._msgT);
      this._msgT = setTimeout(() => { if (el) { el.textContent = ''; el.classList.remove('bad'); } }, 5000);
    }
    async afterChange(message) {
      this._editor = null;
      whoLoad = null;
      treeLoad = null;
      await ensureTree(this._hass);
      await this.load();
      // Forced: the change has to show, and the dialog has to close, whatever still has the focus.
      this.paint(true);
      if (message) this.flash(message);
    }
    async saveAdminTree(next) {
      await this._hass.callWS({ type: 'optim_energy/tree/save', tree: next, ...(PORTAL.isRoot && portalClient ? { client: portalClient } : {}) });
      setTree(next);
      modelFrom = null;
      syncModel(this._hass);
      await this.afterChange('Saved.');
      // A virtual device adds up what is under it through Sum helpers; make them match the new tree.
      syncSums(this._hass);
    }
    async selectClient(id) {
      if (!PORTAL.isRoot || !id || id === portalClient) return;
      this._users = [];
      this._summaries = [];
      this._selectedLocation = null;
      this._editor = null;
      await switchPortalClient(this._hass, id);
      await this.load();
      // Forced: the dropdown that was just used still has the focus, which would otherwise hold the redraw back.
      this.paint(true);
    }
    async openClientView(client = portalClient, location = null) {
      try {
        if (PORTAL.isRoot && client && client !== portalClient) await switchPortalClient(this._hass, client);
        // The location chosen in Administration, if it is this tenant's; otherwise its first.
        const sites = TREE.places.filter((p) => p.kind === 'location').sort(byName);
        const first = location || sites.find((p) => p.id === this._selectedLocation)?.id || sites[0]?.id || null;
        if (first) setLocation(first);
        navigate(sites.length > 1 && !first ? START_PATH : HOME_PATH);
      } catch (e) { this.flash(e?.message || 'Could not open the tenant view.', true); }
    }
    async saveEditor() {
      const e = this._editor, r = this.shadowRoot;
      if (!e) return;
      const value = (id) => r.getElementById(id)?.value.trim() || '';
      const need = (ok, message) => { if (!ok) this.flash(message, true); return !ok; };
      try {
        if (e.kind === 'confirm') {
          await e.run();
        } else if (e.kind === 'client') {
          const name = value('editorName');
          if (need(name, 'Enter a tenant name.')) return;
          if (e.id) await this._hass.callWS({ type: 'optim_energy/client/update', client: e.id, name });
          else {
            const made = await this._hass.callWS({ type: 'optim_energy/client/create', name });
            portalClient = made.id;
            try { localStorage.setItem(CLIENT_KEY, made.id); } catch (x) { /* private window */ }
          }
          await this.afterChange(e.id ? 'Tenant updated.' : 'Tenant created. Add its locations next.');
        } else if (e.kind === 'location') {
          const name = value('editorName');
          if (need(name, 'Enter a location name.')) return;
          await this._hass.callWS({ type: 'optim_energy/location/save', client: portalClient, name, ...(e.id ? { location: e.id } : {}) });
          await this.afterChange(e.id ? 'Location updated.' : 'Location created.');
        } else if (e.kind === 'assign') {
          const client = value('assignClient'), location = value('assignLocation'), place = value('assignGroup') || location;
          if (need(client && location, 'Choose a tenant and a location.')) return;
          const failed = [];
          for (const id of e.devices) {
            try { await this._hass.callWS({ type: 'optim_energy/device/assign', client, device_id: id, place }); } catch (x) { failed.push(x?.message || 'Could not assign a device.'); }
          }
          this._picked = new Set();
          await this.afterChange(failed.length ? '' : (e.devices.length === 1 ? 'Device assigned.' : `${e.devices.length} devices assigned.`));
          if (failed.length) this.flash(`${failed.length} of ${e.devices.length} not assigned. ${failed[0]}`, true);
        } else if (e.kind === 'group') {
          const name = value('editorName');
          if (need(name, 'Enter a group name.')) return;
          const location = value('groupLocation');
          if (need(location, 'Choose a location.')) return;
          // Who is in the group now, read before anything changes.
          const before = new Set(e.id ? this.deviceRows().filter((d) => !d.virtual && d.place === e.id).map((d) => d.id) : []);
          const saved = await this._hass.callWS({ type: 'optim_energy/group/save', client: portalClient, name, parent: value('groupParent') || location, ...(e.id ? { group: e.id } : {}) });
          const put = (id, place) => this._hass.callWS({ type: 'optim_energy/device/assign', client: portalClient, device_id: id, place });
          for (const id of e.members) if (!before.has(id)) await put(id, saved.id);
          for (const id of before) if (!e.members.has(id)) await put(id, location);
          await this.afterChange(e.id ? 'Group saved.' : 'Group created.');
        } else if (e.kind === 'location-move') {
          const target = value('editorClient');
          if (need(target, 'Choose the tenant to move it to.')) return;
          await this._hass.callWS({ type: 'optim_energy/location/move', client: portalClient, location: e.id, target });
          await this.afterChange(`Location moved to ${(PORTAL.clients || []).find((x) => x.id === target)?.name || target}.`);
        } else if (e.kind === 'person') {
          const role = value('editorRole') || 'user';
          const locs = role === 'client_admin' ? [] : [...r.querySelectorAll('[data-loc-check]:checked')].map((x) => x.dataset.locCheck);
          const password = r.getElementById('editorPassword')?.value || '';
          if (need(value('editorName'), 'Enter the user\'s name.')) return;
          if (!e.user) {
            if (need(value('editorUsername'), 'Enter a username.') || need(password.length >= 8, 'The password needs at least 8 characters.')) return;
            await this._hass.callWS({ type: 'optim_energy/user/create', client: value('personClient') || portalClient, name: value('editorName'), username: value('editorUsername'), password, role, locations: locs });
          } else {
            await this._hass.callWS({ type: 'optim_energy/user/update', user_id: e.user.id, name: value('editorName'), role, locations: locs, ...(password ? { password } : {}) });
          }
          await this.afterChange(e.user ? 'User updated.' : 'User created.');
        } else if (e.kind === 'price') {
          const p = TREE.prices?.[e.loc] || {}, today = new Date().toISOString().slice(0, 10), num = (id) => Number(String(value(id)).replace(',', '.')), r4 = (v) => Math.round(v * 10000) / 10000;
          let patch;
          if (e.mode === 'exchange') {
            const sensor = ibexSensor(this._hass, e.loc), extra = num('priceExtra');
            if (need(sensor, 'No exchange price sensor is available.') || need(extra >= 0 && extra < 5, 'Enter the margin in euros per kWh, for example 0.05.')) return;
            patch = { mode: 'exchange', sensor, extra: r4(extra), vat: true, exchangeSource: { kind: 'typed', read: today } };
          } else if (e.mode === 'fixed') {
            const fixed = num('priceFixed');
            if (need(fixed > 0 && fixed < 5, 'Enter the price per kWh in euros, for example 0.32.')) return;
            patch = { mode: 'fixed', fixed: r4(fixed), fixedSource: { kind: 'typed', read: today } };
          } else if (e.bill?.step === 'done') {
            const b = e.bill, pr = billPrices(b.bill, null), r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
            patch = { mode: 'bill', bill: r4(pr.fixed), billSource: { kind: 'bill', from: b.bill.period_from, to: b.bill.period_to, kwh: b.bill.kwh, total_excl_vat: r2(pr.totalExcl), vat: r2(pr.vat), total_incl_vat: r2(pr.totalIncl), file: b.files, read: today, model: b.model } };
          } else {
            if (need(e.bill?.step !== 'busy', 'The bill is still being read.') || need(Number(p.bill) > 0, 'Upload a bill first.')) return;
            patch = { mode: 'bill' };
          }
          await this.saveAdminTree(treeWithPrice(TREE, e.loc, patch));
        } else if (e.kind === 'device-edit') {
          await this.saveDevice(e.device, value('editorName'), value('deviceGroup') || value('deviceLocation'), value('editorParent') || null, !!r.getElementById('editorMain')?.checked, value('deviceClient') || portalClient);
        } else if (e.kind === 'virtual') {
          const name = value('editorName'), place = value('editorPlace');
          if (need(name && place, 'Enter a name and choose a location.')) return;
          const id = `virt:${Date.now().toString(36)}`;
          await this.saveAdminTree(treeWithDevicePlaced(treeWithVirtual(TREE, name, id), id, place));
        }
      } catch (x) { this.flash(x?.message || 'Could not save the change.', true); }
    }
    // One save for the device dialog: name, tenant, place, parent device, and whether it is the main device.
    async saveDevice(id, name, place, parent, main, tenant = portalClient) {
      const d = this.deviceRows().find((x) => x.id === id);
      if (!d) return;
      if (!name) { this.flash('Enter a name.', true); return; }
      if (parent && wouldLoop(id, parent)) { this.flash('A device cannot be its own parent.', true); return; }
      const named = name !== d.name, moved = !!place && place !== d.place;
      if (!d.virtual && named) {
        await this._hass.callWS(PORTAL.isRoot
          ? { type: 'config/device_registry/update', device_id: id, name_by_user: name }
          : { ...clientArg(), type: 'optim_energy/device/update', device_id: id, name });
      }
      if (!d.virtual && tenant !== portalClient) {
        // To another tenant: one checked command. Its wiring and main-device role stay behind, on the server's side.
        if (!place) { this.flash('Choose a location.', true); return; }
        await this._hass.callWS({ type: 'optim_energy/device/assign', client: tenant, device_id: id, place });
        await this.afterChange('Device moved.');
        return;
      }
      // A real device changes place through the checked command (its area is its location). That reloads the tree.
      if (!d.virtual && moved) {
        await this.assignDevice(id, place);
      }
      // Wiring and the main device decide what a tenant sees, so only an administrator changes them.
      if (!portalCanWire()) { await this.afterChange('Device saved.'); return; }
      let next = TREE;
      if (d.virtual && named) next = { ...next, virtual: next.virtual.map((v) => (v.id === id ? { ...v, name } : v)) };
      if (d.virtual && moved) next = treeWithDevicePlaced(next, id, place);
      if ((next.parents?.[id] || null) !== parent) next = treeWithParent(next, id, parent);
      const site = placePath(place || d.place)[0]?.id, wasMain = !!site && next.mains?.[site] === id;
      if (site && main !== wasMain) next = treeWithLocationMain(next, site, main ? id : null);
      if (next !== TREE) await this.saveAdminTree(next);
      else await this.afterChange('Device saved.');
    }
    // Read an uploaded bill inside the price dialog. Nothing is saved until the price is used.
    async readPriceBill(files) {
      const e = this._editor, again = () => { if (this._editor === e) { this._editorStale = true; this.paintDialog(); } };
      e.bill = { step: 'busy', files: files.map((f) => f.name).join(', ') };
      again();
      try {
        const cfg = await billSettings().catch(() => ({})), read = await readBill(this._hass, files), pr = billPrices(read.bill, null);
        if (!(pr.fixed > 0)) throw new Error('The bill did not give a total and kWh that can make a price.');
        Object.assign(e.bill, { step: 'done', model: cfg.model, ...read });
      } catch (x) { e.bill = { step: 'error', msg: x?.message || String(x) }; }
      again();
    }
    async assignDevice(deviceId, place) {
      const devices = PORTAL.isRoot && Object.keys(this._adminDevices || {}).length ? this._adminDevices : (HASS?.devices || {});
      const device = Object.values(devices).find((x) => x.id === deviceId);
      if (!device) return;
      // One checked command: the server sets the device's area (its location) and its group.
      await this._hass.callWS({ type: 'optim_energy/device/assign', device_id: deviceId, place, ...(PORTAL.isRoot && portalClient ? { client: portalClient } : {}) });
      await this.afterChange('Device moved.');
    }
    async onClick(e) {
      const q = (a) => e.target.closest(a);
      const open = (editor) => { this._editor = editor; this.paint(true); };
      const call = (msg) => this._hass.callWS(msg);
      let b;
      if (q('[data-refresh]')) { await this.refresh(); this.flash('Up to date.'); return; }
      if ((b = q('[data-go]'))) { navigate(b.dataset.go); return; }
      if (q('[data-cancel-editor]')) { this._editor = null; this.paint(true); return; }
      if (q('[data-save-editor]')) { await this.saveEditor(); return; }
      if (q('[data-generate-password]')) {
        // Shown in clear so it can be copied and handed to the person; it is never stored by the portal.
        const box = this.shadowRoot.getElementById('editorPassword'), bytes = crypto.getRandomValues(new Uint8Array(14)), alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
        if (box && this._editor) { this._editor.shown = true; box.type = 'text'; box.value = [...bytes].map((x) => alphabet[x % alphabet.length]).join(''); box.select(); }
        return;
      }
      // Clients
      if ((b = q('[data-open-client]'))) { await this.selectClient(b.dataset.openClient); this._section = 'locations'; navigate('/energy-admin/locations'); return; }
      if ((b = q('[data-preview-client]'))) { await this.openClientView(b.dataset.previewClient); return; }
      if (q('[data-new-client]')) { open({ kind: 'client' }); return; }
      if ((b = q('[data-edit-client]'))) { open({ kind: 'client', id: b.dataset.editClient, name: b.dataset.name }); return; }
      if ((b = q('[data-delete-client]'))) {
        const id = b.dataset.deleteClient, item = (this._summaries || []).find((x) => x.id === id) || {}, name = item.name || id;
        this.confirm(`Delete ${name}?`, `${name} is removed with its ${item.people || 0} ${item.people === 1 ? 'user' : 'users'}, who can no longer sign in. Its devices stay in Home Assistant. This cannot be undone.`, 'Delete tenant', async () => {
          await call({ type: 'optim_energy/client/delete', client: id, delete_users: true });
          portalClient = null; whoLoad = null; treeLoad = null;
          resetPortalTree();
          await this.afterChange(`${name} deleted.`);
        });
        return;
      }
      // Locations and groups
      if (q('[data-new-location]')) { open({ kind: 'location' }); return; }
      if ((b = q('[data-edit-location]'))) { open({ kind: 'location', id: b.dataset.editLocation, name: b.dataset.name }); return; }
      if ((b = q('[data-move-location]'))) { open({ kind: 'location-move', id: b.dataset.moveLocation, name: b.dataset.name }); return; }
      if ((b = q('[data-select-location]'))) { this._selectedLocation = b.dataset.selectLocation; this._q.wiringSearch = ''; this.paint(true); return; }
      if ((b = q('[data-delete-location]'))) {
        const id = b.dataset.deleteLocation, name = placeById(id)?.name || id;
        this.confirm(`Delete ${name}?`, 'The location, its groups and its area in Home Assistant are removed. It has to be empty: no devices and no users assigned. This cannot be undone.', 'Delete location', async () => {
          await call({ type: 'optim_energy/location/delete', client: portalClient, location: id });
          await this.afterChange('Location deleted.');
        });
        return;
      }
      if ((b = q('[data-price]'))) { const mode = TREE.prices?.[b.dataset.price]?.mode; open({ kind: 'price', loc: b.dataset.price, mode: ['bill', 'exchange', 'fixed'].includes(mode) ? mode : 'exchange' }); return; }
      if ((b = q('[data-price-tab]')) && this._editor?.kind === 'price') { this._editor.mode = b.dataset.priceTab; this._editorStale = true; this.paintDialog(); return; }
      if ((b = q('[data-new-group]'))) { open({ kind: 'group', location: b.dataset.newGroup, parent: '', members: new Set() }); return; }
      if ((b = q('[data-edit-group]'))) { const id = b.dataset.editGroup, site = placePath(id)[0]?.id || this._selectedLocation, up = placeById(id)?.parent; open({ kind: 'group', id, name: b.dataset.name, location: site, parent: up && up !== site ? up : '', members: new Set(this.deviceRows().filter((d) => !d.virtual && d.place === id).map((d) => d.id)) }); return; }
      if ((b = q('[data-delete-group]'))) {
        const id = b.dataset.deleteGroup, name = placeById(id)?.name || 'this group';
        this.confirm(`Delete ${name}?`, 'Its devices and any groups inside it move up one level. Nobody loses access.', 'Delete group', async () => {
          await call({ type: 'optim_energy/group/delete', client: portalClient, group: id });
          await this.afterChange('Group deleted.');
        });
        return;
      }
      // People
      if (q('[data-new-person]')) { open({ kind: 'person' }); return; }
      if ((b = q('[data-edit-person]'))) { open({ kind: 'person', user: (this._users || []).find((x) => x.id === b.dataset.editPerson) }); return; }
      if ((b = q('[data-people-role]'))) { this._role = b.dataset.peopleRole; this.paint(true); return; }
      if ((b = q('[data-toggle]'))) {
        const u = this._users?.find((x) => x.id === b.dataset.toggle); if (!u) return;
        const set = async (active) => { await call({ type: 'optim_energy/user/update', user_id: u.id, is_active: active }); await this.afterChange(`${u.name} ${active ? 'enabled' : 'disabled'}.`); };
        if (!u.is_active) { try { await set(true); } catch (x) { this.flash(x?.message || 'Could not update the user.', true); } return; }
        this.confirm(`Disable ${u.name}?`, `${u.name} is signed out everywhere and cannot sign in until enabled again. Nothing is deleted.`, 'Disable', () => set(false));
        return;
      }
      if ((b = q('[data-delete]'))) {
        const u = this._users?.find((x) => x.id === b.dataset.delete); if (!u) return;
        this.confirm(`Delete ${u.name}?`, `The login of ${u.name} is removed. This cannot be undone; to stop access for a while, disable the user instead.`, 'Delete user', async () => {
          await call({ type: 'optim_energy/user/delete', user_id: u.id });
          await this.afterChange('User deleted.');
        });
        return;
      }
      // Devices
      if ((b = q('[data-device-view]'))) { this._deviceView = b.dataset.deviceView; this.paint(true); return; }
      if ((b = q('[data-inbox-filter]'))) { this._inboxFilter = b.dataset.inboxFilter; this.paint(true); return; }
      if (q('[data-clear-picked]')) { this._picked = new Set(); this.paint(true); return; }
      if ((b = q('[data-inbox-assign]'))) { const d = (this._inbox || []).find((x) => x.id === b.dataset.inboxAssign); if (d) open({ kind: 'assign', devices: [d.id], client: d.client || portalClient, location: d.location || this._selectedLocation, group: d.group || '' }); return; }
      if (q('[data-assign-picked]')) { if (this._picked.size) open({ kind: 'assign', devices: [...this._picked], client: portalClient, location: this._selectedLocation, group: '' }); return; }
      if ((b = q('[data-inbox-ignore], [data-inbox-unignore]'))) {
        const ignored = 'inboxIgnore' in b.dataset, id = b.dataset.inboxIgnore || b.dataset.inboxUnignore;
        try { await call({ type: 'optim_energy/device/ignore', device_id: id, ignored }); await this.afterChange(ignored ? 'Device ignored.' : 'Device is no longer ignored.'); } catch (x) { this.flash(x?.message || 'Could not change the device.', true); }
        return;
      }
      if ((b = q('[data-inbox-remove]'))) {
        const d = (this._inbox || []).find((x) => x.id === b.dataset.inboxRemove);
        if (!d) return;
        this.confirm(`Remove ${d.name} from ${d.client_name}?`, `${d.client_name} stops seeing this device at once. The device stays in Home Assistant and goes back to Unassigned.`, 'Remove from tenant', async () => {
          await call({ type: 'optim_energy/device/assign', client: d.client, device_id: d.id });
          await this.afterChange('Device removed from the client.');
        });
        return;
      }
      if (q('[data-new-virtual]')) { open({ kind: 'virtual' }); return; }
      if ((b = q('[data-edit-device]'))) { const at = this.deviceRows().find((x) => x.id === b.dataset.editDevice)?.place, site = placePath(at)[0]?.id || ''; open({ kind: 'device-edit', device: b.dataset.editDevice, location: site, group: at && at !== site ? at : '' }); return; }
      if ((b = q('[data-delete-virtual]'))) {
        const id = b.dataset.deleteVirtual, name = (TREE.virtual || []).find((v) => v.id === id)?.name || 'this virtual device';
        this.confirm(`Delete ${name}?`, 'The virtual device and its sums are removed. The devices under it stay where they are.', 'Delete virtual device', () => this.saveAdminTree(treeWithoutVirtual(TREE, id)));
        return;
      }
    }
    async onChange(e) {
      const t = e.target;
      if (t.id === 'clientSwitch') {
        const was = this._allTenants;
        this._allTenants = t.value === '';
        // "All tenants", or back from it to the tenant that was already open: only the list reloads.
        if (this._allTenants || (was && t.value === portalClient)) { await this.load(); this.paint(true); } else await this.selectClient(t.value);
        return;
      }
      if (t.id === 'billFile' && this._editor?.kind === 'price' && t.files.length) { await this.readPriceBill([...t.files]); return; }
      if (t.id === 'locationSwitch') { this._selectedLocation = t.value || null; this._q.wiringSearch = ''; this.paint(true); return; }
      // A client administrator has no locations of its own, so the list goes when that role is picked.
      if (t.id === 'editorRole' && this._editor?.kind === 'person') { this._editor.role = t.value; this._editorStale = true; this.paintDialog(); return; }
      if (t.dataset.locCheck && this._editor?.kind === 'person') { this._editor.locations = [...this.shadowRoot.querySelectorAll('[data-loc-check]:checked')].map((x) => x.dataset.locCheck); return; }
      if (t.dataset.pick) { if (t.checked) this._picked.add(t.dataset.pick); else this._picked.delete(t.dataset.pick); this.paint(true); return; }
      if (t.dataset.pickAll) { const shown = this.inboxRows().filter((d) => d.status !== 'ignored').map((d) => d.id); this._picked = t.checked ? new Set([...this._picked, ...shown]) : new Set([...this._picked].filter((id) => !shown.includes(id))); this.paint(true); return; }
      // The assign dialog narrows as you go: the client decides the locations, the location its groups.
      if (t.id === 'assignClient' && this._editor) { Object.assign(this._editor, { client: t.value, location: null, group: '' }); this._editorStale = true; this.paintDialog(); return; }
      if (t.id === 'assignLocation' && this._editor) { Object.assign(this._editor, { location: t.value, group: '' }); this._editorStale = true; this.paintDialog(); return; }
      if (t.id === 'assignGroup' && this._editor) { this._editor.group = t.value; return; }
      const again = (changes) => { Object.assign(this._editor, changes); this._editorStale = true; this.paintDialog(); };
      if (t.id === 'groupLocation' && this._editor) { again({ location: t.value, parent: '' }); return; }
      if (t.id === 'groupParent' && this._editor) { this._editor.parent = t.value; return; }
      if (t.dataset.groupDevice && this._editor?.members) {
        if (t.checked) this._editor.members.add(t.dataset.groupDevice); else this._editor.members.delete(t.dataset.groupDevice);
        const boxes = [...this.shadowRoot.querySelectorAll('[data-group-device]')], count = this.shadowRoot.getElementById('groupCount');
        if (count) count.textContent = `${boxes.filter((x) => x.checked).length} of ${boxes.length}`;
        return;
      }
      if (t.id === 'deviceClient' && this._editor) { again({ client: t.value, location: null, group: '' }); return; }
      if (t.id === 'deviceLocation' && this._editor) { again({ location: t.value, group: '' }); return; }
      if (t.id === 'deviceGroup' && this._editor) { this._editor.group = t.value; return; }
      if (t.id === 'personClient' && this._editor) { again({ client: t.value, locations: [] }); }
    }
    onInput(e) {
      const id = e.target.id;
      if (!(id in this._q)) return;
      this._q[id] = e.target.value;
      const at = e.target.selectionStart;
      this.paint(true);
      // Repainting replaces the box being typed in; put the cursor back where it was.
      const box = this.shadowRoot.getElementById(id);
      if (box) { box.focus(); try { box.setSelectionRange(at, at); } catch (x) { /* search boxes may refuse */ } }
    }
  }


    // The bottom bar on phones and tablets: always at the very bottom, small enough to fit every screen.
  const CLIENT_NAV = [['Overview', 'mdi:view-dashboard-outline', HOME_PATH], ['Groups', 'mdi:floor-plan', '/energy-groups/groups'], ['Controls', 'mdi:tune-variant', '/energy-controls/controls'], ['Devices', 'mdi:power-plug-outline', '/energy-devices/topology'], ['Reports', 'mdi:chart-box-outline', '/energy-reports/report'], ['Alerts', 'mdi:bell-outline', '/energy-alerts/alerts'], ['Setup', 'mdi:cog-outline', SETUP_PATH, true]];
  const ADMIN_NAV = [['Tenants', 'mdi:account-group-outline', '/energy-admin/clients'], ['Locations', 'mdi:map-marker-multiple-outline', '/energy-admin/locations'], ['Users', 'mdi:account-multiple-outline', '/energy-admin/people'], ['Devices', 'mdi:power-plug-outline', '/energy-admin/devices']];
class NavCard extends HTMLElement {
    setConfig() {}
    getCardSize() { return 1; }
    getGridOptions() { return { columns: 'full', rows: 1 }; }
    connectedCallback() { if (!this._on) { this._on = () => this.mark(); window.addEventListener('location-changed', this._on); } this.mark(); }
    disconnectedCallback() { window.removeEventListener('location-changed', this._on); this._on = null; }
    set hass(h) {
      this._hass = h;
      syncModel(h);
      ensureTree(h);
      if (!this._built) {
        this._built = true;
        this.attachShadow({ mode: 'open' }).innerHTML = `<style>:host{display:block;height:calc(52px + env(safe-area-inset-bottom,0px))}
nav{position:fixed;left:0;right:0;bottom:0;z-index:5;display:flex;background:var(--card-background-color);border-top:1px solid var(--divider-color);padding-bottom:env(safe-area-inset-bottom,0px);overflow-x:auto;font-family:var(--ha-font-family-body,Roboto,sans-serif)}
a{position:relative;flex:1 1 0;min-width:0;display:grid;justify-items:center;gap:2px;padding:7px 0 6px;color:var(--secondary-text-color);font-size:9.5px;line-height:1.1;text-decoration:none;white-space:nowrap;-webkit-tap-highlight-color:transparent}a.on{color:var(--primary-color);font-weight:600}a:focus-visible{outline:2px solid var(--primary-color);outline-offset:-2px}ha-icon{--mdc-icon-size:21px;display:block;height:21px}
i{position:absolute;top:3px;left:calc(50% + 5px);min-width:14px;height:14px;border-radius:7px;padding:0 3px;box-sizing:border-box;background:var(--error-color);color:#fff;font:600 9px/14px var(--ha-font-family-body,Roboto,sans-serif);text-align:center}i:empty{display:none}
@media(min-width:871px){:host{display:none}}</style><nav></nav>`;
        this.shadowRoot.querySelector('nav').addEventListener('click', (e) => { const a = e.target.closest('a'); if (a) { e.preventDefault(); if (a.dataset.p === '/energy-reports/report') openLocationReport(); navigate(a.dataset.p); this.mark(); } });
        this.mark();
      }
      const nav = !PORTAL.isRoot ? CLIENT_NAV : previewing() ? [['Admin', 'mdi:shield-account-outline', ADMIN_HOME_PATH], ...CLIENT_NAV] : ADMIN_NAV, navKey = nav.map((x) => x.join(':')).join('|');
      if (this._navKey !== navKey) { this._navKey = navKey; const el = this.shadowRoot.querySelector('nav'); if (el) el.innerHTML = nav.filter((x) => !x[3] || portalCanManage()).map(([n, icon, p]) => `<a href="${p}" data-p="${p}"><ha-icon icon="${icon}"></ha-icon>${n}${n === 'Alerts' ? '<i id="count"></i>' : ''}</a>`).join(''); this.mark(); }
      if (!this._counted || Date.now() - this._counted > 15000) {
        this._counted = Date.now();
        const n = computeActive(h.states, this._counted).filter((a) => a.sev !== 'info').length, c = this.shadowRoot.getElementById('count');
        if (c) c.textContent = n || '';
      }
    }
    // The first part of the address says which screen this is, whichever tab is open.
    mark() {
      const here = location.pathname.split('/')[1];
      this.shadowRoot?.querySelectorAll('a').forEach((a) => { const on = a.dataset.p.split('/')[1] === here; a.classList.toggle('on', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    }
  }
  // A live map. Lines carry the power, thicker and faster as more flows; a device that drops out turns red at once, and a folded branch still says so.
  class TopologyCard extends Base {
    get paintEvery() { return 2000; }
    async refresh() { try { this._totals = await portalTotals(this._hass); } catch (e) { /* the map only needs live readings */ } this.paint(); }
    startTimer() { this._t = setInterval(() => this.refresh(), 60000); }
    build() {
      this._mode = 'network'; this._by = 'group'; this._view = { x: 0, y: 0, k: 1 };
      this.shadowRoot.innerHTML = `<style>${BASE}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.seg{display:inline-flex;border:1px solid var(--line);border-radius:6px;overflow:hidden}.seg button{all:unset;cursor:pointer;font-size:13px;padding:6px 12px;color:var(--muted)}.seg button.on{background:color-mix(in srgb,var(--accent) 18%,transparent);color:var(--fg)}.seg button:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}.bar .sp{flex:1}.bar button.i{min-width:34px;padding:6px 8px;font-size:13px}
.sum{font-size:13px;color:var(--muted)}.sum b{font-weight:500;color:var(--bad)}
.canvas{position:relative;height:max(460px,calc(100vh - 250px));background:radial-gradient(circle at 50% 50%,color-mix(in srgb,var(--accent) 13%,var(--panel)),var(--panel) 72%);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
@media(max-width:870px){.canvas{height:60vh}}
svg{display:block;width:100%;height:100%;touch-action:none;cursor:grab;user-select:none;font-family:var(--ha-font-family-body,Roboto,sans-serif)}svg.drag{cursor:grabbing}
.n rect.c{fill:var(--page);stroke:var(--line);stroke-width:1}.n{cursor:pointer}.n:hover rect.c{stroke:var(--muted)}.n.main rect.c{stroke:var(--accent);stroke-width:2}.n.virtual rect.c{stroke-dasharray:5 3;stroke:var(--muted)}.n.location rect.c,.n.hub rect.c{fill:color-mix(in srgb,var(--accent) 14%,var(--page));stroke:var(--accent)}.n.location,.n.hub{cursor:default}.n.down rect.c{stroke:var(--bad);stroke-width:2;fill:color-mix(in srgb,var(--bad) 12%,var(--page))}.n.below rect.c{stroke:var(--warn)}.n:focus-visible rect.c{stroke:var(--accent);stroke-width:3}.n:focus{outline:none}
.nm{fill:var(--fg);font-size:13px;font-weight:500}.st{fill:var(--muted);font-size:11px}.pw{fill:var(--fg);font-size:13px;font-variant-numeric:tabular-nums}
circle.d{fill:var(--slate)}circle.d.ok{fill:var(--ok)}circle.d.warn{fill:var(--warn)}circle.d.bad{fill:var(--bad)}
.f{cursor:pointer}.f circle{fill:var(--panel);stroke:var(--muted)}.f:hover circle{stroke:var(--fg)}.f text{fill:var(--fg);font-size:14px;text-anchor:middle}.f:focus{outline:none}.f:focus-visible circle{stroke:var(--accent);stroke-width:2}
path.l{fill:none;stroke:var(--muted);opacity:.45;stroke-width:1.5}path.l.flow{stroke:var(--accent);opacity:.95;stroke-dasharray:7 9;animation:run 2s linear infinite}path.l.dead{stroke:var(--bad);opacity:.9;stroke-dasharray:3 5}
.chips{display:flex;gap:6px;flex-wrap:wrap}.chip{display:inline-flex;gap:6px;align-items:center;font-size:12.5px;color:var(--fg);padding:3px 10px;border:1px solid var(--line);border-radius:12px;background:var(--panel);white-space:nowrap}.chip i{width:8px;height:8px;border-radius:50%;background:var(--slate)}.chip i.ok{background:var(--ok)}.chip i.warn{background:var(--warn)}.chip i.bad{background:var(--bad)}.chip i.power{background:var(--accent)}
.r{cursor:pointer}.r:focus{outline:none}.r .ring{fill:var(--panel);stroke:var(--slate);stroke-width:1.5}.r.ok .ring{stroke:var(--ok)}.r.warn .ring{stroke:var(--warn)}.r.bad .ring{stroke:var(--bad);stroke-width:2.5;fill:color-mix(in srgb,var(--bad) 22%,var(--panel))}.r:hover .ring,.r:focus-visible .ring{stroke-width:3}.r .ic{fill:var(--fg)}.r.ok .ic{fill:var(--ok)}.r.warn .ic{fill:var(--warn)}.r.bad .ic{fill:var(--bad)}.r.hub .ic,.r.location .ic,.r.virtual .ic,.r.main .ic{fill:var(--fg)}.r.main .ring{stroke-width:3.5}.r.virtual .ring{stroke-dasharray:3 3}.fb{cursor:pointer}.fb circle{fill:var(--panel);stroke:var(--muted);stroke-width:1.2}.fb:hover circle,.fb:focus-visible circle{stroke:var(--accent);stroke-width:2}.fb text{font-size:12px;font-weight:700;fill:var(--fg);text-anchor:middle;stroke:none}.r.location .ring{fill:color-mix(in srgb,var(--accent) 30%,var(--panel));stroke:var(--accent);stroke-width:2.5}.r.location{cursor:default}
.r text{font-size:12px;fill:var(--muted);paint-order:stroke;stroke:var(--panel);stroke-width:3px;stroke-linejoin:round}.r text.hn{font-size:13px;font-weight:600;fill:var(--fg);text-anchor:middle}.r text.hs{text-anchor:middle}.r text.ln{fill:var(--fg)}.r.bad text.ln{fill:var(--bad)}.r .more{fill:var(--accent);font-size:11px;text-anchor:middle}
path.l.talk{stroke:var(--ok);opacity:.75;stroke-dasharray:5 6;animation:run 2.4s linear infinite}path.l.talk.hubl{stroke-width:2;opacity:.9}path.l.warnl{stroke:var(--warn);opacity:.9}
@keyframes run{to{stroke-dashoffset:-32}}@media(prefers-reduced-motion:reduce){path.l.flow,path.l.talk{animation:none}}
.key{display:flex;gap:6px 16px;flex-wrap:wrap;font-size:12px;color:var(--muted)}.key i{display:inline-block;vertical-align:middle;margin-right:5px;width:18px;height:0;border-top:3px solid var(--accent)}.key i.off{border-color:var(--muted);opacity:.5;border-top-width:1px}.key i.bad{border-color:var(--bad);border-top-style:dashed}
</style><div class="w"><div class="bar"><div class="seg" id="mode" role="group" aria-label="What the map shows"><button data-mode="network" aria-pressed="true" class="on" title="How each device is connected and whether it is online">Connection</button><button data-mode="wiring" aria-pressed="false" title="Where the power goes, live">Power</button></div><div class="seg" id="by" role="group" aria-label="How the map is arranged"><button data-by="group" aria-pressed="true" class="on" title="Arranged by the location's groups">By group</button><button data-by="device" aria-pressed="false" title="Arranged by parent devices">By device</button></div><span class="chips" id="sum"></span><span class="sp"></span><button class="i" data-all="open">Expand all</button><button class="i" data-all="shut">Collapse all</button><button class="i" data-zoom="1.25" aria-label="Zoom in">+</button><button class="i" data-zoom="0.8" aria-label="Zoom out">−</button><button class="i" data-fit="1">Fit</button></div><div class="canvas" id="canvas"><svg id="svg" role="img" aria-label="Live map of the devices"><g id="world"></g></svg></div><div class="key" id="key"></div><div class="drawer" id="drawer" hidden></div></div>`;
      const r = this.shadowRoot;
      r.querySelector('.bar').addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.mode) { this._mode = b.dataset.mode; this._shut = null; this._sig = null; this._lastMode = null; this.paint(); }
        if (b.dataset.by) { this._by = b.dataset.by; this._shut = null; this._sig = null; this._lastMode = null; this.paint(); }
        if (b.dataset.all) { this._shut = b.dataset.all === 'open' ? new Set() : allParents(this.tree()); if (this.radial) this._shut.delete('root'); this._sig = null; this.paint(); }
        if (b.dataset.zoom) { const c = r.getElementById('canvas'); this.zoomAt(Number(b.dataset.zoom), c.clientWidth / 2, c.clientHeight / 2); }
        if (b.dataset.fit) this.fit();
      });
      const svg = r.getElementById('svg');
      const act = (t) => {
        const f = t.closest('[data-fold]');
        if (f) { const id = f.dataset.fold; if (this._shut.has(id)) this._shut.delete(id); else this._shut.add(id); this._sig = null; this.paint(); return; }
        const n = t.closest('[data-open]');
        if (n) { this._open = n.dataset.open; this.paint(); }
      };
      svg.addEventListener('click', (e) => { if (!this._dragged) act(e.target); this._dragged = false; });
      svg.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(e.target); } });
      this.panZoom(svg);
      r.getElementById('drawer').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) { this._open = null; this.paint(); return; } const g = e.target.closest('[data-report]'); if (g) goToReport(g.dataset.report); });
      // Stays fitted when the window changes or a phone turns, until someone moves the map themselves.
      new ResizeObserver(() => { const c = r.getElementById('canvas'); if (c.clientWidth && this._layout && !this._moved) this.fit(); }).observe(r.getElementById('canvas'));
      this.startTimer();
    }
    // The circle suits groups with their devices around them; power, and any device hierarchy, is a tree.
    get radial() { return this._mode === 'network'; }
    tree() {
      const now = Date.now(), st = this._hass.states, group = this._by === 'group';
      if (this._mode === 'wiring') return group ? groupTree(st, now, true) : wiringTree(st, now);
      return group ? groupTree(st, now, false) : deviceConnectionTree(st, now);
    }
    apply() { const v = this._view; this.shadowRoot.getElementById('world').setAttribute('transform', `translate(${v.x} ${v.y}) scale(${v.k})`); }
    zoomAt(by, cx, cy) { this._moved = true; const v = this._view, k = Math.min(2.5, Math.max(0.2, v.k * by)), f = k / v.k; v.x = cx - (cx - v.x) * f; v.y = cy - (cy - v.y) * f; v.k = k; this.apply(); }
    // Whole map when it fits at a readable size; otherwise start at the top left and let people move around.
    fit() {
      this._moved = false;
      const c = this.shadowRoot.getElementById('canvas'), L = this._layout, pad = 20;
      if (!L || !c.clientWidth) return;
      const k = Math.min(1, Math.max(this.radial ? (c.clientWidth < 600 ? 0.55 : 0.28) : 0.6, Math.min((c.clientWidth - pad * 2) / L.width, (c.clientHeight - pad * 2) / L.height)));
      this._view = { k, x: L.width * k + pad * 2 <= c.clientWidth || this.radial ? (c.clientWidth - L.width * k) / 2 : pad, y: L.height * k + pad * 2 <= c.clientHeight || this.radial ? (c.clientHeight - L.height * k) / 2 : pad };
      this.apply();
    }
    panZoom(svg) {
      const pts = new Map();
      let spread = 0;
      svg.addEventListener('pointerdown', (e) => { pts.set(e.pointerId, [e.clientX, e.clientY]); this._dragged = false; spread = 0; });
      svg.addEventListener('pointermove', (e) => {
        const was = pts.get(e.pointerId);
        if (!was) return;
        const dx = e.clientX - was[0], dy = e.clientY - was[1];
        if (pts.size === 1) {
          if (!this._dragged && Math.hypot(dx, dy) < 4) return;
          this._dragged = true;
          svg.classList.add('drag');
          this._moved = true;
          this._view.x += dx; this._view.y += dy;
          pts.set(e.pointerId, [e.clientX, e.clientY]);
          this.apply();
          return;
        }
        pts.set(e.pointerId, [e.clientX, e.clientY]);
        const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]), box = svg.getBoundingClientRect();
        this._dragged = true;
        if (spread) this.zoomAt(d / spread, (a[0] + b[0]) / 2 - box.left, (a[1] + b[1]) / 2 - box.top);
        spread = d;
      });
      const end = (e) => { pts.delete(e.pointerId); spread = 0; svg.classList.remove('drag'); };
      svg.addEventListener('pointerup', end);
      svg.addEventListener('pointercancel', end);
      svg.addEventListener('pointerleave', end);
      svg.addEventListener('wheel', (e) => { e.preventDefault(); const box = svg.getBoundingClientRect(); this.zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - box.left, e.clientY - box.top); }, { passive: false });
    }
    // The map is only redrawn when its shape changes. Live values are written into it, so the moving lines never restart.
    paint() {
      const r = this.shadowRoot, st = this._hass.states, now = Date.now(), root = this.tree(), byId = new Map(), wiring = this._mode === 'wiring';
      // A device hierarchy opens three levels deep; the rest unfolds with the + on a device.
      if (!this._shut) this._shut = this.radial && this._by === 'group' ? new Set() : shutNodes(root);
      const index = (n) => { byId.set(n.id, n); n.kids.forEach(index); };
      index(root);
      r.querySelectorAll('#mode button').forEach((b) => { const on = b.dataset.mode === this._mode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
      r.querySelectorAll('#by button').forEach((b) => { const on = b.dataset.by === this._by; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
      if (this.radial) this.paintRadial(root); else this.paintWiring(root, wiring);
      const all = [...byId.values()].filter((n) => n.real), off = all.filter((n) => n.down), late = all.filter((n) => !n.down && n.key === 'warn'), on = all.filter((n) => Math.abs(n.w || 0) >= 1 && !n.down);
      const chip = (cls, text) => `<span class="chip"><i class="${cls}"></i>${text}</span>`;
      const chips = [chip('ok', `${all.length - off.length - late.length} Online`), ...(late.length ? [chip('warn', `${late.length} Delayed`)] : []), chip('bad', `${off.length} Offline`), chip('power', `${on.length} Drawing power`)].join('');
      if (r.getElementById('sum').innerHTML !== chips) r.getElementById('sum').innerHTML = chips;
      const key = !wiring && this._by === 'device' ? '<span><i style="border-color:var(--ok);border-top-style:dashed"></i>Animated line: online and talking</span><span><i class="bad"></i>Offline</span><span>Each ring is one level of parent devices. Tap a device for details, + to show what is under it</span>' : wiring ? '<span><i></i>Power flowing, thicker and faster when higher</span><span><i class="off"></i>No live usage</span><span><i class="bad"></i>Offline</span><span>Tap a device for details</span>' : `<span><i style="border-color:var(--ok);border-top-style:dashed"></i>Animated line: online and talking</span><span><i class="bad"></i>Offline</span><span>Tap a device for details, tap a group to fold it</span>`;
      if (r.getElementById('key').innerHTML !== key) r.getElementById('key').innerHTML = key;
      const dr = r.getElementById('drawer'), open = DEVICES.find((d) => d.id === this._open);
      dr.hidden = !open;
      const sig = open && `${open.id}:${Math.floor(now / 10000)}:${kindOf(open)}`;
      if (open && this._openPainted !== sig) { this._openPainted = sig; paintDrawer(this, dr, drawerHtml(open, st, now, this._totals)); }
    }
    // Drawn once for each shape. Live values are written in, so the moving lines never restart.
    paintRadial(root) {
      const r = this.shadowRoot, rings = this._by === 'device', L = rings ? ringLayout(root, this._shut) : radialLayout(root, this._shut), trim = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t), byId = new Map(L.nodes.map((m) => [m.node.id, m]));
      const sig = ['radial', this._by, [...this._shut].join(','), ...L.nodes.map((m) => `${m.node.id}:${m.node.name}:${Math.round(m.x)}:${Math.round(m.y)}:${m.node.kids.length}`)].join('|');
      if (sig !== this._sig) {
        this._sig = sig; this._lastMode = this._mode; this._layout = L;
        const holds = (n) => n.kids.length > 0 || n.virtual, radius = (n) => (n.kind === 'location' ? 30 : n.kind === 'hub' ? 22 : holds(n) ? 16 : 13);
        const links = L.links.map((l) => { const ra = radius(l.from.node), rb = radius(l.to.node), dx = l.to.x - l.from.x, dy = l.to.y - l.from.y, d = Math.hypot(dx, dy) || 1; return `<path class="l" data-to="${l.to.node.id}" d="M${l.from.x + (dx / d) * ra} ${l.from.y + (dy / d) * ra}L${l.to.x - (dx / d) * rb} ${l.to.y - (dy / d) * rb}"/>`; }).join('');
        const icon = (name, size) => `<path class="ic" transform="translate(${-size / 2} ${-size / 2}) scale(${size / 24})" d="${TOPO_ICONS[name]}"/>`;
        const nodes = L.nodes.map((m) => {
          const n = m.node, label = esc(n.name);
          if (n.kind === 'location') return `<g class="r location" data-id="root" transform="translate(${m.x} ${m.y})"><title>${label}</title><circle class="ring" r="30"/>${icon('location', 32)}<text class="hn" y="48">${esc(trim(n.name, 28))}</text><text class="hs" y="63">${esc(n.sub)}</text></g>`;
          if (n.kind === 'hub') { const foldable = n.kids.length > 0; return `<g class="r hub" data-id="${n.id}"${foldable ? ` data-fold="${n.id}" role="button" tabindex="0" aria-label="Fold ${label}"` : ''} transform="translate(${m.x} ${m.y})"><title>${label}</title><circle class="ring" r="22"/>${icon('hub', 22)}<text class="hn" y="38">${esc(trim(n.name, 24))}</text><text class="hs" y="52"></text></g>`; }
          const deg = (m.dir * 180) / Math.PI, left = Math.cos(m.dir) < 0;
          // A device that carries others: still a device, with a + or − beside it for what is under it, and
          // its name under it, upright, as a group has.
          if (holds(n)) { const shutNow = this._shut.has(n.id), fold = n.kids.length ? `<g class="fb" data-fold="${n.id}" role="button" tabindex="0" aria-label="${shutNow ? 'Show' : 'Hide'} devices under ${label}" transform="translate(17 -13)"><circle r="8"/><text y="4">${shutNow ? '+' : '−'}</text></g>` : ''; return `<g class="r" data-id="${n.id}" transform="translate(${m.x} ${m.y})"><g data-open="${n.id}" role="button" tabindex="0" aria-label="${label}"><title>${label}</title><circle class="ring" r="16"/>${icon(n.icon, 17)}<text class="hn" y="33">${esc(trim(n.name, 22))}</text></g>${fold}</g>`; }
          return `<g class="r" data-id="${n.id}" data-open="${n.id}" role="button" tabindex="0" aria-label="${label}" transform="translate(${m.x} ${m.y})"><title>${label}</title><circle class="ring" r="13"/>${icon(n.icon, 15)}<text class="ln" transform="rotate(${left ? deg + 180 : deg})" x="${left ? -18 : 18}" y="4" text-anchor="${left ? 'end' : 'start'}">${esc(trim(n.name, 18))}</text></g>`;
        }).join('');
        r.getElementById('world').innerHTML = links + nodes;
        // Folding reshapes the whole circle, so it is fitted again each time.
        this._fitted = !!r.getElementById('canvas').clientWidth;
        this.fit();
      }
      for (const [id, m] of byId) {
        const n = m.node, g = r.querySelector(`[data-id="${CSS.escape(id)}"]`);
        if (!g) continue;
        const shut = this._shut.has(id) && n.kids.length > 0, hubLike = n.kind === 'hub', base = `r${n.kind === 'location' ? ' location' : hubLike ? ' hub' : n.kind === 'main' ? ' main' : n.virtual ? ' virtual' : ''} ${n.key}`;
        if (g.getAttribute('class') !== base) g.setAttribute('class', base);
        if (hubLike) g.querySelector('.hs').textContent = shut ? `${n.sub}, folded${downUnder(n) ? `, ${downUnder(n)} offline` : ''}` : n.sub;
        if (n.device && g.querySelector('title')) g.querySelector('title').textContent = `${n.name}, ${n.down ? 'Offline' : n.w == null ? 'No reading' : powerText(n.w)}${n.sub ? `, ${n.sub}` : ''}`;
        const p = r.querySelector(`path[data-to="${CSS.escape(id)}"]`);
        if (p) { const c = `l${hubLike ? ' hubl' : ''}${n.down ? ' dead' : n.key === 'warn' ? ' warnl' : ' talk'}`; if (p.getAttribute('class') !== c) p.setAttribute('class', c); }
      }
    }
    // The tree. With power, a line is as thick and as fast as what flows through it; without, it says whether the device is talking.
    paintWiring(root, power = true) {
      const r = this.shadowRoot, wiring = power, byId = new Map(), index = (n) => { byId.set(n.id, n); n.kids.forEach(index); };
      index(root);
      const L = layoutTree(root, this._shut), { w, h } = L.size, trim = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
      const sig = [this._mode, this._by, ...L.nodes.map((m) => `${m.node.id}:${m.node.name}:${m.x}:${m.y}:${m.node.kids.length}`)].join('|');
      if (sig !== this._sig) {
        const first = this._mode !== this._lastMode;
        this._sig = sig; this._lastMode = this._mode; this._layout = L;
        const links = L.links.map((l) => { const x1 = l.from.x + w + 11, y1 = l.from.y + h / 2, x2 = l.to.x, y2 = l.to.y + h / 2, mx = (x1 + x2) / 2; return `<path class="l" data-to="${l.to.node.id}" d="M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}"/>`; }).join('');
        const nodes = L.nodes.map((m) => {
          const n = m.node, shut = this._shut.has(n.id), label = esc(n.name);
          const fold = n.kids.length ? `<g class="f" data-fold="${n.id}" role="button" tabindex="0" aria-label="${shut ? 'Show' : 'Hide'} devices under ${label}" transform="translate(${w} ${h / 2})"><circle r="11"/><text y="5">${shut ? '+' : '−'}</text></g>` : '';
          return `<g class="n ${n.kind}" data-id="${n.id}"${n.device ? ` data-open="${n.id}" role="button" tabindex="0" aria-label="${label}"` : ''} transform="translate(${m.x} ${m.y})"><title>${label}</title><rect class="c" width="${w}" height="${h}" rx="8"/><circle class="d" cx="14" cy="17" r="4"/><text class="nm" x="24" y="21">${esc(trim(n.name, 27))}</text><text class="st" x="14" y="39"></text><text class="pw" x="${w - 16}" y="39" text-anchor="end"></text>${fold}</g>`;
        }).join('');
        r.getElementById('world').innerHTML = links + nodes;
        if (first) { this._fitted = !!r.getElementById('canvas').clientWidth; this.fit(); }
      }
      // Live values.
      const flows = L.nodes.filter((m) => m.depth > 0).map((m) => Math.abs(m.node.w || 0)), top = Math.max(1, ...flows);
      for (const m of L.nodes) {
        const n = m.node, g = r.querySelector(`[data-id="${CSS.escape(n.id)}"]`);
        if (!g) continue;
        const shut = this._shut.has(n.id), more = shut ? countUnder(n) : 0, bad = shut ? downUnder(n) : 0, text = `${n.down && n.device ? 'Offline' : n.sub}${more ? ` · +${more}` : ''}`;
        g.classList.toggle('down', n.down);
        g.classList.toggle('below', bad > 0);
        g.querySelector('.d').setAttribute('class', `d ${n.key}`);
        g.querySelector('.st').textContent = trim(bad ? `${bad} offline · +${more}` : text, 26);
        g.querySelector('.pw').textContent = !power || n.w == null ? '' : powerText(n.w);
        const p = r.querySelector(`path[data-to="${CSS.escape(n.id)}"]`);
        if (!p) continue;
        if (!power) { p.setAttribute('class', `l${n.down ? ' dead' : n.key === 'warn' ? ' warnl' : n.key === 'ok' ? ' talk' : ''}`); p.style.strokeWidth = ''; p.style.animationDuration = ''; continue; }
        const a = Math.abs(n.w || 0), flowing = wiring && !n.down && a >= 1;
        p.setAttribute('class', `l${n.down ? ' dead' : flowing ? ' flow' : ''}`);
        p.style.strokeWidth = flowing ? `${(1.5 + 5.5 * Math.sqrt(a / top)).toFixed(1)}px` : '';
        p.style.animationDuration = flowing ? `${Math.max(0.5, 3.5 - 0.8 * Math.log10(Math.max(a, 1))).toFixed(2)}s` : '';
      }
    }
  }
  reg('building-topology-card', TopologyCard, 'Topology');
  reg('building-home-card', HomeCard, 'Home');
  reg('building-admin-table-card', AdminTableCard, 'Administration (table view)');
  reg('energy-nav-card', NavCard, 'Bottom bar');
  reg('building-device-map-card', DeviceMapCard, 'Device map');
  reg('building-portal-start-card', PortalStartCard, 'Portal start');
  reg('building-location-picker-card', LocationPickerCard, 'Choose a location');
  reg('building-schedules-card', SchedulesCard, 'Automations');
  reg('building-alert-rules-card', AlertRulesCard, 'Alert rules');
  reg('building-controls-card', ControlsCard, 'Controls');
  reg('building-3d-card', Building3dCard, '3D view');
  reg('building-alerts-card', AlertsCard, 'Building alerts');
}

if (typeof module !== 'undefined') module.exports = { loadPriceMemory, priceStatus, billPrices, billKind, billPages, parseBill, exchangeRows, billExtra, dayStartMs, priceRule, vatNote, chartPrice, priceList, priceSeries, pricePanel, combineTotals, priceOf, treeWithPrice, ruleAutomation, ruleTargets, ruleAutoId, autoRuns, whenShort, autoTitle, sumPlan, parseSchedule, serverPlaces, nativePlaced, adminDeviceCatalog, spreadCatchUp, statGaps, cfgSwitches, guessControls, kindOf, typeLabel, scheduleConfig, daysText, groupSwitches, liveSwitches, isKept, layoutRooms, radialLayout, layoutTree, wiringTree, networkTree, countUnder, downUnder, shutNodes, shutBelow, allParents, alarmRules, energyChart, chartBox, treeWithLocationMain, valueText, nowPanel, powerText, isMeasuring, setLocation, placesUnder, placePath, placeParts, placeLabel, flatPlaces, placedDevices, treeWithDevicePlaced, setTree, TREE, rootsIn, countedIn, readingsOf, homeDevices, buildingRoots, subtreeOf, nodeEnergy, unmeasuredOf, breakdownRows, wouldLoop, treeWithParent, treeWithMain, treeWithVirtual, treeWithoutVirtual, qualityRows, syncModel, portalModel, devicePower, withLiveHour, liveReadings, combineTotals, hourSoFar, mergeEnergy, spacePower, controlChanged, ALERT_SETTINGS, assessAlarm, worstIn, valueAt, groupAlarms, networkSummary, alertsHtml, resolveSpace, inSpace, devicesIn, deviceHealth, bucketEnergy, computeActive, alarmPeriods, alarmInfo, networkRestarts, duration, hourTip, deviceStatus, filterDevices, minutes, DEVICES, BRIDGE };
