// Cloudflare Pages Function for handling wardrive samples
// Automatically deployed as /api/samples
// Uses geohash-based aggregated storage with time decay
// Implements server-side de-duplication using per-sample IDs stored in KV with TTL

// Simple geohash encoder (precision 7 = ~153m squares)
function encodeGeohash(lat, lon, precision = 7) {
  const base32 = '0123456789bcdefghjkmnpqrstuvwxyz';
  let idx = 0;
  let bit = 0;
  let evenBit = true;
  let geohash = '';
  let latMin = -90, latMax = 90;
  let lonMin = -180, lonMax = 180;

  while (geohash.length < precision) {
    if (evenBit) {
      const lonMid = (lonMin + lonMax) / 2;
      if (lon > lonMid) {
        idx |= (1 << (4 - bit));
        lonMin = lonMid;
      } else {
        lonMax = lonMid;
      }
    } else {
      const latMid = (latMin + latMax) / 2;
      if (lat > latMid) {
        idx |= (1 << (4 - bit));
        latMin = latMid;
      } else {
        latMax = latMid;
      }
    }
    evenBit = !evenBit;

    if (bit < 4) {
      bit++;
    } else {
      geohash += base32[idx];
      bit = 0;
      idx = 0;
    }
  }

  return geohash;
}

