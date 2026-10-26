/**
 * Stripe adapter for the PaymentProvider port.
 * All Stripe SDK usage stays in this file — domain code never imports `stripe`.
 */

import Stripe from 'stripe';
import { PaymentProviderError, type PaymentProvider } from '../provider.js';
import {
  getProviderPriceId,
  resolvePlanKeyFromProviderPriceId,
} from '../catalog.js';
import type {
  BillingEvent,
  BillingInvoice,
  CreateCheckoutInput,
  CreateCheckoutResult,
  CreatePortalInput,
  SubscriptionInfo,
} from '../types.js';

/** Test override for the Stripe SDK client. */
let stripeClientOverride: Stripe | null = null;

export function setStripeClientOverride(client: Stripe | null): void {
  stripeClientOverride = client;
}

export function getPriceIdForPlan(planKey: string): string | undefined {
  return getProviderPriceId('stripe', planKey);
}

export function resolvePlanFromPriceId(priceId: string | null | undefined): string | null {
  return resolvePlanKeyFromProviderPriceId('stripe', priceId);
}

export function getStripe(): Stripe {
  if (stripeClientOverride) return stripeClientOverride;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new PaymentProviderError('STRIPE_SECRET_KEY is not set', 'NOT_CONFIGURED');
  }
  return new Stripe(key);
}

function accountIdFromMetadata(metadata: Stripe.Metadata | null | undefined): string | null {
  const id = (metadata?.account_id ?? metadata?.workspace_id) ?? metadata?.accountId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function customerIdFrom(
  value: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined,
): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if ('deleted' in value && value.deleted) return null;
  return value.id;
}

function priceIdFromSubscription(subscription: Stripe.Subscription): string | null {
  const item = subscription.items?.data?.[0];
  const price = item?.price;
  if (!price) return null;
  return typeof price === 'string' ? price : price.id;
}

/** Statuses that still carry the plan. `incomplete` is intentionally absent. */
const BILLABLE_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due'] as const;

/**
 * Stripe Search cannot mix `AND` and `OR`, and has no parentheses.
 * Quote values the same way as the customer lookup (`metadata['account_id']:'…'`).
 */
function quoteSearchValue(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function accountMetadataClause(accountId: string): string {
  return `metadata['account_id']:${quoteSearchValue(accountId)}`;
}

function subscriptionMatchesAccount(
  subscription: Stripe.Subscription,
  accountId: string,
  statuses?: readonly string[],
): boolean {
  if (accountIdFromMetadata(subscription.metadata) !== accountId) return false;
  if (statuses && !statuses.includes(subscription.status)) return false;
  return true;
}

/**
 * Subscriptions for this account.
 *
 * Customer metadata is not a tenant key: one Stripe customer can belong to
 * several accounts, and `subscriptions.list` cannot filter on metadata.
 * When the customer lookup hits, list that customer's subscriptions (strongly
 * consistent) and keep only those tagged with `accountId` — never `limit: 1`
 * on the unfiltered customer. When the customer metadata points at a different
 * account, search by `subscription.metadata.account_id` instead.
 */
type SubscriptionLookup = {
  subscriptions: Stripe.Subscription[];
  /** Set when customer metadata already points at `accountId`. */
  customerId: string | null;
};

async function listSubscriptionsForAccount(
  stripe: Stripe,
  accountId: string,
  options: { limit: number; statuses?: readonly string[] },
): Promise<SubscriptionLookup> {
  const customerId = await findStripeCustomerIdForAccount(stripe, accountId);
  if (customerId) {
    const listed = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 100,
    });
    const filtered = listed.data.filter((subscription) =>
      subscriptionMatchesAccount(subscription, accountId, options.statuses),
    );
    if (filtered.length > 0) {
      return { subscriptions: filtered.slice(0, options.limit), customerId };
    }
  }

  try {
    if (options.statuses && options.statuses.length > 0) {
      const collected: Stripe.Subscription[] = [];
      for (const status of options.statuses) {
        const page = await stripe.subscriptions.search({
          query: `${accountMetadataClause(accountId)} AND status:${quoteSearchValue(status)}`,
          limit: options.limit,
        });
        collected.push(
          ...page.data.filter((subscription) =>
            subscriptionMatchesAccount(subscription, accountId, options.statuses),
          ),
        );
        if (collected.length >= options.limit) break;
      }
      return { subscriptions: collected.slice(0, options.limit), customerId };
    }

    const page = await stripe.subscriptions.search({
      query: accountMetadataClause(accountId),
      limit: options.limit,
    });
    return {
      subscriptions: page.data
        .filter((subscription) => subscriptionMatchesAccount(subscription, accountId))
        .slice(0, options.limit),
      customerId,
    };
  } catch {
    return { subscriptions: [], customerId };
  }
}

