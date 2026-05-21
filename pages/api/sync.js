// Main sync endpoint - called by Vercel cron at 5am Central (10am UTC)
// Can also be triggered manually via GET /api/sync?secret=YOUR_SECRET

import { Redis } from '@upstash/redis';
import { fetchInventory, fetchSales, fetchOpenOrders } from '../../lib/cin7';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export const maxDuration = 300; // 5 minute max (Vercel hobby limit)

export default async function handler(req, res) {
  // Security check
  const secret = req.query.secret || req.headers['authorization'];
  if (secret !== process.env.SYNC_SECRET) {
    // Allow Vercel cron (it sends a special header)
    const cronHeader = req.headers['x-vercel-cron'];
    if (!cronHeader) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  console.log('Starting sync:', new Date().toISOString());
  const results = { inventory: false, mtd: false, ytd: false, openOrders: false, errors: [] };

  // 1. Inventory (fast - 1 API call)
  try {
    console.log('Syncing inventory...');
    const inventory = await fetchInventory();
    await redis.set('inventory', JSON.stringify(inventory));
    await redis.set('inventory_updated', new Date().toISOString());
    results.inventory = true;
    console.log(`Inventory done: ${inventory.length} records`);
  } catch (e) {
    results.errors.push(`Inventory: ${e.message}`);
    console.error('Inventory error:', e.message);
  }

  // 2. MTD Sales
  try {
    console.log('Syncing MTD sales...');
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
      .toISOString().split('T')[0];
    const mtdSales = await fetchSales(startOfMonth);
    await redis.set('sales_mtd', JSON.stringify(mtdSales));
    await redis.set('sales_mtd_updated', new Date().toISOString());
    results.mtd = true;
    console.log(`MTD sales done: ${mtdSales.length} line items`);
  } catch (e) {
    results.errors.push(`MTD Sales: ${e.message}`);
    console.error('MTD error:', e.message);
  }

  // 3. YTD Sales
  try {
    console.log('Syncing YTD sales...');
    const now = new Date();
    const startOfYear = `${now.getFullYear()}-01-01`;
    const ytdSales = await fetchSales(startOfYear);
    await redis.set('sales_ytd', JSON.stringify(ytdSales));
    await redis.set('sales_ytd_updated', new Date().toISOString());
    results.ytd = true;
    console.log(`YTD sales done: ${ytdSales.length} line items`);
  } catch (e) {
    results.errors.push(`YTD Sales: ${e.message}`);
    console.error('YTD error:', e.message);
  }

  // 4. Open Orders
  try {
    console.log('Syncing open orders...');
    const openOrders = await fetchOpenOrders();
    await redis.set('open_orders', JSON.stringify(openOrders));
    await redis.set('open_orders_updated', new Date().toISOString());
    results.openOrders = true;
    console.log(`Open orders done: ${openOrders.length} line items`);
  } catch (e) {
    results.errors.push(`Open Orders: ${e.message}`);
    console.error('Open orders error:', e.message);
  }

  await redis.set('last_sync', new Date().toISOString());
  console.log('Sync complete:', results);
  return res.status(200).json(results);
}
