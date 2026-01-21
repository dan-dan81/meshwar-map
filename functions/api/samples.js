// --- Helper Functions ---

function encodeGeohash(lat, lon, precision = 7) {
  const base32 = '0123456789bcdefghjkmnpqrstuvwxyz';
  let idx = 0, bit = 0, evenBit = true, geohash = '';
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;

  while (geohash.length < precision) {
    if (evenBit) {
      let mid = (lonMin + lonMax) / 2;
      if (lon > mid) { idx |= (1 << (4 - bit)); lonMin = mid; }
      else { lonMax = mid; }
    } else {
      let mid = (latMin + latMax) / 2;
      if (lat > mid) { idx |= (1 << (4 - bit)); latMin = mid; }
      else { latMax = mid; }
    }
    evenBit = !evenBit;
    if (bit < 4) bit++; else { geohash += base32[idx]; bit = 0; idx = 0; }
  }
  return geohash;
}

function computeSampleId(s) {
  if (s.id) return String(s.id);
  const key = `${(s.latitude || s.lat)?.toFixed(6)}|${(s.longitude || s.lng)?.toFixed(6)}|${s.timestamp}|${s.nodeId}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) { h = ((h << 5) - h) + key.charCodeAt(i); h |= 0; }
  return `h${Math.abs(h)}`;
}

// --- API Handlers ---

export async function onRequestPost(context) {
  console.log(">>> POST: Processing Batch");
  try {
    const body = await context.request.json();
    const incoming = body.samples || [];
    if (incoming.length === 0) return new Response(JSON.stringify({ success: true }), { status: 200 });

    // 1. Group samples by hash in memory
    const batchSummary = {};
    for (const s of incoming) {
      const lat = s.latitude || s.lat;
      const lng = s.longitude || s.lng;
      if (!lat || !lng) continue;

      const hash = encodeGeohash(lat, lng, 7);
      const sid = computeSampleId(s);

      if (!batchSummary[hash]) {
        batchSummary[hash] = { received: 0, lost: 0, lastUpdate: s.timestamp, repeaters: {}, ids: new Set() };
      }

      if (batchSummary[hash].ids.has(sid)) continue;
      batchSummary[hash].ids.add(sid);

      const success = s.pingSuccess === true || (s.nodeId && s.nodeId !== 'Unknown');
      success ? batchSummary[hash].received++ : batchSummary[hash].lost++;

      if (s.nodeId && s.nodeId !== 'Unknown') {
        batchSummary[hash].repeaters[s.nodeId] = {
          name: s.repeaterName || s.nodeId,
          rssi: s.rssi || null,
          lastSeen: s.timestamp
        };
      }
    }

    // 2. Atomic Merge into KV
    const updatePromises = Object.entries(batchSummary).map(async ([hash, newData]) => {
      const key = `cell:${hash}`;
      const existing = await context.env.WARDRIVE_DATA.get(key, { type: "json" }) || 
                       { received: 0, lost: 0, repeaters: {}, seenIds: [] };

      // Filter for truly new IDs
      const actuallyNewIds = [...newData.ids].filter(id => !existing.seenIds.includes(id));
      if (actuallyNewIds.length === 0) return;

      const ratio = actuallyNewIds.length / newData.ids.size;
      existing.received += Math.round(newData.received * ratio);
      existing.lost += Math.round(newData.lost * ratio);
      
      // Update repeaters & timestamp
      existing.repeaters = { ...existing.repeaters, ...newData.repeaters };
      if (newData.lastUpdate > (existing.lastUpdate || "")) existing.lastUpdate = newData.lastUpdate;

      // Keep seen list manageable (last 150 IDs)
      existing.seenIds = [...actuallyNewIds, ...existing.seenIds].slice(0, 150);

      return context.env.WARDRIVE_DATA.put(key, JSON.stringify(existing));
    });

    await Promise.all(updatePromises);
    return new Response(JSON.stringify({ success: true, count: incoming.length }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (err) {
    console.error("POST Error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

export async function onRequestGet(context) {
  try {
    const list = await context.env.WARDRIVE_DATA.list({ prefix: 'cell:' });
    const coverage = {};

    // Fetch cells. For Free Tier, we stay under 50 subrequests.
    // If you have >45 cells, this will need a "Mega Key" consolidation.
    await Promise.all(list.keys.slice(0, 45).map(async (k) => {
      const data = await context.env.WARDRIVE_DATA.get(k.name, { type: "json" });
      if (data) coverage[k.name.split(':')[1]] = data;
    }));

    return new Response(JSON.stringify({ coverage }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}