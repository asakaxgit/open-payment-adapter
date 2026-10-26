import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import {
  configurePriceCatalog,
  setStripeClientOverride,
} from '../src/index.js';
import {
  createStripePaymentProvider,
  stripeEventToBillingEvents,
} from '../src/adapters/stripe.js';
import { FIXTURE_ACCOUNT_ID, FIXTURE_PLAN_KEY } from '../src/testing/index.js';

const ACCOUNT_A = 'acct_a';
const ACCOUNT_B = 'acct_b';
const CUSTOMER = 'cus_shared';

function stripeEvent(type: string, object: object): Stripe.Event {
  return {
    id: 'evt_test',
    object: 'event',
    type,
    data: { object },
  } as Stripe.Event;
}

function checkoutSession(overrides: Record<string, unknown> = {}): Stripe.Checkout.Session {
  return {
    id: 'cs_test_1',
    object: 'checkout.session',
    mode: 'subscription',
    payment_status: 'paid',
    client_reference_id: FIXTURE_ACCOUNT_ID,
    customer: null,
    subscription: null,
    metadata: { account_id: FIXTURE_ACCOUNT_ID, plan: FIXTURE_PLAN_KEY },
    ...overrides,
  } as Stripe.Checkout.Session;
}

function subscription(opts: {
  id: string;
  accountId: string;
  status?: string;
  customerId?: string;
  periodEnd?: number;
  metadata?: Stripe.Metadata;
}): Stripe.Subscription {
  return {
    id: opts.id,
    status: opts.status ?? 'active',
    customer: opts.customerId ?? CUSTOMER,
    metadata: opts.metadata ?? { account_id: opts.accountId, plan: FIXTURE_PLAN_KEY },
    items: {
      data: [
        {
          current_period_end: opts.periodEnd ?? 1_800_000_000,
          price: { id: 'price_pro' },
        },
      ],
    },
  } as Stripe.Subscription;
}

function invoiceEvent(invoice: object): Stripe.Event {
  return stripeEvent('invoice.payment_failed', {
    id: 'in_test',
    customer: CUSTOMER,
    ...invoice,
  });
}