type LegacyInvoiceFields = {
  subscription?: string | Stripe.Subscription | null;
  subscription_details?: { metadata?: Stripe.Metadata | null } | null;
};

function legacyInvoice(invoice: Stripe.Invoice): LegacyInvoiceFields {
  return invoice as Stripe.Invoice & LegacyInvoiceFields;
}

function accountIdFromExpandedSubscription(value: unknown): string | null {
  if (!value || typeof value === 'string' || typeof value !== 'object') return null;
  const metadata = (value as { metadata?: Stripe.Metadata | null }).metadata;
  return accountIdFromMetadata(metadata ?? null);
}

function idFromSubscriptionRef(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return null;
}

/**
 * Account stamped on the subscription that produced this invoice.
 * Current API shape first (`parent.subscription_details.metadata`), then
 * older webhook payloads (`subscription_details`, expanded `subscription`,
 * line metadata — which mirrors subscription metadata — and `invoice.metadata`).
 */
function accountIdFromInvoice(invoice: Stripe.Invoice): string | null {
  const fromParent = accountIdFromMetadata(invoice.parent?.subscription_details?.metadata ?? null);
  if (fromParent) return fromParent;

  const legacy = legacyInvoice(invoice);
  const fromLegacyDetails = accountIdFromMetadata(legacy.subscription_details?.metadata ?? null);
  if (fromLegacyDetails) return fromLegacyDetails;

  const fromParentSubscription = accountIdFromExpandedSubscription(
    invoice.parent?.subscription_details?.subscription,
  );
  if (fromParentSubscription) return fromParentSubscription;

  const fromLegacySubscription = accountIdFromExpandedSubscription(legacy.subscription);
  if (fromLegacySubscription) return fromLegacySubscription;

  for (const line of invoice.lines?.data ?? []) {
    const fromLine = accountIdFromMetadata(line.metadata);
    if (fromLine) return fromLine;
  }

  return accountIdFromMetadata(invoice.metadata);
}

function subscriptionIdFromInvoice(invoice: Stripe.Invoice): string | null {
  const fromParent = idFromSubscriptionRef(invoice.parent?.subscription_details?.subscription);
  if (fromParent) return fromParent;
  return idFromSubscriptionRef(legacyInvoice(invoice).subscription);
}

function invoiceBelongsToAccount(
  invoice: Stripe.Invoice,
  accountId: string,
  subscriptionIds: ReadonlySet<string>,
): boolean {
  const tagged = accountIdFromInvoice(invoice);
  if (tagged) return tagged === accountId;
  const subscriptionId = subscriptionIdFromInvoice(invoice);
  return subscriptionId != null && subscriptionIds.has(subscriptionId);
}

function toBillingInvoice(invoice: Stripe.Invoice): BillingInvoice {
  return {
    id: invoice.id,
    date: invoice.created ? new Date(invoice.created * 1000) : null,
    amount: invoice.amount_paid ?? invoice.total ?? 0,
    currency: invoice.currency ?? 'usd',
    status: invoice.status ?? 'unknown',
    pdfUrl: invoice.invoice_pdf ?? null,
  };
}

/**
 * Link `accountId` onto the customer only when no account is stored yet.
 * A later workspace that reuses the customer must not replace `account_id`
 * (or the `workspace_id` / `accountId` aliases). The subscription carries
 * its own `account_id`.
 */