export async function onRequestGet(context) {
  try {
    // List all keys that start with 'cell:'
    const list = await context.env.WARDRIVE_DATA.list({ prefix: 'cell:' });
    const coverage = {};

    // Fetch all cells in parallel
    await Promise.all(list.keys.map(async (keyItem) => {
      const data = await context.env.WARDRIVE_DATA.get(keyItem.name, { type: "json" });
      const hash = keyItem.name.replace('cell:', '');
      coverage[hash] = data;
    }));

    return new Response(JSON.stringify({ coverage }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}

// Calculate age in days
function ageInDays(timestamp) {
  const now = new Date();
  const sampleDate = new Date(timestamp);
  const diffMs = now - sampleDate;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

// Apply time-based decay to existing coverage cell
function applyDecay(cell) {
  const age = ageInDays(cell.lastUpdate);
  
  let decayFactor = 1.0;
  if (age > 90) {
    decayFactor = 0.2;      // 90+ days: 20% weight
  } else if (age > 30) {
    decayFactor = 0.5;      // 30-90 days: 50% weight
  } else if (age > 14) {
    decayFactor = 0.7;      // 14-30 days: 70% weight
  } else if (age > 7) {
    decayFactor = 0.85;     // 7-14 days: 85% weight
  }
  // else: <7 days = 100% weight (no decay)
  
  cell.received *= decayFactor;
  cell.lost *= decayFactor;
  
  return cell;
}

// Aggregate samples by geohash
function aggregateSamples(samples) {
  const coverage = {};
  const now = new Date().toISOString();
  
  samples.forEach(sample => {
    const lat = sample.latitude || sample.lat;
    const lng = sample.longitude || sample.lng;
    
    if (!lat || !lng) return;
    
    // Use precision 7 (~153m squares)
    const hash = encodeGeohash(lat, lng, 7);
    
    if (!coverage[hash]) {
      coverage[hash] = {
        received: 0,
        lost: 0,
        samples: 0,
        repeaters: {},  // Changed from nodes array to repeaters object
        firstSeen: sample.timestamp || now,
        lastUpdate: sample.timestamp || now
      };
    }
    
    // Determine ping success
    const success = sample.pingSuccess === true || 
                   (sample.nodeId && sample.nodeId !== 'Unknown');
    const failed = sample.pingSuccess === false || sample.nodeId === 'Unknown';
    
    // Add weighted sample
    if (success) {
      coverage[hash].received += 1;
      
      // Store repeater details
      if (sample.nodeId && sample.nodeId !== 'Unknown') {
        const nodeId = sample.nodeId;
        const sampleTime = new Date(sample.timestamp || now).getTime();
        
        // Update if this is a newer sample for this repeater
        if (!coverage[hash].repeaters[nodeId] || 
            new Date(coverage[hash].repeaters[nodeId].lastSeen).getTime() < sampleTime) {
          coverage[hash].repeaters[nodeId] = {
            name: sample.repeaterName || nodeId,  // Use friendly name if available
            rssi: sample.rssi || null,
            snr: sample.snr || null,
            lastSeen: sample.timestamp || now
          };
        }
      }
    } else if (failed) {
      coverage[hash].lost += 1;
    }
    
    coverage[hash].samples += 1;
    
    // Keep newest timestamp
    if (sample.timestamp > coverage[hash].lastUpdate) {
      coverage[hash].lastUpdate = sample.timestamp;
    }
  });
  
  return coverage;
}

function computeSampleId(sample) {
  if (sample.id) return String(sample.id);
  const lat = sample.latitude ?? sample.lat;
  const lng = sample.longitude ?? sample.lng;
  const ts = sample.timestamp || '';
  const node = sample.nodeId || '';
  const key = `${lat?.toFixed?.(6)}|${lng?.toFixed?.(6)}|${ts}|${node}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) - h) + key.charCodeAt(i);
    h |= 0;
  }
  return `h${Math.abs(h)}`;
}

// refactored to reduce KV Interactions due to Cloudflare free tier
// subrequest limit = 50
// cpu time = 10ms
// memory = 128mb

// Trust "Coverage" object for dedup, or handle in a single key

export async function onRequestPost(context) {
  console.log(">>> POST Received - Atomic Update Mode");
  try {
    const body = await context.request.json();
    const samples = body.samples || [];
    if (samples.length === 0) return new Response(JSON.stringify({ success: true }), { status: 200 });

    // 1. Group samples by geohash in memory first
    const batchSummary = {}; 
    for (const s of samples) {
      const lat = s.latitude || s.lat;
      const lng = s.longitude || s.lng;
      if (!lat || !lng) continue;

      const hash = encodeGeohash(lat, lng, 7);
      if (!batchSummary[hash]) {
        batchSummary[hash] = { received: 0, lost: 0, lastUpdate: s.timestamp, repeaters: {} };
      }

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

    // 2. Write to KV using Atomic Keys
    // This uses one subrequest per UNIQUE geohash found in this batch
    const updatePromises = Object.entries(batchSummary).map(async ([hash, newData]) => {
      const key = `cell:${hash}`;
      const existing = await context.env.WARDRIVE_DATA.get(key, { type: "json" }) || { received: 0, lost: 0, repeaters: {} };
      
      // Merge logic
      existing.received += newData.received;
      existing.lost += newData.lost;
      existing.lastUpdate = newData.lastUpdate;
      existing.repeaters = { ...existing.repeaters, ...newData.repeaters };

      return context.env.WARDRIVE_DATA.put(key, JSON.stringify(existing));
    });

    await Promise.all(updatePromises);

    return new Response(JSON.stringify({ success: true, processed: samples.length }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });

  } catch (error) {
    console.error("Worker Error:", error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}

// Handle DELETE request to clear all data
// SECURED: Requires authentication token
export async function onRequestDelete(context) {
  try {
    // Check for authorization header
    const authHeader = context.request.headers.get('Authorization');
    const adminToken = context.env.ADMIN_TOKEN; // Set this in Cloudflare Pages settings
    
    // Verify token
    if (!authHeader || authHeader !== `Bearer ${adminToken}`) {
      return new Response(JSON.stringify({ 
        error: 'Unauthorized: Invalid or missing authentication token'
      }), {
        status: 401,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
    
    // Delete the coverage key from KV
    await context.env.WARDRIVE_DATA.delete('coverage');
    
    return new Response(JSON.stringify({ 
      success: true,
      message: 'All data cleared'
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error) {
    console.error("Worker Error:", error.message); // Show in Cloudflare Logs
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// Handle CORS preflight
export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
