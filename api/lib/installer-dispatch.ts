// api/lib/installer-dispatch.ts
//
// Runs from order-router.ts (orders/paid webhook), AFTER Shopify has
// confirmed payment. Creates the Airtable "Installation Jobs" record and
// sends the customer confirmation email.
//
// Deliberately NOT run client-side / pre-payment (see CheckoutModal.tsx in
// gci-brain, fixed 2026-07-01) -- this is what prevents dispatching an
// installer against an order that was never actually paid for.
//
// The installation fee amount is read from the REAL Shopify order line
// items (SKU prefix INSTALL-FEE-), not from any client-supplied number --
// this must reflect what Shopify actually confirms was charged.

const GCI_BRAIN_API_URL = process.env.GCI_BRAIN_API_URL || 'https://gci-brain.vercel.app';
const INSTALL_FEE_SKU_PREFIX = 'INSTALL-FEE-';

export interface OrderLineItemLike {
  sku: string;
  title: string;
  quantity: number;
  price: string;
}

export interface InstallerDispatchInput {
  shopifyOrderId: number;
  orderNumber: string;       // "#1042"
  customerEmail: string;
  customerName: string;
  customerPhone?: string;
  customerAddress?: string;
  lineItems: OrderLineItemLike[];
  installerId: string;       // Airtable record ID for the Installers table
  installerName: string;
  lang?: 'en' | 'fr';
}

interface DispatchResult {
  ok: boolean;
  installationJobCreated: boolean;
  emailSent: boolean;
  errors: string[];
}

// --- Compute what was actually charged for installation, from the real order ---

function computeInstallationFeeCharged(lineItems: OrderLineItemLike[]): {
  totalFee: number;
  tireLine: OrderLineItemLike | null;
} {
  let totalFee = 0;
  let tireLine: OrderLineItemLike | null = null;

  for (const item of lineItems) {
    const sku = (item.sku ?? '').toUpperCase();
    if (sku.startsWith(INSTALL_FEE_SKU_PREFIX)) {
      totalFee += parseFloat(item.price) * item.quantity;
    } else if (!tireLine) {
      // First non-fee line item is treated as "the tire" for the job
      // description. Multi-tire-model orders aren't handled by this path
      // yet -- AI Match currently only ever adds one tire model per cart.
      tireLine = item;
    }
  }

  return { totalFee, tireLine };
}

// --- Airtable: create Installation Jobs record via gci-brain's proxy ---

async function createInstallationJobRecord(input: InstallerDispatchInput, fee: number, tireLine: OrderLineItemLike | null): Promise<void> {
  const res = await fetch(`${GCI_BRAIN_API_URL}/api/airtable`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      table: 'Installation Jobs',
      method: 'POST',
      body: {
        fields: {
          'Customer Name':      input.customerName,
          'Customer Email':     input.customerEmail,
          'Customer Phone':     input.customerPhone ?? '',
          'Customer Address':   input.customerAddress ?? '',
          'Tire Details':       tireLine?.title ?? '',
          'Quantity':           tireLine?.quantity ?? 0,
          'Installation Fee':   fee,
          'Status':             'Pending',
          'Shopify Order ID':   input.orderNumber,
          'Assigned Installer': [input.installerId],
        },
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Airtable Installation Job create failed: ${res.status} ${text.slice(0, 300)}`);
  }
}

// --- Email: reuse gci-brain's existing Resend-backed endpoint ---

async function sendInstallConfirmationEmail(input: InstallerDispatchInput, fee: number, tireLine: OrderLineItemLike | null): Promise<void> {
  const res = await fetch(`${GCI_BRAIN_API_URL}/api/send-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: input.customerEmail,
      name: input.customerName,
      orderNumber: input.orderNumber,
      tire: tireLine?.title ?? '',
      quantity: tireLine?.quantity ?? 0,
      total: fee, // installation-specific confirmation; tire payment already confirmed by Shopify's own receipt
      withInstallation: true,
      installerName: input.installerName,
      lang: input.lang ?? 'en',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Confirmation email send failed: ${res.status} ${text.slice(0, 300)}`);
  }
}

// --- Entry point ---

export async function dispatchInstaller(input: InstallerDispatchInput): Promise<DispatchResult> {
  const errors: string[] = [];
  const { totalFee, tireLine } = computeInstallationFeeCharged(input.lineItems);

  let installationJobCreated = false;
  let emailSent = false;

  try {
    await createInstallationJobRecord(input, totalFee, tireLine);
    installationJobCreated = true;
  } catch (err: any) {
    errors.push(`Installation Job: ${err.message}`);
  }

  try {
    await sendInstallConfirmationEmail(input, totalFee, tireLine);
    emailSent = true;
  } catch (err: any) {
    errors.push(`Confirmation email: ${err.message}`);
  }

  return {
    ok: installationJobCreated && emailSent,
    installationJobCreated,
    emailSent,
    errors,
  };
}
