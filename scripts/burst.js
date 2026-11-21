'use strict';

// Fire many bids at the same instant against a running server.
// Usage: npm run burst -- <auctionId> [count]
// (The System page has the same test built in, with invariant checks.)

const { createClient } = require('../src/http-client');

const base = process.env.BASE_URL || 'http://localhost:3000';
const auctionId = process.argv[2];
const count = Number(process.argv[3]) || 200;

(async () => {
  const client = createClient();
  if (!auctionId) {
    const { body } = await client.get(`${base}/api/auctions?status=live`);
    console.log('Live auctions:');
    for (const a of body.auctions) console.log(`  ${a.id}  ${a.title}`);
    console.log('\nUsage: npm run burst -- <auctionId> [count]');
    return client.close();
  }
  const before = (await client.get(`${base}/api/auctions/${auctionId}`)).body;
  if (!before.auction) throw new Error(`auction "${auctionId}" not found`);
  if (before.auction.status !== 'open') throw new Error(`auction "${auctionId}" is not open`);
  const { minNextBid, minIncrement } = before.auction;

  const amounts = Array.from({ length: count }, (_, i) => minNextBid + i * minIncrement).sort(() => Math.random() - 0.5);
  const t0 = Date.now();
  const results = await Promise.all(
    amounts.map((amount, i) =>
      client.post(`${base}/api/auctions/${auctionId}/bids`, { bidId: `burst-${t0}-${i}`, bidder: `bot${i}`, amount })),
  );
  const accepted = results.filter((r) => r.body.accepted).length;
  const after = (await client.get(`${base}/api/auctions/${auctionId}`)).body;
  const verify = (await client.get(`${base}/api/auctions/${auctionId}/verify`)).body;
  console.log(`Sent ${count} bids in ${Date.now() - t0}ms: ${accepted} accepted, ${count - accepted} rejected`);
  console.log(`Highest sent: ${Math.max(...amounts)} | Current price: ${after.auction.currentPrice} | Leader: ${after.auction.leader}`);
  console.log(`Invariants: ${verify.ok ? 'all pass' : 'FAILED'}`);
  client.close();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
