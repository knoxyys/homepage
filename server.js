// Home board server. Setup: npm install gtfs-realtime-bindings   then: node server.js   (Node 18+)
// Same approach as your Flask app: GTFS-realtime trip updates + vehicle positions, local static GTFS, fleet list.
require('dotenv').config();
const http = require('http'), fs = require('fs'), path = require('path'), readline = require('readline');
const { transit_realtime } = require('gtfs-realtime-bindings');

// ---- Edit these -------------------------------------------------------
const C = {
  PORT: 3000,
  API_KEY: process.env.TFNSW_API_KEY || '',
  STOP_IDS: (process.env.STOP_IDS || '2567173,2567200').split(',').map(x => x.trim()),
  GTFS_DIR: './data/agency_data',
  FLEET_FILE: process.env.FLEET_FILE || './data/bus_fleet_data.json',
  PHOTO_DIR: process.env.PHOTO_DIR || './static/photos',
  LAT: parseFloat(process.env.LAT || '-34.031021'),
  LON: parseFloat(process.env.LON || '150.747510'),
  WALK_MINS: 5,
  WIFI_SSID: process.env.WIFI_SSID || 'SSID',
  WIFI_PASS: process.env.WIFI_PASS || 'PASS',
  REFRESH_SECS: 15,
};
// -----------------------------------------------------------------------

const S = { ready: false, stopTimes: [], trips: new Map(), routes: new Map(), services: new Map(), exceptions: new Map(), stops: new Map(), shapes: new Map(), group: new Map(), patterns: new Map(), pstops: new Map() };
const RT = { byTrip: new Map(), at: 0, entities: 0, error: '' };   // realtime trip updates
const POS = { byTrip: new Map(), at: 0, entities: 0, error: '' };  // vehicle positions
let lastStats = {};                          // counters from the last departures calculation (for debugging)
let fleet = {};
try { fleet = JSON.parse(fs.readFileSync(C.FLEET_FILE, 'utf8')); } catch { console.log('No fleet list found, skipping fleet info'); }

// ---------- static GTFS (only the rows for your stops, so it loads fast and stays small) ----------
function splitCsv(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur); return out;
}
async function eachRow(file, fn, prefilter) {
  if (!fs.existsSync(file)) return;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let head = null;
  for await (const raw of rl) {
    if (!raw) continue;
    if (!head) { head = splitCsv(raw.replace(/^\uFEFF/, '')); continue; }
    if (prefilter && !prefilter(raw)) continue;
    const cols = splitCsv(raw), row = {};
    head.forEach((h, i) => { row[h] = cols[i]; });
    fn(row);
  }
}
const k = (dir, id) => path.basename(dir) + '|' + id;   // ids are only unique within one agency folder
const secs = t => { const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + s; };