describe('stripe adapter', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', () => {
      throw new Error('unexpected live network call');
    });
  });

  afterEach(() => {
    warn.mockRestore();
    vi.unstubAllGlobals();
    setStripeClientOverride(null);
    configurePriceCatalog({});
  });

  describe('checkout.session.completed payment_status', () => {
    it('activates when payment_status is paid', async () => {
      const events = await stripeEventToBillingEvents(
        stripeEvent('checkout.session.completed', checkoutSession({ payment_status: 'paid' })),
        {} as Stripe,
      );
      expect(events).toEqual([
        {
          type: 'subscription.activated',
          accountId: FIXTURE_ACCOUNT_ID,
          planKey: FIXTURE_PLAN_KEY,
          providerCustomerId: null,
          provider: 'stripe',
        },
      ]);
    });

    it('activates when payment_status is no_payment_required', async () => {
      const events = await stripeEventToBillingEvents(
        stripeEvent(
          'checkout.session.completed',
          checkoutSession({ payment_status: 'no_payment_required' }),
        ),
        {} as Stripe,
      );
      expect(events.map((event) => event.type)).toEqual(['subscription.activated']);
    });

    it('does not activate an unpaid session and does not call Stripe', async () => {
      const stripe = new Proxy(
        {},
        {
          get() {
            throw new Error('Stripe client should not be used for an unpaid checkout');
          },
        },
      ) as Stripe;

      const events = await stripeEventToBillingEvents(
        stripeEvent(
          'checkout.session.completed',
          checkoutSession({
            payment_status: 'unpaid',
            customer: CUSTOMER,
            subscription: 'sub_pending',
          }),
        ),
        stripe,
      );

      expect(events).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('resolves the plan from the subscription price when the session is paid', async () => {
      configurePriceCatalog({ stripe: { business: 'price_business' } });
      const retrieve = vi.fn(async () => ({
        metadata: { plan: 'pro' },
        items: { data: [{ price: { id: 'price_business' } }] },
      }));

      const events = await stripeEventToBillingEvents(
        stripeEvent(
          'checkout.session.completed',
          checkoutSession({ subscription: 'sub_1' }),
        ),
        { subscriptions: { retrieve } } as unknown as Stripe,
      );

      expect(retrieve).toHaveBeenCalledWith('sub_1');
      expect(events[0]).toMatchObject({ type: 'subscription.activated', planKey: 'business' });
    });
  });

  describe('checkout session async and expired events', () => {
    it('activates on async_payment_succeeded even if payment_status is still unpaid', async () => {
      const events = await stripeEventToBillingEvents(
        stripeEvent(
          'checkout.session.async_payment_succeeded',
          checkoutSession({ payment_status: 'unpaid', customer: CUSTOMER }),
        ),
        {
          customers: {
            retrieve: vi.fn(async () => ({ id: CUSTOMER, metadata: {} })),
            update: vi.fn(),
          },
        } as unknown as Stripe,
      );

      expect(events).toEqual([
        {
          type: 'subscription.activated',
          accountId: FIXTURE_ACCOUNT_ID,
          planKey: FIXTURE_PLAN_KEY,
          providerCustomerId: CUSTOMER,
          provider: 'stripe',
        },
      ]);
    });

    it('emits checkout.async_payment_failed', async () => {
      const events = await stripeEventToBillingEvents(
        stripeEvent(
          'checkout.session.async_payment_failed',
          checkoutSession({ id: 'cs_failed', customer: CUSTOMER, payment_status: 'unpaid' }),
        ),
        {} as Stripe,
      );

      expect(events).toEqual([
        {
          type: 'checkout.async_payment_failed',
          accountId: FIXTURE_ACCOUNT_ID,
          sessionId: 'cs_failed',
          providerCustomerId: CUSTOMER,
          provider: 'stripe',
        },
      ]);
    });

    it('emits checkout.expired', async () => {
      const events = await stripeEventToBillingEvents(
        stripeEvent(
          'checkout.session.expired',
          checkoutSession({ id: 'cs_expired', customer: null }),
        ),
        {} as Stripe,
      );

      expect(events).toEqual([
        {
          type: 'checkout.expired',
          accountId: FIXTURE_ACCOUNT_ID,
          sessionId: 'cs_expired',
          providerCustomerId: null,
          provider: 'stripe',
        },
      ]);
    });

    it('emits nothing for an expired session with no account', async () => {
      const events = await stripeEventToBillingEvents(
        stripeEvent(
          'checkout.session.expired',
          checkoutSession({
            client_reference_id: null,
            metadata: {},
          }),
        ),
        {} as Stripe,
      );
      expect(events).toEqual([]);
      expect(warn).toHaveBeenCalled();
    });
  });

  describe('customer.subscription.updated statuses', () => {
    function updatedEvent(status: string): Stripe.Event {
      return stripeEvent(
        'customer.subscription.updated',
        subscription({ id: 'sub_1', accountId: FIXTURE_ACCOUNT_ID, status, customerId: CUSTOMER }),
      );
    }

    it('does not grant a plan for incomplete', async () => {
      const retrieve = vi.fn();
      const events = await stripeEventToBillingEvents(updatedEvent('incomplete'), {
        customers: { retrieve },
      } as unknown as Stripe);

      expect(events).toEqual([]);
      expect(retrieve).not.toHaveBeenCalled();
    });

    it('cancels incomplete_expired without a plan key', async () => {
      const events = await stripeEventToBillingEvents(updatedEvent('incomplete_expired'), {} as Stripe);
      expect(events).toEqual([
        { type: 'subscription.canceled', accountId: FIXTURE_ACCOUNT_ID, provider: 'stripe' },
      ]);
    });

    it('cancels a deleted subscription', async () => {
      const events = await stripeEventToBillingEvents(
        stripeEvent(
          'customer.subscription.deleted',
          subscription({ id: 'sub_1', accountId: FIXTURE_ACCOUNT_ID, status: 'canceled' }),
        ),
        {} as Stripe,
      );
      expect(events).toEqual([
        { type: 'subscription.canceled', accountId: FIXTURE_ACCOUNT_ID, provider: 'stripe' },
      ]);
    });

    it('still cancels unpaid', async () => {
      const events = await stripeEventToBillingEvents(updatedEvent('unpaid'), {} as Stripe);
      expect(events).toEqual([
        { type: 'subscription.canceled', accountId: FIXTURE_ACCOUNT_ID, provider: 'stripe' },
      ]);
    });

    it('grants the plan for an active subscription', async () => {
      const update = vi.fn();
      const events = await stripeEventToBillingEvents(updatedEvent('active'), {
        customers: {
          retrieve: vi.fn(async () => ({ id: CUSTOMER, metadata: {} })),
          update,
        },
      } as unknown as Stripe);

      expect(events).toEqual([
        {
          type: 'subscription.updated',
          accountId: FIXTURE_ACCOUNT_ID,
          planKey: FIXTURE_PLAN_KEY,
          providerCustomerId: CUSTOMER,
          provider: 'stripe',
        },
      ]);
      expect(update).toHaveBeenCalledWith(CUSTOMER, {
        metadata: { account_id: FIXTURE_ACCOUNT_ID },
      });
    });
  });

  describe('createCheckout customer id and expires_at', () => {
    const checkoutInput = {
      accountId: FIXTURE_ACCOUNT_ID,
      accountName: 'Acme',
      planKey: FIXTURE_PLAN_KEY,
      successUrl: 'https://app.test/ok',
      cancelUrl: 'https://app.test/cancel',
    };

    beforeEach(() => {
      configurePriceCatalog({ stripe: { pro: 'price_pro' } });
    });

    it('reuses an existing customer and forwards expiresAt', async () => {
      const search = vi.fn();
      const createCustomer = vi.fn();
      const update = vi.fn();
      const createSession = vi.fn(async () => ({ url: 'https://checkout.stripe.test/cs' }));
      setStripeClientOverride({
        customers: { search, create: createCustomer, update },
        checkout: { sessions: { create: createSession } },
      } as unknown as Stripe);

      const result = await createStripePaymentProvider().createCheckout({
        ...checkoutInput,
        providerCustomerId: '  cus_existing  ',
        expiresAt: 1_800_000_000,
      });

      expect(search).not.toHaveBeenCalled();
      expect(createCustomer).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: 'cus_existing',
          expires_at: 1_800_000_000,
          subscription_data: {
            metadata: { account_id: FIXTURE_ACCOUNT_ID, planKey: FIXTURE_PLAN_KEY },
          },
        }),
      );
      expect(result).toEqual({
        url: 'https://checkout.stripe.test/cs',
        providerCustomerId: 'cus_existing',
      });
    });

    it('omits expires_at and creates a customer when neither optional is set', async () => {
      const createSession = vi.fn(async () => ({ url: 'https://checkout.stripe.test/new' }));
      setStripeClientOverride({
        customers: {
          search: vi.fn(async () => ({ data: [] })),
          create: vi.fn(async () => ({ id: 'cus_new' })),
        },
        checkout: { sessions: { create: createSession } },
      } as unknown as Stripe);

      const result = await createStripePaymentProvider().createCheckout(checkoutInput);
      const params = createSession.mock.calls[0]?.[0] as { expires_at?: number; customer?: string };

      expect(params.customer).toBe('cus_new');
      expect(params.expires_at).toBeUndefined();
      expect(result.providerCustomerId).toBe('cus_new');
    });
  });

  describe('ensureCustomerAccountMetadata', () => {
    function completedWithCustomer(): Stripe.Event {
      return stripeEvent(
        'checkout.session.completed',
        checkoutSession({ customer: CUSTOMER }),
      );
    }

    it('writes account_id when the customer has none', async () => {
      const update = vi.fn();
      await stripeEventToBillingEvents(completedWithCustomer(), {
        customers: {
          retrieve: vi.fn(async () => ({ id: CUSTOMER, metadata: { name: 'Ada' } })),
          update,
        },
      } as unknown as Stripe);

      expect(update).toHaveBeenCalledWith(CUSTOMER, {
        metadata: { account_id: FIXTURE_ACCOUNT_ID },
      });
    });

    it('does not overwrite an existing account_id on a shared customer', async () => {
      const update = vi.fn();
      const events = await stripeEventToBillingEvents(completedWithCustomer(), {
        customers: {
          retrieve: vi.fn(async () => ({
            id: CUSTOMER,
            metadata: { account_id: 'acct_original' },
          })),
          update,
        },
      } as unknown as Stripe);

      expect(update).not.toHaveBeenCalled();
      expect(events[0]).toMatchObject({
        type: 'subscription.activated',
        accountId: FIXTURE_ACCOUNT_ID,
        providerCustomerId: CUSTOMER,
      });
    });

    it('does not replace an existing workspace_id alias', async () => {
      const update = vi.fn();
      await stripeEventToBillingEvents(completedWithCustomer(), {
        customers: {
          retrieve: vi.fn(async () => ({
            id: CUSTOMER,
            metadata: { workspace_id: 'acct_original' },
          })),
          update,
        },
      } as unknown as Stripe);

      expect(update).not.toHaveBeenCalled();
    });

    it('skips a deleted customer', async () => {
      const update = vi.fn();
      const events = await stripeEventToBillingEvents(completedWithCustomer(), {
        customers: {
          retrieve: vi.fn(async () => ({ id: CUSTOMER, deleted: true })),
          update,
        },
      } as unknown as Stripe);

      expect(update).not.toHaveBeenCalled();
      expect(events[0]).toMatchObject({ type: 'subscription.activated' });
    });
  });

  describe('subscription and invoice reads', () => {
    const subA = subscription({
      id: 'sub_a',
      accountId: ACCOUNT_A,
      customerId: CUSTOMER,
      periodEnd: 1_800_000_000,
    });
    const subB = subscription({
      id: 'sub_b',
      accountId: ACCOUNT_B,
      customerId: CUSTOMER,
      periodEnd: 1_900_000_000,
    });

    function customerSearch(found: boolean) {
      return vi.fn(async () => ({ data: found ? [{ id: CUSTOMER }] : [] }));
    }

    it('uses a limit-1 subscription search by metadata when the customer is shared', async () => {
      const list = vi.fn();
      const search = vi.fn(async () => ({ data: [subA] }));
      setStripeClientOverride({
        customers: { search: customerSearch(false) },
        subscriptions: { list, search },
      } as unknown as Stripe);

      const info = await createStripePaymentProvider().getSubscriptionInfo(ACCOUNT_A);

      expect(list).not.toHaveBeenCalled();
      expect(search).toHaveBeenCalledWith({
        query: "metadata['account_id']:'acct_a' AND status:'active'",
        limit: 1,
      });
      expect(info).toEqual({
        renewalDate: new Date(1_800_000_000 * 1000),
        status: 'active',
        providerCustomerId: CUSTOMER,
      });
    });

    it('escapes account ids in the subscription search query', async () => {
      const accountId = "acct'a";
      const search = vi.fn(async () => ({
        data: [
          subscription({
            id: 'sub_quote',
            accountId,
            periodEnd: 1_700_000_000,
          }),
        ],
      }));
      setStripeClientOverride({
        customers: { search: customerSearch(false) },
        subscriptions: { list: vi.fn(), search },
      } as unknown as Stripe);

      const info = await createStripePaymentProvider().getSubscriptionInfo(accountId);

      expect(search).toHaveBeenCalledWith({
        query: "metadata['account_id']:'acct\\'a' AND status:'active'",
        limit: 1,
      });
      expect(info.status).toBe('active');
      expect(info.renewalDate).toEqual(new Date(1_700_000_000 * 1000));
    });

    it('does not return another account subscription from an unfiltered limit-1 list', async () => {
      const list = vi.fn(async (params: { limit?: number }) => {
        const all = [subB, subA];
        const limit = params.limit ?? 1;
        return { data: all.slice(0, limit) };
      });
      const search = vi.fn(async () => ({ data: [] }));
      setStripeClientOverride({
        customers: { search: customerSearch(true) },
        subscriptions: { list, search },
      } as unknown as Stripe);

      const info = await createStripePaymentProvider().getSubscriptionInfo(ACCOUNT_A);

      expect(list).toHaveBeenCalledWith({
        customer: CUSTOMER,
        status: 'all',
        limit: 100,
      });
      expect(search).not.toHaveBeenCalled();
      expect(info).toEqual({
        renewalDate: new Date(1_800_000_000 * 1000),
        status: 'active',
        providerCustomerId: CUSTOMER,
      });
    });

    it('accepts the workspace_id alias on a listed subscription', async () => {
      const aliased = subscription({
        id: 'sub_alias',
        accountId: ACCOUNT_A,
        metadata: { workspace_id: ACCOUNT_A },
        periodEnd: 1_600_000_000,
      });
      setStripeClientOverride({
        customers: { search: customerSearch(true) },
        subscriptions: {
          list: vi.fn(async () => ({ data: [aliased] })),
          search: vi.fn(),
        },
      } as unknown as Stripe);

      const info = await createStripePaymentProvider().getSubscriptionInfo(ACCOUNT_A);
      expect(info.status).toBe('active');
      expect(info.renewalDate).toEqual(new Date(1_600_000_000 * 1000));
    });

    it('keeps the customer id when that customer has no billable subscription for the account', async () => {
      setStripeClientOverride({
        customers: { search: customerSearch(true) },
        subscriptions: {
          list: vi.fn(async () => ({ data: [subB] })),
          search: vi.fn(async () => ({ data: [] })),
        },
      } as unknown as Stripe);

      const info = await createStripePaymentProvider().getSubscriptionInfo(ACCOUNT_A);
      expect(info).toEqual({
        renewalDate: null,
        status: null,
        providerCustomerId: CUSTOMER,
      });
    });

    it('lists invoices for the account subscription, not the shared customer', async () => {
      const invoiceA = {
        id: 'in_a',
        created: 1_700_000_100,
        amount_paid: 2000,
        currency: 'usd',
        status: 'paid',
        invoice_pdf: 'https://files.stripe.test/in_a.pdf',
        parent: {
          type: 'subscription_details',
          subscription_details: {
            metadata: { account_id: ACCOUNT_A },
            subscription: 'sub_a',
          },
        },
      };
      const invoiceB = {
        id: 'in_b',
        created: 1_700_000_200,
        amount_paid: 9000,
        currency: 'usd',
        status: 'open',
        parent: {
          type: 'subscription_details',
          subscription_details: {
            metadata: { account_id: ACCOUNT_B },
            subscription: 'sub_b',
          },
        },
      };
      const listInvoices = vi.fn(async (params: { customer?: string; subscription?: string; limit?: number }) => {
        if (!params.subscription) {
          throw new Error(`invoices.list must be scoped to a subscription: ${JSON.stringify(params)}`);
        }
        if (params.subscription === 'sub_a') return { data: [invoiceA] };
        if (params.subscription === 'sub_b') return { data: [invoiceB] };
        return { data: [] };
      });
      setStripeClientOverride({
        customers: { search: customerSearch(true) },
        subscriptions: {
          list: vi.fn(async (params: { limit?: number }) => {
            const all = [subB, subA];
            return { data: all.slice(0, params.limit ?? 1) };
          }),
          search: vi.fn(async () => {
            throw new Error('search should not be required');
          }),
        },
        invoices: { list: listInvoices },
      } as unknown as Stripe);

      const invoices = await createStripePaymentProvider().listInvoices(ACCOUNT_A, 1);

      expect(listInvoices).toHaveBeenCalledTimes(1);
      expect(listInvoices).toHaveBeenCalledWith({ subscription: 'sub_a', limit: 1 });
      expect(invoices).toEqual([
        {
          id: 'in_a',
          date: new Date(1_700_000_100 * 1000),
          amount: 2000,
          currency: 'usd',
          status: 'paid',
          pdfUrl: 'https://files.stripe.test/in_a.pdf',
        },
      ]);
    });

    it('finds invoices through subscription metadata when the customer metadata is a different account', async () => {
      const search = vi.fn(async () => ({ data: [subA] }));
      const listInvoices = vi.fn(async () => ({
        data: [
          {
            id: 'in_a',
            created: 1_700_000_000,
            amount_paid: 500,
            currency: 'eur',
            status: 'paid',
            invoice_pdf: null,
            parent: {
              subscription_details: {
                metadata: { account_id: ACCOUNT_A },
                subscription: 'sub_a',
              },
            },
          },
        ],
      }));
      setStripeClientOverride({
        customers: { search: customerSearch(false) },
        subscriptions: { list: vi.fn(), search },
        invoices: { list: listInvoices },
      } as unknown as Stripe);

      const invoices = await createStripePaymentProvider().listInvoices(ACCOUNT_A);

      expect(search).toHaveBeenCalledWith({
        query: "metadata['account_id']:'acct_a'",
        limit: 100,
      });
      expect(invoices.map((invoice) => invoice.id)).toEqual(['in_a']);
      expect(listInvoices).toHaveBeenCalledWith({ subscription: 'sub_a', limit: 12 });
    });
  });

  describe('invoice.payment_failed account resolution', () => {
    it('prefers parent.subscription_details.metadata over the shared customer', async () => {
      const retrieveCustomer = vi.fn(async () => {
        throw new Error('customer metadata must not win over subscription metadata');
      });
      const events = await stripeEventToBillingEvents(
        invoiceEvent({
          id: 'in_parent',
          metadata: { account_id: ACCOUNT_B },
          parent: {
            type: 'subscription_details',
            subscription_details: {
              metadata: { account_id: ACCOUNT_A },
              subscription: 'sub_a',
            },
          },
        }),
        { customers: { retrieve: retrieveCustomer } } as unknown as Stripe,
      );

      expect(retrieveCustomer).not.toHaveBeenCalled();
      expect(events).toEqual([
        {
          type: 'invoice.payment_failed',
          accountId: ACCOUNT_A,
          invoiceId: 'in_parent',
          provider: 'stripe',
        },
      ]);
    });

    it('falls back to legacy subscription_details.metadata', async () => {
      const events = await stripeEventToBillingEvents(
        invoiceEvent({
          id: 'in_legacy_details',
          parent: null,
          subscription_details: { metadata: { account_id: ACCOUNT_A } },
        }),
        {} as Stripe,
      );
      expect(events[0]).toMatchObject({ accountId: ACCOUNT_A, invoiceId: 'in_legacy_details' });
    });

    it('falls back to an expanded legacy subscription object', async () => {
      const retrieve = vi.fn();
      const events = await stripeEventToBillingEvents(
        invoiceEvent({
          id: 'in_expanded',
          parent: null,
          subscription: {
            id: 'sub_legacy',
            metadata: { account_id: ACCOUNT_A },
          },
        }),
        { subscriptions: { retrieve } } as unknown as Stripe,
      );
      expect(retrieve).not.toHaveBeenCalled();
      expect(events[0]).toMatchObject({ accountId: ACCOUNT_A });
    });

    it('retrieves the subscription id from parent.subscription_details', async () => {
      const retrieve = vi.fn(async (id: string) => {
        expect(id).toBe('sub_parent');
        return { metadata: { account_id: ACCOUNT_A } };
      });
      const events = await stripeEventToBillingEvents(
        invoiceEvent({
          id: 'in_sub_id',
          parent: {
            type: 'subscription_details',
            subscription_details: { metadata: null, subscription: 'sub_parent' },
          },
        }),
        { subscriptions: { retrieve } } as unknown as Stripe,
      );
      expect(events[0]).toMatchObject({ accountId: ACCOUNT_A, invoiceId: 'in_sub_id' });
    });

    it('retrieves a legacy invoice.subscription id', async () => {
      const retrieve = vi.fn(async () => ({ metadata: { workspace_id: ACCOUNT_A } }));
      const events = await stripeEventToBillingEvents(
        invoiceEvent({
          id: 'in_legacy_sub',
          parent: null,
          subscription: 'sub_legacy',
        }),
        { subscriptions: { retrieve } } as unknown as Stripe,
      );
      expect(retrieve).toHaveBeenCalledWith('sub_legacy');
      expect(events[0]).toMatchObject({ accountId: ACCOUNT_A });
    });

    it('falls back to line metadata, then invoice metadata, then the customer', async () => {
      const fromLine = await stripeEventToBillingEvents(
        invoiceEvent({
          id: 'in_line',
          parent: null,
          lines: { data: [{ metadata: { account_id: ACCOUNT_A } }] },
        }),
        {} as Stripe,
      );
      expect(fromLine[0]).toMatchObject({ accountId: ACCOUNT_A, invoiceId: 'in_line' });

      const fromInvoice = await stripeEventToBillingEvents(
        invoiceEvent({
          id: 'in_meta',
          parent: null,
          metadata: { account_id: ACCOUNT_A },
        }),
        {} as Stripe,
      );
      expect(fromInvoice[0]).toMatchObject({ accountId: ACCOUNT_A, invoiceId: 'in_meta' });

      const fromCustomer = await stripeEventToBillingEvents(
        invoiceEvent({ id: 'in_customer', parent: null, metadata: null }),
        {
          customers: {
            retrieve: vi.fn(async () => ({
              id: CUSTOMER,
              metadata: { account_id: ACCOUNT_A },
            })),
          },
        } as unknown as Stripe,
      );
      expect(fromCustomer[0]).toMatchObject({ accountId: ACCOUNT_A, invoiceId: 'in_customer' });
    });

    it('uses the customer when the subscription lookup fails', async () => {
      const events = await stripeEventToBillingEvents(
        invoiceEvent({
          id: 'in_retrieve_fail',
          parent: {
            subscription_details: { metadata: null, subscription: 'sub_missing' },
          },
        }),
        {
          subscriptions: {
            retrieve: vi.fn(async () => {
              throw new Error('no such subscription');
            }),
          },
          customers: {
            retrieve: vi.fn(async () => ({
              id: CUSTOMER,
              metadata: { account_id: ACCOUNT_A },
            })),
          },
        } as unknown as Stripe,
      );

      expect(events[0]).toMatchObject({ accountId: ACCOUNT_A, invoiceId: 'in_retrieve_fail' });
      expect(warn).toHaveBeenCalled();
    });
  });
});