async function ensureCustomerAccountMetadata(
  stripe: Stripe,
  customerId: string,
  accountId: string,
): Promise<void> {
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) return;
  if (accountIdFromMetadata(customer.metadata)) return;
  await stripe.customers.update(customerId, {
    metadata: { account_id: accountId },
  });
}

export async function findStripeCustomerIdForAccount(
  stripe: Stripe,
  accountId: string,
): Promise<string | null> {
  try {
    const result = await stripe.customers.search({
      query: `metadata['account_id']:'${accountId}'`,
      limit: 1,
    });
    return result.data[0]?.id ?? null;
  } catch {
    const listed = await stripe.customers.list({ limit: 100 });
    const match = listed.data.find((c) => (c.metadata?.account_id ?? c.metadata?.workspace_id) === accountId);
    return match?.id ?? null;
  }
}

function headerGet(
  headers: Headers | Record<string, string | null | undefined>,
  name: string,
): string | null {
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name);
  }
  const record = headers as Record<string, string | null | undefined>;
  return record[name] ?? record[name.toLowerCase()] ?? null;
}

function checkoutSessionGrantsAccess(session: Stripe.Checkout.Session): boolean {
  return session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
}

async function activateFromCheckoutSession(
  session: Stripe.Checkout.Session,
  stripe: Stripe,
  missingAccountEvent: string,
): Promise<BillingEvent[]> {
  const accountId =
    session.client_reference_id ?? accountIdFromMetadata(session.metadata) ?? null;
  if (!accountId) {
    console.warn(`[open-payment:stripe] ${missingAccountEvent} missing workspace_id`);
    return [];
  }

  const planFromMeta = session.metadata?.plan;
  let planKey: string = Boolean(planFromMeta ?? '') ? (planFromMeta as string) : 'free';

  if (session.mode === 'subscription' && session.subscription) {
    const subId =
      typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
    const subscription = await stripe.subscriptions.retrieve(subId);
    const fromPrice = resolvePlanFromPriceId(priceIdFromSubscription(subscription));
    if (fromPrice) planKey = fromPrice;
    else if (Boolean(subscription.metadata?.plan ?? '')) {
      planKey = subscription.metadata.plan as string;
    }
  }

  const providerCustomerId = customerIdFrom(session.customer);
  if (providerCustomerId) {
    await ensureCustomerAccountMetadata(stripe, providerCustomerId, accountId);
  }

  return [
    {
      type: 'subscription.activated',
      accountId,
      planKey,
      providerCustomerId,
      provider: 'stripe',
    },
  ];
}

function checkoutSessionTerminalEvent(
  session: Stripe.Checkout.Session,
  type: 'checkout.async_payment_failed' | 'checkout.expired',
): BillingEvent[] {
  const accountId =
    session.client_reference_id ?? accountIdFromMetadata(session.metadata) ?? null;
  if (!accountId) {
    console.warn(`[open-payment:stripe] ${type} missing workspace_id`);
    return [];
  }

  return [
    {
      type,
      accountId,
      sessionId: session.id,
      providerCustomerId: customerIdFrom(session.customer),
      provider: 'stripe',
    },
  ];
}

async function accountIdFromSubscription(
  subscription: Stripe.Subscription,
  stripe: Stripe,
): Promise<string | null> {
  const fromSubscription = accountIdFromMetadata(subscription.metadata);
  if (fromSubscription) return fromSubscription;

  const customerId = customerIdFrom(subscription.customer);
  if (!customerId) return null;
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) return null;
  return accountIdFromMetadata(customer.metadata);
}

