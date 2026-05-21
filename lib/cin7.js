// Cin7 Core API helper

const CIN7_ACCOUNT_ID = process.env.CIN7_ACCOUNT_ID;
const CIN7_API_KEY = process.env.CIN7_API_KEY;

function cin7Headers() {
  return {
    'api-auth-accountid': CIN7_ACCOUNT_ID,
    'api-auth-applicationkey': CIN7_API_KEY,
    'Content-Type': 'application/json'
  };
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Fetch inventory - one call, instant
export async function fetchInventory() {
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
  return allProducts;
}

// Fetch sales (MTD or YTD) using CreatedSince
export async function fetchSales(createdSince) {
  const rows = [];
  let page = 1;
  let callCount = 0;

  while (true) {
    const listData = await cin7Get(
      `https://inventory.dearsystems.com/ExternalApi/v2/SaleList?Page=${page}&Limit=100&CreatedSince=${createdSince}&InvoiceStatus=INVOICED`
    );
    callCount++;
    const sales = (listData.SaleList || []).filter(s =>
      s.SaleID && s.Status !== 'VOIDED' && s.Status !== 'DELETED' &&
      !['blake\'s seed based','amazon seller','shopify'].includes((s.Customer||'').toLowerCase())
    );

    console.log(`Sales page ${page}: ${sales.length} records`);
    if (sales.length === 0 && (listData.SaleList||[]).length === 0) break;

    for (const sale of sales) {
      await sleep(600);
      callCount++;
      if (callCount % 50 === 0) {
        console.log('Pausing 62s for rate limit...');
        await sleep(62000);
      }
      try {
        const saleData = await cin7Get(
          `https://inventory.dearsystems.com/ExternalApi/v2/sale?SaleID=${sale.SaleID}`
        );
        const fullSale = saleData.Sale || saleData;
        const customer = fullSale.Customer || sale.Customer || '';
        const salesRep = fullSale.SalesRepresentative || '';
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
            salesRep,
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

    if ((listData.SaleList||[]).length < 100) break;
    page++;
    await sleep(500);
  }
  return rows;
}

// Fetch open orders
export async function fetchOpenOrders() {
  const rows = [];
  let page = 1;
  let callCount = 0;

  while (true) {
    const listData = await cin7Get(
      `https://inventory.dearsystems.com/ExternalApi/v2/SaleList?Page=${page}&Limit=100&OrderStatus=OPEN`
    );
    callCount++;
    const sales = (listData.SaleList || []).filter(s => s.SaleID);
    if (sales.length === 0 && (listData.SaleList||[]).length === 0) break;

    for (const sale of sales) {
      await sleep(600);
      callCount++;
      if (callCount % 50 === 0) {
        console.log('Pausing 62s for rate limit...');
        await sleep(62000);
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
            shipmentDate: fullSale.ShipmentDate || '',
            shipBy: fullSale.ShipBy || '',
            status: fullSale.Status || sale.Status || '',
            orderNumber: fullSale.OrderNumber || sale.OrderNumber || '',
            qty: line.Quantity || 0,
            total: parseFloat(line.Total) || 0,
            discount: parseFloat(line.Discount) || 0,
            tax: parseFloat(line.Tax) || 0,
            shippingAddress: shipAddr.Line1 || '',
            city: shipAddr.City || '',
            state: shipAddr.State || '',
            postcode: shipAddr.Postcode || '',
            channel: fullSale.Channel || '',
            customerRef: fullSale.CustomerReference || '',
            requiredBy: fullSale.RequiredBy || ''
          });
        }
      } catch (e) {
        console.log(`Skipping order ${sale.SaleID}: ${e.message}`);
      }
    }

    if ((listData.SaleList||[]).length < 100) break;
    page++;
    await sleep(500);
  }
  return rows;
}
