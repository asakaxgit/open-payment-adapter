# open-payment-adapter

Provider-agnostic **SaaS billing** payment port with multi-PSP adapters.

There is no widely adopted open standard for subscription orchestration
(Checkout / Customer Portal / signed webhooks / plan mapping). This package owns
a hexagonal `PaymentProvider` port and normalizes PSP webhooks into domain events.

## Install

```bash
npm install open-payment-adapter
# Stripe adapter peer (optional until you use stripe):
npm install stripe
```

## Quick start

```ts
import { getPaymentProvider, configurePriceCatalog } from 'open-payment-adapter';

configurePriceCatalog({
  stripe: { pro: 'price_xxx', business: 'price_yyy' },
  paddle: { pro: 'pri_xxx' },
});

const payments = getPaymentProvider(); // PAYMENT_PROVIDER, default stripe

const { url } = await payments.createCheckout({
  accountId: 'acct_1',
  accountName: 'Acme',
  planKey: 'pro',
  successUrl: 'https://app.example.com/billing/success',
  cancelUrl: 'https://app.example.com/billing/cancel',
});

// Webhook
const events = await payments.verifyAndParseWebhook({
  rawBody,
  headers: request.headers,
});
```

## Env

```bash
PAYMENT_PROVIDER=stripe   # stripe | paddle | lemon_squeezy | polar | chargebee

# Stripe
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

# Paddle / Lemon Squeezy / Polar / Chargebee — see adapters

# Webhook replay tolerance in seconds (default 300, 0 disables the check)
PADDLE_WEBHOOK_TOLERANCE_SECONDS=
POLAR_WEBHOOK_TOLERANCE_SECONDS=
```

## Webhook replay protection

Signature verification proves a payload was signed with your secret, not that
it was signed recently. Adapters whose PSP signs a timestamp reject deliveries
outside a 300s tolerance window (Stripe enforces this internally; Paddle and
Polar are checked by this package).

**Lemon Squeezy is the exception:** its `X-Signature` is a bare HMAC of the
request body with no timestamp, so a captured delivery stays valid
indefinitely. If you use that adapter, deduplicate on the event id in your own
handler — the library is stateless and cannot do it for you.

Plan ↔ price IDs are configured via `configurePriceCatalog()` (preferred) or
env vars of the form `{PROVIDER}_PRICE_{PLAN_KEY}` / provider-specific prefixes.
Both directions work with either method: webhook parsing maps a provider price
id back to your plan key.

Env-derived keys are normalized, since the env name uppercases the key and
collapses non-alphanumerics — a plan key of `pro-plus` becomes
`STRIPE_PRICE_PRO_PLUS` and reverse-resolves as `pro_plus`. Use
`configurePriceCatalog()` when you need your exact key spelling back.

## Stripe

`checkout.session.completed` emits `subscription.activated` only when
`payment_status` is `paid` or `no_payment_required`. An `unpaid` session
(delayed methods such as bank debit) waits for a later event:

| Stripe event | Billing event |
|---|---|
| `checkout.session.async_payment_succeeded` | `subscription.activated` |
| `checkout.session.async_payment_failed` | `checkout.async_payment_failed` |
| `checkout.session.expired` | `checkout.expired` |

`customer.subscription.updated` with status `incomplete` emits nothing, so a
plan is not granted before the first invoice is paid. `incomplete_expired`
still emits `subscription.canceled`.

`createCheckout` takes two optional fields. `providerCustomerId` reuses that
customer instead of searching or creating one. `expiresAt` is a unix timestamp
in seconds and is sent as Stripe `expires_at` (30 minutes to 24 hours from
creation). Other adapters ignore both.

One Stripe customer may be shared by several accounts. The adapter does not
overwrite an existing `customer.metadata.account_id` (`workspace_id` and
`accountId` count as already set). The subscription is tagged with the
checkout's `accountId`, and subscription/invoice reads use that metadata.
`getSubscriptionInfo` no longer takes the customer's single newest
subscription. `invoice.payment_failed` reads
`invoice.parent.subscription_details.metadata` first, then older shapes
(`subscription_details`, `invoice.subscription`, line metadata,
`invoice.metadata`) and only then the customer.

Subscription search is eventually consistent and cannot mix `AND` with `OR`.
When customer metadata already matches the account, reads use
`subscriptions.list` (limit 100) and filter in process. When it does not
(the shared-customer case), they search `metadata['account_id']`.

## Supported providers

| Id | Adapter |
|---|---|
| `stripe` | Stripe Checkout / Portal / webhooks |
| `paddle` | Paddle Billing |
| `lemon_squeezy` | Lemon Squeezy |
| `polar` | Polar |
| `chargebee` | Chargebee |

## Releasing

npm publish runs from `.github/workflows/publish.yml` when a GitHub Release
is published (`workflow_dispatch` can run the same job). Do not publish from
a laptop.

1. Set `version` in `package.json` to the version you are shipping.
2. Merge that commit to `main`.
3. Publish a GitHub Release whose tag is `v` plus that version (`v0.2.0`
   for `0.2.0`) and whose target is `main`.
4. The workflow runs `npm ci`, typecheck, and test, then checks that the tag
   (without the `v`) equals `package.json` `version`, then
   `npm publish --access public`.
   Auth is npm trusted publishing (OIDC). There is no `NPM_TOKEN`.
   `prepack` runs `npm run build` before the pack.

`workflow_dispatch` skips the tag check. Prefer the release path.

## What stays in your app

- Persisting plan changes from `BillingEvent`s
- Product-specific plan enums / limits
- Email copy for payment-failed

## License

MIT

## Testing / mocks

```ts
import {
  createMockPaymentProvider,
  PROVIDER_WEBHOOK_FIXTURES,
} from 'open-payment-adapter/testing';
import { setPaymentProviderOverride, getPaymentProvider } from 'open-payment-adapter';
import { paddlePayloadToBillingEvents } from 'open-payment-adapter'; // or adapter path

// 1) Inject a mock provider (no network)
const mock = createMockPaymentProvider({ id: 'paddle' });
setPaymentProviderOverride(mock);
await getPaymentProvider().createCheckout({ /* ... */ });

// 2) Assert PSP payload → BillingEvent mappers with fixtures
for (const fixture of PROVIDER_WEBHOOK_FIXTURES) {
  // map with the matching *PayloadToBillingEvents helper
}
```

Fixtures cover Paddle, Lemon Squeezy, Polar, Chargebee (activated + canceled) plus a Stripe Checkout session object helper (`payment_status: 'paid'`).

