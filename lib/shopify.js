// Shopify API helper

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function shopifyGet(url) {
  const res = await fetch(url, {
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
      'Content-Type': 'application/json'
    }
  });
  if (res.status !== 200) {
    const text = await res.text();
    throw new Error(`Shopify API ${res.status}: ${text.substring(0, 200)}`);
  }
  const data = await res.json();
  const linkHeader = res.headers.get('Link') || '';
  const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return { data, nextUrl: nextMatch ? nextMatch[1] : null };
}

export async function fetchShopifySales(startDate, endDate) {
  const rows = [];
  let url = `https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json?status=any&created_at_min=${startDate.toISOString()}&created_at_max=${endDate.toISOString()}&limit=250&fields=id,line_items,financial_status,created_at,total_tax`;

  while (url) {
    const { data, nextUrl } = await shopifyGet(url);
    const orders = data.orders || [];

    for (const order of orders) {
      if (order.financial_status === 'refunded') continue;
      for (const item of (order.line_items || [])) {
        const qty = parseFloat(item.quantity) || 0;
        const price = parseFloat(item.price) || 0;
        const discount = parseFloat(item.total_discount) || 0;
        rows.push({
          sku: item.sku || '',
          name: item.title || '',
          variantTitle: item.variant_title || '',
          qty,
          grossSales: qty * price,
          discounts: -discount,
          netSales: (qty * price) - discount,
          orderId: order.id
        });
      }
    }

    url = nextUrl;
    if (url) await sleep(500);
  }
  return rows;
}