async function loadStatic() {
  const wanted = new Set(C.STOP_IDS.map(s => s.trim())), tripIds = new Set(), configured = new Set(wanted);
  const agencies = fs.readdirSync(C.GTFS_DIR).map(a => path.join(C.GTFS_DIR, a)).filter(p => fs.statSync(p).isDirectory());
  // Pass 1: find your stop(s), plus any child platforms whose parent_station is one of them
  for (const dir of agencies) {
    await eachRow(path.join(dir, 'stops.txt'), r => {
      if (wanted.has(r.stop_id) || (r.parent_station && wanted.has(r.parent_station))) {
        wanted.add(r.stop_id);
        S.group.set(r.stop_id, configured.has(r.stop_id) ? r.stop_id : (S.group.get(r.parent_station) || r.parent_station));
        S.stops.set(r.stop_id, { name: r.stop_name, lat: +r.stop_lat, lon: +r.stop_lon });
      }
    });
  }
  console.log('Matching stop ids:', [...wanted].join(', '));
  S.wantedIds = [...wanted];
  // Pass 2: stop_times for those stops (prefilter tolerates quoted ids and is only a speed-up)
  const stopRe = new RegExp('(^|[,"])(' + [...wanted].join('|') + ')([",]|$)');
  let scanned = 0, sample = '';
  for (const dir of agencies) {
    await eachRow(path.join(dir, 'stop_times.txt'), r => {
      const t = r.departure_time || r.arrival_time;
      if (!wanted.has(r.stop_id) || !t) return;
      S.stopTimes.push({ trip: r.trip_id, stop: r.stop_id, seq: +r.stop_sequence, dep: secs(t) });
      tripIds.add(r.trip_id);
    }, l => { scanned++; if (!sample) sample = l; return stopRe.test(l); });
  }
  console.log(`stop_times: scanned ${scanned} rows, ${S.stopTimes.length} matched. First row seen: ${sample}`);
  // Pass 2b: every stop on each of those trips (for the stopping pattern in the bus sidebar)
  const patStops = new Set();
  for (const dir of agencies) {
    await eachRow(path.join(dir, 'stop_times.txt'), r => {
      const t = r.departure_time || r.arrival_time;
      if (!t) return;
      if (!S.patterns.has(r.trip_id)) S.patterns.set(r.trip_id, []);
      S.patterns.get(r.trip_id).push({ stop: r.stop_id, seq: +r.stop_sequence, dep: secs(t) });
      patStops.add(r.stop_id);
    }, l => tripIds.has(l.slice(0, l.indexOf(',')).replace(/"/g, '')));
  }
  for (const rows of S.patterns.values()) rows.sort((a, b) => a.seq - b.seq);
  for (const dir of agencies) {
    await eachRow(path.join(dir, 'stops.txt'), r => { if (patStops.has(r.stop_id)) S.pstops.set(r.stop_id, { name: r.stop_name, lat: +r.stop_lat, lon: +r.stop_lon }); });
  }
  for (const dir of agencies) {
    await eachRow(path.join(dir, 'trips.txt'), r => { if (tripIds.has(r.trip_id)) S.trips.set(r.trip_id, { route: k(dir, r.route_id), service: k(dir, r.service_id), head: r.trip_headsign, shape: r.shape_id ? k(dir, r.shape_id) : '' }); });
    await eachRow(path.join(dir, 'routes.txt'), r => S.routes.set(k(dir, r.route_id), r.route_short_name || r.route_id));
    await eachRow(path.join(dir, 'calendar.txt'), r => S.services.set(k(dir, r.service_id), {
      start: r.start_date, end: r.end_date,
      days: [r.sunday, r.monday, r.tuesday, r.wednesday, r.thursday, r.friday, r.saturday].map(v => v === '1'),
    }));
    await eachRow(path.join(dir, 'calendar_dates.txt'), r => {
      const key = k(dir, r.service_id);
      if (!S.exceptions.has(key)) S.exceptions.set(key, new Map());
      S.exceptions.get(key).set(r.date, r.exception_type);
    });
  }
  // Route lines (shapes) for just your trips, for the map
  const wantShapes = new Set([...S.trips.values()].map(t => t.shape).filter(Boolean));
  if (wantShapes.size) {
    const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const shapeRe = new RegExp('(^|[,"])(' + [...wantShapes].map(x => esc(x.split('|')[1])).join('|') + ')([",]|$)');
    for (const dir of agencies) {
      await eachRow(path.join(dir, 'shapes.txt'), r => {
        const key = k(dir, r.shape_id);
        if (!wantShapes.has(key)) return;
        if (!S.shapes.has(key)) S.shapes.set(key, []);
        S.shapes.get(key).push({ lat: +r.shape_pt_lat, lon: +r.shape_pt_lon, seq: +r.shape_pt_sequence });
      }, l => shapeRe.test(l));
    }
    for (const [key, pts] of S.shapes) S.shapes.set(key, pts.sort((a, b) => a.seq - b.seq).map(p => [p.lat, p.lon]));
  }
  S.ready = true;
  console.log(`Static GTFS loaded: ${S.stopTimes.length} stop times, ${S.trips.size} trips, ${S.stops.size} of ${C.STOP_IDS.length} stops found`);
}

// ---------- realtime feeds ----------
async function fetchFeed(url) {
  const r = await fetch(url, { headers: { accept: 'application/x-google-protobuf', Authorization: 'apikey ' + C.API_KEY } });
  if (!r.ok) throw new Error(`TfNSW responded ${r.status}`);
  return transit_realtime.FeedMessage.decode(new Uint8Array(await r.arrayBuffer()));
}
const num = x => Number(x) || 0;

async function refreshRealtime() {
  const feed = await fetchFeed('https://api.transport.nsw.gov.au/v1/gtfs/realtime/buses');
  const m = new Map();
  for (const e of feed.entity) {
    if (!e.tripUpdate) continue;
    const tu = e.tripUpdate;
    m.set(tu.trip.tripId, {
      route: tu.trip.routeId, date: tu.trip.startDate, cancelled: tu.trip.scheduleRelationship === 3,
      updates: tu.stopTimeUpdate.filter(u => u.scheduleRelationship !== 2).map(u => ({
        seq: u.stopSequence, stop: u.stopId,
        time: num(u.departure?.time) || num(u.arrival?.time),
        delay: u.departure?.delay ?? u.arrival?.delay ?? 0,
      })).sort((a, b) => a.seq - b.seq),
    });
  }
  RT.byTrip = m; RT.at = Date.now(); RT.entities = feed.entity.length; RT.error = '';
}
async function refreshPositions() {
  const feed = await fetchFeed('https://api.transport.nsw.gov.au/v1/gtfs/vehiclepos/buses');
  const m = new Map();
  for (const e of feed.entity) {
    const v = e.vehicle;
    if (!v?.trip?.tripId) continue;
    m.set(v.trip.tripId, { lat: v.position?.latitude, lon: v.position?.longitude, plate: v.vehicle?.licensePlate || '', seq: v.currentStopSequence || 0, bearing: v.position?.bearing, speed: v.position?.speed, ts: num(v.timestamp) });
  }
  POS.byTrip = m; POS.at = Date.now(); POS.entities = feed.entity.length; POS.error = '';
}
function loop(fn, name) {
  const run = async () => { try { await fn(); } catch (e) { console.log(name + ' refresh failed:', e.message); (name === 'Realtime' ? RT : POS).error = e.message; } setTimeout(run, C.REFRESH_SECS * 1000); };
  run();
}

// ---------- helpers ----------
function sydneyOffsetMin(ms) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Australia/Sydney', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(ms);
  const g = t => +p.find(x => x.type === t).value;
  return (Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - ms) / 60000;
}
const sydneyMidnight = (y, m, d) => { const g = Date.UTC(y, m - 1, d); return g - sydneyOffsetMin(g - 12 * 3600000) * 60000; };
function sydneyToday(ms) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms);
  const g = t => +p.find(x => x.type === t).value;
  return { y: g('year'), m: g('month'), d: g('day') };
}
function serviceActive(sid, ymd, dow) {
  const ex = S.exceptions.get(sid)?.get(ymd);
  if (ex === '1') return true;
  if (ex === '2') return false;
  const s = S.services.get(sid);
  return !!s && ymd >= s.start && ymd <= s.end && s.days[dow];
}
function fmtRego(p) {   // same rules as your Flask code
  if (!p) return null;
  if (p.startsWith('MO')) return 'm/o ' + p.slice(2);
  if (p.length === 6 && (p.endsWith('ST') || p.endsWith('MO'))) return p.slice(0, 4) + ' ' + p.slice(4);
  return null;
}
function km(a, b) {
  const r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lon - a.lon) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
