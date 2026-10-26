/**
 * Provider-agnostic SaaS billing types.
 *
 * Apps map their own plan enums onto opaque `planKey` strings.
 * `accountId` is the tenant/workspace/org id in the consuming app.
 */

export type PaymentProviderId =
  | 'stripe'
  | 'paddle'
  | 'lemon_squeezy'
  | 'polar'
  | 'chargebee';

export type BillingInvoice = {
  id: string;
  date: Date | null;
  amount: number;
  currency: string;
  status: string;
  pdfUrl: string | null;
};

export type SubscriptionInfo = {
  renewalDate: Date | null;
  status: string | null;
  providerCustomerId: string | null;
};

export type CreateCheckoutInput = {
  accountId: string;
  accountName: string;
  accountSlug?: string;
  /** Opaque plan key defined by the consuming app (e.g. "pro"). */
  planKey: string;
  customerEmail?: string | null;
  /**
   * Existing provider customer id (`cus_...` for Stripe).
   * When set, the adapter reuses it instead of searching or creating a customer.
   * One customer may be shared by several accounts; the new subscription is
   * still tagged with `accountId`.
   */
  providerCustomerId?: string | null;
  /**
   * Unix timestamp (seconds) when the checkout session should expire.
   * Stripe allows 30 minutes to 24 hours from creation. Omitted by adapters
   * that have no equivalent.
   */
  expiresAt?: number | null;
  successUrl: string;
  cancelUrl: string;
};

export type CreateCheckoutResult = {
  url: string;
  providerCustomerId: string;
};

export type CreatePortalInput = {
  accountId: string;
  returnUrl: string;
};

/**
 * Normalized billing lifecycle events — adapters map PSP webhooks into these.
 *
 * `checkout.async_payment_failed` and `checkout.expired` were added in 0.2.0.
 * Existing variants are unchanged. Handle the new discriminants or ignore them;
 * a `switch` that assigns the remainder to `never` needs a new branch.
 */
export type BillingEvent =
  | {
      type: 'subscription.activated' | 'subscription.updated';
      accountId: string;
      planKey: string;
      providerCustomerId?: string | null;
      provider: PaymentProviderId;
    }
  | {
      type: 'subscription.canceled';
      accountId: string;
      provider: PaymentProviderId;
    }
  | {
      type: 'invoice.payment_failed';
      accountId: string;
      invoiceId: string;
      provider: PaymentProviderId;
    }
  | {
      type: 'checkout.async_payment_failed' | 'checkout.expired';
      accountId: string;
      /** Checkout Session id (`cs_...` for Stripe). */
      sessionId: string;
      providerCustomerId?: string | null;
      provider: PaymentProviderId;
    };
