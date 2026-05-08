// Deterministic mock shipment dataset used when DEMO_MODE=true.
// Mirrors the field shape returned by the TMS shipment detail endpoint
// (the parts the dashboard cares about).

const customers = [
  { code: 'TATA', name: 'Tata Steel Limited', email: 'sustainability@tatasteel.com' },
  { code: 'MAH',  name: 'Mahadhan Agritech Limited', email: 'esg@mahadhan.com' },
  { code: 'AVA',  name: 'Avaada Energy Private Limited', email: 'green@avaada.com' },
  { code: 'CCIL', name: 'Container Corporation of India', email: 'csr@concor.com' },
  { code: 'VOLV', name: 'Volvo CE India Private Limited', email: 'esg@volvo.com' },
  { code: 'HIND', name: 'Hindalco Industries Limited', email: 'sustain@hindalco.com' },
  { code: 'JSW',  name: 'JSW Steel Limited', email: 'green@jsw.in' },
  { code: 'KOM',  name: 'Komatsu India Pvt Ltd', email: 'sustain@komatsu.in' },
  { code: 'NEEL', name: 'Neelachal Ispat Nigam', email: 'csr@neelachal.in' },
  { code: 'REL',  name: 'Reliance Industries Limited', email: 'esg@ril.com' },
  { code: 'TH',   name: 'Tata Hitachi Construction Machinery', email: 'green@tatahitachi.com' },
  { code: 'ACC',  name: 'ACC Cement', email: 'sustain@acc.in' },
  { code: 'ADGR', name: 'Adani Green Energy Limited', email: 'esg@adanigreen.com' },
  { code: 'IKEA', name: 'IKEA India Private Limited', email: 'sustainability@ikea.in' },
];

const sources = ['NAGPUR', 'JAMSHEDPUR', 'MERAMUNDALI', 'TUGHLAKABAD', 'SAHIBABAD', 'MUMBAI', 'CHENNAI', 'KOLKATA'];
const destinations = ['KHOPOLI', 'FARIDABAD', 'CHENNAI', 'TALOJA', 'KANPUR', 'JAIPUR', 'CHAKAN', 'BENGALURU'];
const vehicles = ['hire', 'fleet', 'TRAILOR III-AXLE DBL CROWN_CANOPY_40FT', 'TRAILER 32FT', 'CONTAINER 20FT'];
const modes = ['ByRoad', 'ByRail'];

// Simple seeded PRNG so the dataset is stable across reloads
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pad(n, w) {
  return String(n).padStart(w, '0');
}

function buildDataset() {
  const rng = mulberry32(20260423);
  const out = [];
  // Last 800 days, several shipments/day
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today.getTime() - 800 * 24 * 60 * 60 * 1000);

  let n = 1;
  for (let d = 0; d < 800; d++) {
    const dayDate = new Date(start.getTime() + d * 24 * 60 * 60 * 1000);
    const perDay = 6 + Math.floor(rng() * 12); // 6-17 shipments / day
    for (let i = 0; i < perDay; i++) {
      const cust = customers[Math.floor(rng() * customers.length)];
      const src = sources[Math.floor(rng() * sources.length)];
      const dst = destinations[Math.floor(rng() * destinations.length)];
      const veh = vehicles[Math.floor(rng() * vehicles.length)];
      const mode = rng() < 0.85 ? 'ByRoad' : 'ByRail';

      const distance = Math.round(80 + rng() * 1700);
      const fuel = +(distance * (0.25 + rng() * 0.15)).toFixed(2);
      // road emission factor ~ 0.85 kg CO2/km, rail ~ 0.32
      const carbon = +((mode === 'ByRoad' ? 0.85 : 0.32) * distance * (0.9 + rng() * 0.2)).toFixed(2);
      const aversionRail = +((0.32) * distance * (0.9 + rng() * 0.2)).toFixed(2);
      const aversionLng = +(carbon * (0.6 + rng() * 0.1)).toFixed(2);
      const aversionElectric = +(carbon * (0.18 + rng() * 0.1)).toFixed(2);
      const aversionHydrogen = +(carbon * (0.05 + rng() * 0.05)).toFixed(2);

      const completionTime = dayDate.getTime() + Math.floor(rng() * 86400000);
      const id = `SHP${pad(n, 7)}`;
      const shipmentNo = `${cust.code}${pad(40 + (n % 99), 2)}${String.fromCharCode(65 + (n % 26))}${pad(n % 99999, 5)}`;
      const consignment = `${shipmentNo}|${cust.code}${pad(n % 99999, 5)}`;
      out.push({
        id,
        shipmentNo,
        consignmentNumber: consignment,
        vehicleType: veh,
        source: src,
        destination: dst,
        transportationMode: mode,
        carbonEmissionValue: carbon,
        totalDistance: distance,
        fuelUsed: fuel,
        aversionValue_lng: aversionLng,
        aversionValue_electric: aversionElectric,
        aversionValue_hydrogen: aversionHydrogen,
        aversionValue_rail: aversionRail,
        customerCode: cust.code,
        customerName: cust.name,
        customerEmail: cust.email,
        completionTime,
        status: 'Completed',
      });
      n++;
    }
  }
  return out;
}

const SHIPMENTS = buildDataset();

module.exports = {
  customers,
  shipments: SHIPMENTS,
};
