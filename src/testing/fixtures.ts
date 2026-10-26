/**
 * SaaS webhook payload fixtures + expected normalized BillingEvents.
 * Use these to unit-test payload→event mappers without live PSP credentials.
 */

import type { BillingEvent, PaymentProviderId } from '../types.js';

export const FIXTURE_ACCOUNT_ID = 'acct_test_1';
export const FIXTURE_PLAN_KEY = 'pro';
export const FIXTURE_CUSTOMER_ID = 'cus_test_1';
export const FIXTURE_INVOICE_ID = 'inv_test_1';

export type ProviderWebhookFixture = {
  provider: PaymentProviderId;
  description: string;
  /** Raw JSON body a PSP would POST to your webhook. */
  payload: unknown;
  /** Billing events the adapter mapper should emit for `payload`. */
  expectedEvents: BillingEvent[];
};

export function fixtureActivated(provider: PaymentProviderId): BillingEvent {
  return {
    type: 'subscription.activated',
    accountId: FIXTURE_ACCOUNT_ID,
    planKey: FIXTURE_PLAN_KEY,
    providerCustomerId: FIXTURE_CUSTOMER_ID,
    provider,
  };
}

export function fixtureCanceled(provider: PaymentProviderId): BillingEvent {
  return {
    type: 'subscription.canceled',
    accountId: FIXTURE_ACCOUNT_ID,
    provider,
  };
}

export function fixturePaymentFailed(provider: PaymentProviderId): BillingEvent {
  return {
    type: 'invoice.payment_failed',
    accountId: FIXTURE_ACCOUNT_ID,
    invoiceId: FIXTURE_INVOICE_ID,
    provider,
  };
}

/** Paddle Billing `subscription.activated` */
export const paddleSubscriptionActivatedFixture: ProviderWebhookFixture = {
  provider: 'paddle',
  description: 'subscription.activated',
  payload: {
    event_type: 'subscription.activated',
    data: {
      id: 'sub_pdl_1',
      customer_id: FIXTURE_CUSTOMER_ID,
      status: 'active',
      custom_data: { account_id: FIXTURE_ACCOUNT_ID, plan: FIXTURE_PLAN_KEY },
      items: [{ price: { id: 'pri_pro_test' } }],
    },
  },
  expectedEvents: [fixtureActivated('paddle')],
};

/** Paddle Billing `subscription.canceled` */
export const paddleSubscriptionCanceledFixture: ProviderWebhookFixture = {
  provider: 'paddle',
  description: 'subscription.canceled',
  payload: {
    event_type: 'subscription.canceled',
    data: {
      id: 'sub_pdl_1',
      customer_id: FIXTURE_CUSTOMER_ID,
      status: 'canceled',
      custom_data: { account_id: FIXTURE_ACCOUNT_ID, plan: FIXTURE_PLAN_KEY },
      items: [{ price: { id: 'pri_pro_test' } }],
    },
  },
  expectedEvents: [fixtureCanceled('paddle')],
};

/** Lemon Squeezy `subscription_created` */
export const lemonSqueezySubscriptionCreatedFixture: ProviderWebhookFixture = {
  provider: 'lemon_squeezy',
  description: 'subscription_created',
  payload: {
    meta: {
      event_name: 'subscription_created',
      custom_data: { account_id: FIXTURE_ACCOUNT_ID, plan: FIXTURE_PLAN_KEY },
    },
    data: {
      id: 'sub_ls_1',
      attributes: {
        customer_id: FIXTURE_CUSTOMER_ID,
        variant_id: 'variant_pro_test',
        status: 'active',
      },
    },
  },
  expectedEvents: [fixtureActivated('lemon_squeezy')],
};

/** Lemon Squeezy `subscription_cancelled` */
export const lemonSqueezySubscriptionCancelledFixture: ProviderWebhookFixture = {
  provider: 'lemon_squeezy',
  description: 'subscription_cancelled',
  payload: {
    meta: {
      event_name: 'subscription_cancelled',
      custom_data: { account_id: FIXTURE_ACCOUNT_ID, plan: FIXTURE_PLAN_KEY },
    },
    data: {
      id: 'sub_ls_1',
      attributes: {
        customer_id: FIXTURE_CUSTOMER_ID,
        variant_id: 'variant_pro_test',
        status: 'cancelled',
      },
    },
  },
  expectedEvents: [fixtureCanceled('lemon_squeezy')],
};

