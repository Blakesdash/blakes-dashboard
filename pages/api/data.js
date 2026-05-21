// Data endpoint - dashboard reads from this to get cached sales data

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export default async function handler(req, res) {
  // Allow CORS for the dashboard
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const type = req.query.type;

  try {
    let data;
    switch (type) {
      case 'inventory':
        data = await redis.get('inventory');
        break;
      case 'sales_mtd':
        data = await redis.get('sales_mtd');
        break;
      case 'sales_ytd':
        data = await redis.get('sales_ytd');
        break;
      case 'open_orders':
        data = await redis.get('open_orders');
        break;
      case 'status':
        data = {
          lastSync: await redis.get('last_sync'),
          inventoryUpdated: await redis.get('inventory_updated'),
          mtdUpdated: await redis.get('sales_mtd_updated'),
          ytdUpdated: await redis.get('sales_ytd_updated'),
          openOrdersUpdated: await redis.get('open_orders_updated'),
        };
        return res.status(200).json(data);
      default:
        return res.status(400).json({ error: 'Invalid type' });
    }

    if (!data) {
      return res.status(404).json({ error: 'No data yet - run sync first', type });
    }

    // Parse if string
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    return res.status(200).json(parsed);
  } catch (e) {
    console.error('Data API error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
