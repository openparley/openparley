// Creates the OpenParley Team product ($19/month, 31-day free trial) in Polar and prints its id for POLAR_PRODUCT_TEAM.
// The Free plan has no Polar product.
//   POLAR_SERVER=sandbox POLAR_ACCESS_TOKEN=… bun ee/cloud/scripts/create-polar-product.ts
// The token needs the products:write scope. Run it once per Polar environment (sandbox, production).
import { PLANS, TRIAL_DAYS } from '../src/plans';

const server = process.env.POLAR_SERVER ?? 'sandbox';
if (server !== 'sandbox' && server !== 'production') throw new Error(`Invalid POLAR_SERVER: ${server}`);
const token = process.env.POLAR_ACCESS_TOKEN;
if (!token) throw new Error('Set POLAR_ACCESS_TOKEN (an organization access token with products:write).');
const api = process.env.POLAR_API_URL ?? (server === 'sandbox' ? 'https://sandbox-api.polar.sh' : 'https://api.polar.sh');

const plan = PLANS.team;
const res = await fetch(`${api}/v1/products/`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify({
    name: `OpenParley ${plan.name}`,
    description: `Hosted OpenParley for your team. ${plan.summary}`,
    recurring_interval: 'month',
    trial_interval: 'day',
    trial_interval_count: TRIAL_DAYS,
    prices: [{ amount_type: 'fixed', price_amount: 1900, price_currency: 'usd' }],
    metadata: { plan: plan.id },
  }),
});
if (!res.ok) throw new Error(`Polar answered ${res.status}: ${(await res.text()).slice(0, 1000)}`);
const product = (await res.json()) as { id: string; name: string };
console.log(`Created "${product.name}" in Polar ${server}.\n  POLAR_PRODUCT_TEAM=${product.id}`);
