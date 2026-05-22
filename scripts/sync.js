const { Redis } = require('@upstash/redis');
const fetch = require('node-fetch');

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const CIN7_ACCOUNT_ID = process.env.CIN7_ACCOUNT_ID;
const CIN7_API_KEY = process.env.CIN7_API_KEY;

function cin7Headers() {
  return {
    'api-auth-accountid': CIN7_ACCOUNT_ID,
    'api-auth-applicationkey': CIN7_API_KEY,
    'Content-Type': 'application/json'
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function cin7Get(url) {
  for (let i = 0; i < 3; i++) {
    const res = await fetch(url, { headers: cin7Headers() });
    if (res.status === 200) return res.json();
    if (res.status === 429) {
      console.log('Rate limited, waiting 62s...');
      await sleep(62000);
      continue;
    }
    const text = await res.text();
    throw new Error(`Cin7 API ${res.status}: ${text.substring(0, 200)}`);
  }
  throw new Error('Max retries exceeded');
}

const EXCLUDED = ['blake\'s seed based', 'amazon seller', 'shopify'];

async function fetchInventory() {
  console.log('Fetching inventory...');
  const allProducts = [];
  let page = 1;
  while (true) {
    const data = await cin7Get(
      `https://inventory.dearsystems.com/ExternalApi/v2/ref/productavailability?Page=${page}&Limit=250`
    );
    const products = data.ProductAvailabilityList || [];
    if (products.length === 0) break;
    products.forEach(p => {
      allProducts.push({
        sku: p.SKU || '',
        name: p.Name || '',
        location: p.Location || '',
        onHand: p.OnHand || 0,
        stockValue: parseFloat(p.StockOnHand) || 0
      });
    });
    if (products.length < 250) break;
    page++;
    await sleep(500);
  }
  console.log(`Inventory: ${allProducts.length} records`);
  return allProducts;
}

async function fetchSales(createdSince) {
  console.log(`Fetching sales since ${createdSince}...`);
  const rows = [];
  let page = 1;
  let callCount = 0;

  while (true) {
    const listData = await cin7Get(
      `https://inventory.dearsystems.com/ExternalApi/v2/SaleList?Page=${page}&Limit=100&CreatedSince=${createdSince}&InvoiceStatus=INVOICED`
    );
    callCount++;
    const allSales = listData.SaleList || [];
    const sales = allSales.filter(s =>
      s.SaleID &&
      s.Status !== 'VOIDED' &&
      s.Status !== 'DELETED' &&
      !EXCLUDED.includes((s.Customer || '').toLowerCase().trim())
    );

    console.log(`Page ${page}: ${sales.length} valid sales (${allSales.length} total)`);
    if (allSales.length === 0) break;

    for (const sale of sales) {
      await sleep(600);
      callCount++;
      if (callCount % 50 === 0) {
        console.log('Pausing 65s for rate limit...');
        await sleep(65000);
      }
      try {
        const saleData = await cin7Get(
          `https://inventory.dearsystems.com/ExternalApi/v2/sale?SaleID=${sale.SaleID}`
        );
        const fullSale = saleData.Sale || saleData;
        const customer = fullSale.Customer || sale.Customer || '';
        const invoice = fullSale.Invoice || {};
        const lines = invoice.Lines || [];
        const invoiceNum = invoice.InvoiceNumber || '';
        const shipDate = fullSale.ShipBy || '';

        for (const line of lines) {
          const saleAmt = parseFloat(line.Total) || 0;
          const cogs = parseFloat(line.AverageCost) || 0;
          rows.push({
            sku: line.SKU || '',
            name: line.Name || '',
            customer,
            shipDate,
            qty: line.Quantity || 0,
            invoiceNum,
            sale: saleAmt,
            cogs,
            profit: saleAmt - cogs
          });
        }
      } catch (e) {
        console.log(`Skipping sale ${sale.SaleID}: ${e.message}`);
      }
    }

    if (allSales.length < 100) break;
    page++;
    await sleep(500);
  }
  console.log(`Sales: ${rows.length} line items`);
  return rows;
}

async function fetchOpenOrders() {
  console.log('Fetching open orders...');
  const rows = [];
  let page = 1;
  let callCount = 0;

  while (true) {
    const listData = await cin7Get(
      `https://inventory.dearsystems.com/ExternalApi/v2/SaleList?Page=${page}&Limit=100&OrderStatus=OPEN`
    );
    callCount++;
    const allOrders = listData.SaleList || [];
    const orders = allOrders.filter(s => s.SaleID);
    if (allOrders.length === 0) break;

    console.log(`Open orders page ${page}: ${orders.length} records`);

    for (const sale of orders) {
      await sleep(600);
      callCount++;
      if (callCount % 50 === 0) {
        console.log('Pausing 65s for rate limit...');
        await sleep(65000);
      }
      try {
        const saleData = await cin7Get(
          `https://inventory.dearsystems.com/ExternalApi/v2/sale?SaleID=${sale.SaleID}`
        );
        const fullSale = saleData.Sale || saleData;
        const orderDate = fullSale.OrderDate || sale.OrderDate || '';
        const customer = fullSale.Customer || sale.Customer || '';
        const shipAddr = fullSale.ShippingAddress || {};
        const order = fullSale.Order || {};
        const lines = order.Lines || [];

        for (const line of lines) {
          rows.push({
            sku: line.SKU || '',
            name: line.Name || '',
            customer,
            orderDate,
            shipBy: fullSale.ShipBy || '',
            status: fullSale.Status || sale.Status || '',
            orderNumber: fullSale.OrderNumber || sale.OrderNumber || '',
            qty: line.Quantity || 0,
            total: parseFloat(line.Total) || 0,
            city: shipAddr.City || '',
            state: shipAddr.State || '',
            channel: fullSale.Channel || '',
            requiredBy: fullSale.RequiredBy || ''
          });
        }
      } catch (e) {
        console.log(`Skipping order ${sale.SaleID}: ${e.message}`);
      }
    }

    if (allOrders.length < 100) break;
    page++;
    await sleep(500);
  }
  console.log(`Open orders: ${rows.length} line items`);
  return rows;
}

async function main() {
  console.log('Starting sync:', new Date().toISOString());

  try {
    const inventory = await fetchInventory();
    await redis.set('inventory', JSON.stringify(inventory));
    await redis.set('inventory_updated', new Date().toISOString());
    console.log('✅ Inventory saved');
  } catch (e) {
    console.error('❌ Inventory failed:', e.message);
  }

  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
      .toISOString().split('T')[0];
    const mtd = await fetchSales(startOfMonth);
    await redis.set('sales_mtd', JSON.stringify(mtd));
    await redis.set('sales_mtd_updated', new Date().toISOString());
    console.log('✅ MTD sales saved');
  } catch (e) {
    console.error('❌ MTD sales failed:', e.message);
  }

  try {
    const now = new Date();
    const startOfYear = `${now.getFullYear()}-01-01`;
    const ytd = await fetchSales(startOfYear);
    await redis.set('sales_ytd', JSON.stringify(ytd));
    await redis.set('sales_ytd_updated', new Date().toISOString());
    console.log('✅ YTD sales saved');
  } catch (e) {
    console.error('❌ YTD sales failed:', e.message);
  }

  try {
    const openOrders = await fetchOpenOrders();
    await redis.set('open_orders', JSON.stringify(openOrders));
    await redis.set('open_orders_updated', new Date().toISOString());
    console.log('✅ Open orders saved');
  } catch (e) {
    console.error('❌ Open orders failed:', e.message);
  }

  await redis.set('last_sync', new Date().toISOString());
  console.log('Sync complete:', new Date().toISOString());
}

main().catch(console.error);