const fmtSyd = ms => new Date(ms).toLocaleTimeString('en-AU', { timeZone: 'Australia/Sydney', hour12: false });
function pickUpdate(updates, st) {
  return updates.find(u => u.stop === st.stop) || [...updates].reverse().find(u => u.seq <= st.seq);  // delay carries forward
}

// ---------- departures (scheduled times + realtime delays + vehicle info) ----------
function getDepartures() {
  const now = Date.now(), out = [], p = sydneyToday(now);
  const D = { activeToday: 0, inWindow: 0, cancelled: 0, rtDateMismatch: 0, matchedRealtime: 0 };
  for (const off of [0, -1]) {   // yesterday too, for trips running past midnight
    const dt = new Date(Date.UTC(p.y, p.m - 1, p.d + off));
    const y = dt.getUTCFullYear(), mo = dt.getUTCMonth() + 1, d = dt.getUTCDate();
    const ymd = `${y}${String(mo).padStart(2, '0')}${String(d).padStart(2, '0')}`, mid = sydneyMidnight(y, mo, d);
    for (const st of S.stopTimes) {
      const trip = S.trips.get(st.trip);
      if (!trip || !serviceActive(trip.service, ymd, dt.getUTCDay())) continue;
      const sched = mid + st.dep * 1000;
      D.activeToday++;
      if (sched < now - 3 * 3600000 || sched > now + 3 * 3600000) continue;
      D.inWindow++;
      let rt = RT.byTrip.get(st.trip), rtNote = rt ? 'RT trip found' : 'no RT entry for this trip id';
      if (rt && rt.date && rt.date !== ymd) { rtNote = `RT date ${rt.date} is not ${ymd}`; D.rtDateMismatch++; rt = null; }
      if (rt?.cancelled) { D.cancelled++; continue; }
      let t = sched, live = false, late = 0;
      const u = rt && pickUpdate(rt.updates, st);
      if (rt && !u) rtNote = `RT trip has ${rt.updates.length} updates, none usable for seq ${st.seq}`;
      if (u) {
        t = u.time ? u.time * 1000 : sched + u.delay * 1000; live = true; late = Math.round((t - sched) / 60000); D.matchedRealtime++;
        rtNote = `RT ${u.stop === st.stop ? 'exact stop' : 'carried from seq ' + u.seq}, time ${u.time || 'none'}, delay ${u.delay}s`;
      }
      if (t < now - 60000 || t > now + 2 * 3600000) continue;
      const info = [live ? (late > 0 ? `${late} min late` : late < 0 ? `${-late} min early` : 'On time') : 'Scheduled'];
      const v = POS.byTrip.get(st.trip), stop = S.stops.get(st.stop);
      if (live && v) {   // stops away: the first stop still to come in the trip update is the bus's next stop
        const next = rt.updates[0]?.seq || v.seq, away = st.seq - next;
        if (next && away >= 0) info.splice(1, 0, away === 0 ? 'Next stop' : `${away} stop${away === 1 ? '' : 's'} away`);
      }
      if (v && stop && v.lat) info.push(km(v, stop).toFixed(1) + ' km away');
      const f = fleet[fmtRego(v?.plate)];
      if (f) info.push(`Fleet ${f.fleet_no}, ${f.chassis} ${f.body}`);
      out.push({ route: S.routes.get(trip.route) || trip.route.split('|')[1], dest: trip.head || '', time: new Date(t).toISOString(), live, info: info.join(', '), trip: st.trip, mid, stopId: st.stop, group: S.group.get(st.stop) || st.stop, dbg: `trip ${st.trip}, stop ${st.stop}, seq ${st.seq}, scheduled ${fmtSyd(sched)}, ${rtNote}` });
    }
  }
  lastStats = D;
  return out.sort((a, b) => a.time.localeCompare(b.time));
}