/** Map a verified Stripe event into zero-or-more normalized billing events. */
export async function stripeEventToBillingEvents(
  event: Stripe.Event,
  stripe: Stripe = getStripe(),
): Promise<BillingEvent[]> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      // Delayed methods (bank debit, etc.) complete the session while still
      // `unpaid`. Activation waits for `checkout.session.async_payment_succeeded`.
      if (!checkoutSessionGrantsAccess(session)) return [];
      return activateFromCheckoutSession(session, stripe, 'checkout.session.completed');
    }

    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object as Stripe.Checkout.Session;
      return activateFromCheckoutSession(
        session,
        stripe,
        'checkout.session.async_payment_succeeded',
      );
    }

    case 'checkout.session.async_payment_failed':
      return checkoutSessionTerminalEvent(
        event.data.object as Stripe.Checkout.Session,
        'checkout.async_payment_failed',
      );

    case 'checkout.session.expired':
      return checkoutSessionTerminalEvent(
        event.data.object as Stripe.Checkout.Session,
        'checkout.expired',
      );

    case 'customer.subscription.updated': {
      const subscription = event.data.object as Stripe.Subscription;
      const accountId = await accountIdFromSubscription(subscription, stripe);

      if (!accountId) {
        console.warn('[open-payment:stripe] subscription.updated missing workspace_id');
        return [];
      }

      // First invoice has not been paid. Do not grant a plan. Stripe later
      // sends `incomplete_expired` (handled below as canceled) or an active update.
      if (subscription.status === 'incomplete') {
        return [];
      }

      if (
        subscription.status === 'unpaid' ||
        subscription.status === 'incomplete_expired' ||
        subscription.status === 'canceled'
      ) {
        return [{ type: 'subscription.canceled', accountId, provider: 'stripe' }];
      }

      const planKey: string =
        resolvePlanFromPriceId(priceIdFromSubscription(subscription)) ??
        (Boolean(subscription.metadata?.plan ?? '')
          ? (subscription.metadata.plan as string)
          : 'free');

      const providerCustomerId = customerIdFrom(subscription.customer);
      if (providerCustomerId) {
        await ensureCustomerAccountMetadata(stripe, providerCustomerId, accountId);
      }

      return [
        {
          type: 'subscription.updated',
          accountId,
          planKey,
          providerCustomerId,
          provider: 'stripe',
        },
      ];
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      const accountId = await accountIdFromSubscription(subscription, stripe);

      if (!accountId) {
        console.warn('[open-payment:stripe] subscription.deleted missing workspace_id');
        return [];
      }

      return [{ type: 'subscription.canceled', accountId, provider: 'stripe' }];
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      let accountId = accountIdFromInvoice(invoice);

      if (!accountId) {
        const subscriptionId = subscriptionIdFromInvoice(invoice);
        if (subscriptionId) {
          try {
            const subscription = await stripe.subscriptions.retrieve(subscriptionId);
            accountId = accountIdFromMetadata(subscription.metadata);
          } catch (err) {
            console.warn('[open-payment:stripe] invoice.payment_failed subscription lookup failed', {
              invoiceId: invoice.id,
              subscriptionId,
              error: err instanceof Error ? err.message : err,
            });
          }
        }
      }

      // Last resort. Wrong for a customer shared across accounts, which is why
      // subscription metadata is preferred above.
      if (!accountId) {
        const customerId = customerIdFrom(invoice.customer);
        if (customerId) {
          const customer = await stripe.customers.retrieve(customerId);
          if (!customer.deleted) {
            accountId = accountIdFromMetadata(customer.metadata);
          }
        }
      }

      if (!accountId) {
        console.warn('[open-payment:stripe] invoice.payment_failed missing workspace_id', {
          invoiceId: invoice.id,
        });
        return [];
      }

      return [
        {
          type: 'invoice.payment_failed',
          accountId,
          invoiceId: invoice.id,
          provider: 'stripe',
        },
      ];
    }

    default:
      return [];
  }
}

export class StripePaymentProvider implements PaymentProvider {
  readonly id = 'stripe' as const;

  async createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    const priceId = getPriceIdForPlan(input.planKey);
    if (!priceId) {
      throw new PaymentProviderError(
        `Stripe price not configured for plan ${input.planKey}`,
        'NOT_CONFIGURED',
      );
    }

    let stripe: Stripe;
    try {
      stripe = getStripe();
    } catch (err) {
      throw new PaymentProviderError(
        err instanceof Error ? err.message : 'Stripe unavailable',
        'UNAVAILABLE',
      );
    }

