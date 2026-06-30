import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getWalmartToken } from './lib/walmart-client';

export const maxDuration = 30;

const WALMART_BASE_URL = process.env.WALMART_BASE_URL!;

function walmartHeaders(token: string): Record<string, string> {
  return {
    'WM_SEC.ACCESS_TOKEN': token,
    'WM_GLOBAL_VERSION': '3.1',
    'WM_MARKET': 'ca',
    'WM_SVC.NAME': 'Walmart Marketplace',
    'WM_QOS.CORRELATION_ID': crypto.randomUUID(),
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };
}

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const token = await getWalmartToken();
    const since = new Date('2026-06-25T00:00:00Z').toISOString();
    const url = `${WALMART_BASE_URL}/v3/orders?createdStartDate=${encodeURIComponent(since)}&limit=200`;
    const r = await fetch(url, { headers: walmartHeaders(token) });
    const data = await r.json();
    const orders = data?.list?.elements?.order ?? [];
    const summary = orders.map((o: any) => ({
      purchaseOrderId: o.purchaseOrderId,
      orderDate: new Date(o.orderDate).toISOString(),
      customerName: o.shippingInfo?.postalAddress?.name,
    }));
    return res.status(200).json({ count: summary.length, orders: summary });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
