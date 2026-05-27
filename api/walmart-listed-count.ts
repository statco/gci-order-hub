import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getWalmartToken } from './lib/walmart-client';

export const config = { maxDuration: 60 };

async function fetchCount(token: string, params: string): Promise<{ totalItems: number; keys: string[] }> {
  const url = `${process.env.WALMART_BASE_URL}/v3/items?limit=1${params ? '&' + params : ''}`;
  const res = await fetch(url, {
    headers: {
      'WM_SEC.ACCESS_TOKEN':   token,
      'WM_GLOBAL_VERSION':     '3.1',
      'WM_MARKET':             'ca',
      'WM_SVC.NAME':           'Walmart Marketplace',
      'WM_QOS.CORRELATION_ID': crypto.randomUUID(),
      'Accept':                'application/json',
    },
  });
  const data = await res.json();
  return {
    totalItems: data?.totalItems ?? null,
    keys:       Object.keys(data ?? {}),
  };
}

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');

  const token = await getWalmartToken();

  const [publishedActive, publishedInactive, unpublishedActive, noFilter] = await Promise.all([
    fetchCount(token, 'publishedStatus=PUBLISHED&lifecycleStatus=ACTIVE'),
    fetchCount(token, 'publishedStatus=PUBLISHED&lifecycleStatus=INACTIVE'),
    fetchCount(token, 'publishedStatus=UNPUBLISHED&lifecycleStatus=ACTIVE'),
    fetchCount(token, ''),
  ]);

  console.log('PUBLISHED+ACTIVE:',    publishedActive.totalItems);
  console.log('PUBLISHED+INACTIVE:',  publishedInactive.totalItems);
  console.log('UNPUBLISHED+ACTIVE:',  unpublishedActive.totalItems);
  console.log('no filter:',           noFilter.totalItems);
  console.log('response keys (no filter):', noFilter.keys);

  return res.status(200).json({
    'PUBLISHED+ACTIVE':   publishedActive.totalItems,
    'PUBLISHED+INACTIVE': publishedInactive.totalItems,
    'UNPUBLISHED+ACTIVE': unpublishedActive.totalItems,
    'no_filter':          noFilter.totalItems,
    responseKeys:         noFilter.keys,
  });
}