    const requestedCustomerId = input.providerCustomerId?.trim() ?? '';
    let customerId =
      requestedCustomerId.length > 0
        ? requestedCustomerId
        : await findStripeCustomerIdForAccount(stripe, input.accountId);
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: input.customerEmail ?? undefined,
        name: input.accountName,
        metadata: { account_id: input.accountId },
      });
      customerId = customer.id;
    }

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: 'subscription',
      customer: customerId,
      client_reference_id: input.accountId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata: {
        account_id: input.accountId,
        planKey: input.planKey,
      },
      subscription_data: {
        metadata: {
          account_id: input.accountId,
          planKey: input.planKey,
        },
      },
    };
    if (typeof input.expiresAt === 'number' && Number.isFinite(input.expiresAt)) {
      sessionParams.expires_at = input.expiresAt;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    if (!session.url) {
      throw new PaymentProviderError('Checkout URL missing', 'CHECKOUT_URL_MISSING');
    }

    return { url: session.url, providerCustomerId: customerId };
  }

  async createCustomerPortal(input: CreatePortalInput): Promise<{ url: string }> {
    let stripe: Stripe;
    try {
      stripe = getStripe();
    } catch (err) {
      throw new PaymentProviderError(
        err instanceof Error ? err.message : 'Stripe unavailable',
        'UNAVAILABLE',
      );
    }

    const customerId = await findStripeCustomerIdForAccount(stripe, input.accountId);
    if (!customerId) {
      throw new PaymentProviderError('Stripe customer not found', 'CUSTOMER_NOT_FOUND');
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: input.returnUrl,
    });

    return { url: session.url };
  }

  async listInvoices(accountId: string, limit = 12): Promise<BillingInvoice[]> {
    let stripe: Stripe;
    try {
      stripe = getStripe();
    } catch {
      return [];
    }

    const { subscriptions } = await listSubscriptionsForAccount(stripe, accountId, { limit: 100 });
    if (subscriptions.length === 0) return [];

    const subscriptionIds = new Set(subscriptions.map((subscription) => subscription.id));
    const merged = new Map<string, Stripe.Invoice>();
    for (const subscription of subscriptions) {
      const listed = await stripe.invoices.list({
        subscription: subscription.id,
        limit,
      });
      for (const invoice of listed.data) {
        if (!invoiceBelongsToAccount(invoice, accountId, subscriptionIds)) continue;
        merged.set(invoice.id, invoice);
      }
    }

    return [...merged.values()]
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
      .slice(0, limit)
      .map(toBillingInvoice);
  }

  async getSubscriptionInfo(accountId: string): Promise<SubscriptionInfo> {
    try {
      const stripe = getStripe();
      const { subscriptions, customerId } = await listSubscriptionsForAccount(stripe, accountId, {
        limit: 1,
        statuses: BILLABLE_SUBSCRIPTION_STATUSES,
      });
      const active = subscriptions[0];
      const providerCustomerId = active ? customerIdFrom(active.customer) : customerId;
      const periodEnd = active?.items?.data?.[0]?.current_period_end;

      return {
        renewalDate: periodEnd ? new Date(periodEnd * 1000) : null,
        status: active?.status ?? null,
        providerCustomerId,
      };
    } catch {
      return { renewalDate: null, status: null, providerCustomerId: null };
    }
  }

  async verifyAndParseWebhook(input: {
    rawBody: string | Buffer;
    headers: Headers | Record<string, string | null | undefined>;
  }): Promise<BillingEvent[]> {
    const signature = headerGet(input.headers, 'stripe-signature');
    if (!signature) {
      throw new PaymentProviderError('Missing stripe-signature', 'INVALID_WEBHOOK');
    }

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      throw new PaymentProviderError('STRIPE_WEBHOOK_SECRET is not set', 'NOT_CONFIGURED');
    }

    let event: Stripe.Event;
    try {
      event = getStripe().webhooks.constructEvent(input.rawBody, signature, webhookSecret);
    } catch (err) {
      throw new PaymentProviderError(
        err instanceof Error ? err.message : 'Invalid Stripe webhook signature',
        'INVALID_WEBHOOK',
      );
    }

    return stripeEventToBillingEvents(event);
  }
}

export function createStripePaymentProvider(): PaymentProvider {
  return new StripePaymentProvider();
}