// ---------- debug info (open the board with ?debug on the end of the address) ----------
function getDebug() {
  const now = Date.now(), age = at => at ? Math.round((now - at) / 1000) : null;
  let rtOverlap = 0, posOverlap = 0;
  for (const id of RT.byTrip.keys()) if (S.trips.has(id)) rtOverlap++;
  for (const id of POS.byTrip.keys()) if (S.trips.has(id)) posOverlap++;
  const p = sydneyToday(now), ymdNow = `${p.y}${String(p.m).padStart(2, '0')}${String(p.d).padStart(2, '0')}`;
  let earliest = '99999999', latest = '0', covering = 0;
  for (const sv of S.services.values()) { if (sv.start < earliest) earliest = sv.start; if (sv.end > latest) latest = sv.end; if (ymdNow >= sv.start && ymdNow <= sv.end) covering++; }
  const visits = [];
  for (const [id, rt] of RT.byTrip) {
    const u = rt.updates.find(x => (S.wantedIds || []).includes(x.stop));
    if (u) visits.push({ trip: id, route: rt.route, inYourStaticData: S.trips.has(id), expected: u.time ? fmtSyd(u.time * 1000) : 'delay only (' + u.delay + 's)', date: rt.date, seq: u.seq });
  }
  visits.sort((a, b) => a.expected.localeCompare(b.expected));
  return {
    serverTime: new Date(now).toISOString(), sydneyDate: p,
    staticGtfs: { ready: S.ready, stopIds: S.wantedIds, stopsFound: [...S.stops.keys()], stopTimes: S.stopTimes.length, trips: S.trips.size, services: S.services.size, calendarExceptions: S.exceptions.size, calendarEarliestStart: earliest, calendarLatestEnd: latest, servicesCoveringToday: covering },
    realtimeFeedSaysStopsAtYourStop: { count: visits.length, trips: visits.slice(0, 15) },
    departureCounts: lastStats,
    realtimeTripUpdates: { ageSecs: age(RT.at), error: RT.error || null, feedEntities: RT.entities, tripUpdates: RT.byTrip.size, tripIdsAlsoInYourStaticData: rtOverlap, sampleFeedTripIds: [...RT.byTrip.keys()].slice(0, 5), sampleYourTripIds: [...S.trips.keys()].slice(0, 5) },
    vehiclePositions: { ageSecs: age(POS.at), error: POS.error || null, feedEntities: POS.entities, vehiclesWithTrips: POS.byTrip.size, tripIdsAlsoInYourStaticData: posOverlap },
  };
}

