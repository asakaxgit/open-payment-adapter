# Changelog

## 0.2.0

Public types and Stripe webhook/read behavior changed, so this is a minor bump
on 0.x rather than 0.1.2. Existing `BillingEvent` variants are unchanged;
`checkout.async_payment_failed` and `checkout.expired` are new discriminants.
A `switch` that exhausts `BillingEvent` with `never` needs a branch for them.
Not 1.0.0: the package is still 0.x, and callers that ignore unknown event
types keep working.

### Added

- `BillingEvent` variants `checkout.async_payment_failed` and `checkout.expired`.
- `checkout.session.async_payment_succeeded` emits `subscription.activated`.
- `CreateCheckoutInput.providerCustomerId` reuses an existing provider customer.
- `CreateCheckoutInput.expiresAt` (unix seconds) maps to Stripe `expires_at`.

### Changed

- `checkout.session.completed` emits `subscription.activated` only when
  `payment_status` is `paid` or `no_payment_required`. `unpaid` emits nothing;
  wait for the async payment event.
- `customer.subscription.updated` with status `incomplete` no longer emits
  `subscription.updated` (no plan grant). `incomplete_expired` still emits
  `subscription.canceled`.
- `ensureCustomerAccountMetadata` does not overwrite an existing
  `customer.metadata.account_id`, or the `workspace_id` / `accountId` aliases.
  One customer can be shared across accounts. The subscription's own
  `account_id` is the tenant key.
- `getSubscriptionInfo` and `listInvoices` keep only subscriptions whose
  metadata account id matches the requested account. The old `limit: 1` list
  on the customer is gone: a shared customer's newest subscription is not
  assumed to be this account's.
- `invoice.payment_failed` resolves the account from
  `invoice.parent.subscription_details.metadata`, then older payload shapes,
  and only then from the customer.

### Testing

- `stripeCheckoutSessionCompletedObject` now includes `payment_status: 'paid'`.

## 0.1.1

- `open-payment-adapter/testing` export with a mock provider and per-SaaS webhook fixtures.

## 0.1.0

- Provider-agnostic `PaymentProvider` port and Stripe, Paddle, Lemon Squeezy, Polar, and Chargebee adapters.