/** Polar `subscription.created` */
export const polarSubscriptionCreatedFixture: ProviderWebhookFixture = {
  provider: 'polar',
  description: 'subscription.created',
  payload: {
    type: 'subscription.created',
    data: {
      id: 'sub_polar_1',
      customer_id: FIXTURE_CUSTOMER_ID,
      product_id: 'prod_pro_test',
      status: 'active',
      metadata: { account_id: FIXTURE_ACCOUNT_ID, plan: FIXTURE_PLAN_KEY },
    },
  },
  expectedEvents: [fixtureActivated('polar')],
};

/** Polar `subscription.canceled` */
export const polarSubscriptionCanceledFixture: ProviderWebhookFixture = {
  provider: 'polar',
  description: 'subscription.canceled',
  payload: {
    type: 'subscription.canceled',
    data: {
      id: 'sub_polar_1',
      customer_id: FIXTURE_CUSTOMER_ID,
      product_id: 'prod_pro_test',
      status: 'canceled',
      metadata: { account_id: FIXTURE_ACCOUNT_ID, plan: FIXTURE_PLAN_KEY },
    },
  },
  expectedEvents: [fixtureCanceled('polar')],
};

/** Chargebee `subscription_created` */
export const chargebeeSubscriptionCreatedFixture: ProviderWebhookFixture = {
  provider: 'chargebee',
  description: 'subscription_created',
  payload: {
    event_type: 'subscription_created',
    content: {
      subscription: {
        id: 'sub_cb_1',
        customer_id: FIXTURE_CUSTOMER_ID,
        status: 'active',
        meta_data: { account_id: FIXTURE_ACCOUNT_ID, plan: FIXTURE_PLAN_KEY },
        subscription_items: [{ item_price_id: 'pro-USD-Monthly' }],
      },
      customer: {
        id: FIXTURE_CUSTOMER_ID,
        meta_data: { account_id: FIXTURE_ACCOUNT_ID },
      },
    },
  },
  expectedEvents: [fixtureActivated('chargebee')],
};

/** Chargebee `subscription_cancelled` */
export const chargebeeSubscriptionCancelledFixture: ProviderWebhookFixture = {
  provider: 'chargebee',
  description: 'subscription_cancelled',
  payload: {
    event_type: 'subscription_cancelled',
    content: {
      subscription: {
        id: 'sub_cb_1',
        customer_id: FIXTURE_CUSTOMER_ID,
        status: 'cancelled',
        meta_data: { account_id: FIXTURE_ACCOUNT_ID, plan: FIXTURE_PLAN_KEY },
        subscription_items: [{ item_price_id: 'pro-USD-Monthly' }],
      },
      customer: {
        id: FIXTURE_CUSTOMER_ID,
        meta_data: { account_id: FIXTURE_ACCOUNT_ID },
      },
    },
  },
  expectedEvents: [fixtureCanceled('chargebee')],
};

/**
 * Stripe `checkout.session.completed` object only.
 * Wrap in a Stripe.Event in tests. Omit `subscription` so mappers can resolve
 * planKey from metadata without calling stripe.subscriptions.retrieve.
 * `payment_status` is `paid` — `unpaid` sessions do not activate.
 */
export const stripeCheckoutSessionCompletedObject = {
  id: 'cs_test_1',
  object: 'checkout.session',
  mode: 'subscription',
  payment_status: 'paid',
  client_reference_id: FIXTURE_ACCOUNT_ID,
  // Keep null so unit tests do not need a live/mocked Stripe SDK client.
  customer: null,
  subscription: null,
  metadata: {
    account_id: FIXTURE_ACCOUNT_ID,
    workspace_id: FIXTURE_ACCOUNT_ID,
    plan: FIXTURE_PLAN_KEY,
  },
};

/** Activated + canceled fixtures for every non-Stripe PSP mapper. */
export const PROVIDER_WEBHOOK_FIXTURES: ProviderWebhookFixture[] = [
  paddleSubscriptionActivatedFixture,
  paddleSubscriptionCanceledFixture,
  lemonSqueezySubscriptionCreatedFixture,
  lemonSqueezySubscriptionCancelledFixture,
  polarSubscriptionCreatedFixture,
  polarSubscriptionCanceledFixture,
  chargebeeSubscriptionCreatedFixture,
  chargebeeSubscriptionCancelledFixture,
];
