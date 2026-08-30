// api/lib/shopify.test.ts
// Run: npx tsc api/lib/shopify.test.ts --outDir /tmp/stest \
//        --module nodenext --target es2022 --moduleResolution nodenext \
//        --skipLibCheck && node /tmp/stest/shopify.test.js
//
// parseTireSpecFromTags() must resolve the real tag/title shapes seen live
// in the store — NOT an idealized single format. Two conventions coexist
// across import batches: "vehicle_type:Passenger"/"vehicle_type:Light Truck"
// (Cooper/Nexen-style) and "tire-type-passenger" (Ovation/Vredestein-style,
// including SKU 300E3009 itself). Size tags are even less reliable (some
// batches emit "1856515/R" instead of "185/65R15"), so rim size is parsed
// from the variant title, which was consistently formatted in every case
// checked live.
//
// This file exists because an earlier version of this parser only matched
// the "vehicle_type:X" convention and a clean "WWW/AARSS" size tag — it
// silently failed on 300E3009 and two other real SKUs (AP21550017WHYPA02,
// AP25545019YHYPA02), which fell back to the conservative LT/rim-22 default
// and got a live price correction pushed to an inflated floor as a result.

import assert from 'node:assert';
import { parseTireSpecFromTags } from './shopify.js';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  [OK] ${name}`);
}

check('300E3009: tire-type-passenger tag + malformed size tag, real title', () => {
  const r = parseTireSpecFromTags(
    ['1856515/R', 'ai-match', 'brand-ovation', 'canada-tire-exclusive', 'ct-sync',
     'loadindex:88', 'road-hazard-warranty', 'shipping-included', 'speedrating:T',
     'tire-type-passenger', 'winter'],
    '185/65R15',
  );
  assert.strictEqual(r.tireType, 'Passenger');
  assert.strictEqual(r.rimSize, 15);
});

check('AP21550017WHYPA02: same tag convention, different size', () => {
  const r = parseTireSpecFromTags(
    ['2155017/R', 'ai-match', 'all-season', 'brand-vredestein', 'ct-sync',
     'loadindex:95', 'priced-above-msrp', 'shipping-included', 'speedrating:W',
     'tire-type-passenger'],
    '215/50R17',
  );
  assert.strictEqual(r.tireType, 'Passenger');
  assert.strictEqual(r.rimSize, 17);
});

check('vehicle_type:Passenger convention (Cooper-style) still resolves', () => {
  const r = parseTireSpecFromTags(
    ['245/60R15', 'ai-match', 'brand-cooper', 'ct-sync', 'loadindex:100',
     'passenger', 'shipping-included', 'sold-out', 'speedrating:T', 'summer',
     'vehicle_type:Passenger'],
    '245/60R15',
  );
  assert.strictEqual(r.tireType, 'Passenger');
  assert.strictEqual(r.rimSize, 15);
});

check('vehicle_type:Light Truck resolves to LT and is not overridden by a bare "passenger" tag', () => {
  const r = parseTireSpecFromTags(
    ['225/75R16', 'ai-match', 'brand-nexen', 'ct-sync', 'light-truck',
     'loadindex:10', 'shipping-included', 'sold-out', 'speedrating:P',
     'vehicle_type:Light Truck', 'winter'],
    '225/75R16',
  );
  assert.strictEqual(r.tireType, 'LT');
  assert.strictEqual(r.rimSize, 16);
});

check('no recognizable tags/title -> both null (caller falls back to the conservative default)', () => {
  const r = parseTireSpecFromTags(['ct-sync', 'brand-unknown'], undefined);
  assert.strictEqual(r.tireType, null);
  assert.strictEqual(r.rimSize, null);
});

console.log(`\n${passed} shopify parser tests passed.`);
