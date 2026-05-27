import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getWalmartToken } from './lib/walmart-client';
import { v4 as uuidv4 } from 'uuid';

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');

  const token = await getWalmartToken();

  const raw = await fetch(
    `${process.env.WALMART_BASE_URL}/v3/items?limit=5&publishedStatus=PUBLISHED&lifecycleStatus=ACTIVE`,
    {
      headers: {
        'WM_SEC.ACCESS_TOKEN': token,
        'WM_GLOBAL_VERSION': '3.1',
        'WM_MARKET': 'ca',
        'WM_SVC.NAME': 'Walmart Marketplace',
        'WM_QOS.CORRELATION_ID': uuidv4(),
        'Accept': 'application/json',
      }
    }
  );

  const data = await raw.json();

  return res.status(200).json({
    status: raw.status,
    topLevelKeys: Object.keys(data),
    fullResponse: JSON.stringify(data).slice(0, 1000)
  });
}
