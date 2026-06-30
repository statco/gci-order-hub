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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const orderId = req.query.orderId as string;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });

  try {
    const token = await getWalmartToken();
    const url = `${WALMART_BASE_URL}/v3/orders/${orderId}`;
    const r = await fetch(url, { headers: walmartHeaders(token) });
    const data = await r.json();
    return res.status(200).json(data);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