// ---------- bus sidebar: photo and stopping pattern ----------
function findPhoto(model) {
  if (!model) return null;
  for (const name of [model, model.replace(/[\\/:*?"<>|]/g, '')]) {
    for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
      if (fs.existsSync(path.join(C.PHOTO_DIR, name + ext))) return '/photos/' + encodeURIComponent(name + ext);
    }
  }
  return null;
}
function buildPattern(id, mid) {
  const rows = S.patterns.get(id);
  if (!rows) return [];
  const rt = RT.byTrip.get(id), v = POS.byTrip.get(id);
  const next = rt?.updates[0]?.seq || v?.seq || 0;   // the bus's next stop
  const mine = new Set(S.wantedIds);
  return rows.map(r => {
    const sched = mid + r.dep * 1000;
    let t = sched, live = false;
    const u = next && r.seq >= next && rt && pickUpdate(rt.updates, r);
    if (u) { t = u.time && u.stop === r.stop ? u.time * 1000 : sched + u.delay * 1000; live = true; }
    return {
      id: r.stop, name: S.pstops.get(r.stop)?.name || r.stop, seq: r.seq,
      sched: new Date(sched).toISOString(), time: new Date(t).toISOString(),
      delayMin: live ? Math.round((t - sched) / 60000) : null,   // passed stops have no live time, so no delay is shown
      state: !next ? 'future' : r.seq < next ? 'passed' : r.seq === next ? 'next' : 'future',
      yours: mine.has(r.stop),
    };
  });
}

// ---------- live map data ----------
function getTrack(id, stopId, mid) {
  const trip = S.trips.get(id), st = S.stopTimes.find(x => x.trip === id && (!stopId || x.stop === stopId));
  const stop = st && S.stops.get(st.stop);
  if (!trip || !stop) return { error: 'Unknown trip' };
  const v = POS.byTrip.get(id), f = v && fleet[fmtRego(v.plate)];
  const bus = f ? { fleetNo: f.fleet_no, model: `${f.chassis} ${f.body}`, depot: f.depot, operator: f.operator, built: f.body_date } : null;
  if (!Number(mid)) { const p = sydneyToday(Date.now()); mid = sydneyMidnight(p.y, p.m, p.d); }
  return {
    route: S.routes.get(trip.route) || trip.route.split('|')[1], dest: trip.head || '',
    stop: { name: stop.name, lat: stop.lat, lon: stop.lon },
    shape: S.shapes.get(trip.shape) || [],
    bus, photo: bus && findPhoto(bus.model), pattern: buildPattern(id, Number(mid)),
    vehicle: v && v.lat ? { lat: v.lat, lon: v.lon, speed: Math.round((v.speed || 0) * 3.6), ageSecs: v.ts ? Math.max(0, Math.round(Date.now() / 1000 - v.ts)) : null } : null,
  };
}

// ---------- server ----------
const send = (res, obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
http.createServer((req, res) => {
  try {
    if (req.url === '/api/config') {
      send(res, { lat: C.LAT, lon: C.LON, walk: C.WALK_MINS, ssid: C.WIFI_SSID, pass: C.WIFI_PASS, wifi: `WIFI:T:WPA;S:${C.WIFI_SSID};P:${C.WIFI_PASS};;` });
    } else if (req.url.startsWith('/photos/')) {
      const name = path.basename(decodeURIComponent(req.url.slice(8).split('?')[0])), file = path.resolve(C.PHOTO_DIR, name);
      if (!fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
      res.setHeader('Content-Type', { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[path.extname(name).toLowerCase()] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'max-age=86400');
      fs.createReadStream(file).pipe(res);
    } else if (req.url.startsWith('/api/track')) {
      const q = new URL(req.url, 'http://x').searchParams;
      send(res, getTrack(q.get('trip'), q.get('stop'), q.get('mid')));
    } else if (req.url === '/api/debug') {
      send(res, getDebug());
    } else if (req.url === '/api/buses') {
      if (!S.ready) { res.statusCode = 503; return send(res, { error: 'Static GTFS still loading (or folder not found)' }); }
      if (!RT.at) { res.statusCode = 503; return send(res, { error: 'Waiting for first realtime update' }); }
      send(res, { stops: C.STOP_IDS.map(id => ({ id: id.trim(), name: S.stops.get(id.trim())?.name || id.trim() })), departures: getDepartures() });
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }
  } catch (e) { res.statusCode = 500; send(res, { error: e.message }); }
}).listen(C.PORT, () => console.log('Board running at http://localhost:' + C.PORT));

if (!C.API_KEY) console.log('TFNSW_API_KEY is not set, bus data will fail');
loadStatic().catch(e => console.log('Static GTFS load failed:', e.message));
loop(refreshRealtime, 'Realtime');
loop(refreshPositions, 'Position');
