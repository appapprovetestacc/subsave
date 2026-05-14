import {
  json,
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "@remix-run/cloudflare";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import {
  AppProvider,
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  DataTable,
  EmptyState,
  FormLayout,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import enTranslations from "@shopify/polaris/locales/en.json";
import type { Env } from "../../load-context";
import { authenticate } from "~/lib/shopify.server";
import { getAppSettings, putAppSettings } from "~/lib/db/app-tables.server";
import {
  cancelSubscription,
  createSubscription,
  dashboardMetrics,
  listSubscriptions,
  pauseSubscription,
  resumeSubscription,
  skipNextRenewal,
  updateCadence,
  type DashboardMetrics,
  type SubscriptionRow,
} from "~/lib/subscriptions.server";
import { captureSetupStep } from "~/lib/merchant-qa.server";

export const meta: MetaFunction = () => [
  { title: "SubSave" },
  { name: "description", content: "Recurring subscriptions, dunning, and renewal reminders." },
];

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

interface SerializedSubscription {
  id: string;
  customerEmail: string | null;
  productRemoteId: string;
  variantRemoteId: string | null;
  cadenceDays: number;
  priceCents: number;
  currencyCode: string;
  quantity: number;
  status: SubscriptionRow["status"];
  nextRenewalIso: string;
  skipNextRenewal: boolean;
}

interface DashboardSettings extends Record<string, unknown> {
  preRenewalReminderDays?: number;
  supportEmail?: string;
  defaultCadenceDays?: number;
}

interface LoaderData {
  configured: boolean;
  reason?: string;
  shop?: string;
  metrics?: DashboardMetrics;
  subscriptions?: SerializedSubscription[];
  settings?: DashboardSettings;
}

interface LoaderError {
  configured: false;
  reason: string;
}

function serialize(row: SubscriptionRow): SerializedSubscription {
  return {
    id: row.id,
    customerEmail: row.customerEmail,
    productRemoteId: row.productRemoteId,
    variantRemoteId: row.variantRemoteId,
    cadenceDays: row.cadenceDays,
    priceCents: row.priceCents,
    currencyCode: row.currencyCode,
    quantity: row.quantity,
    status: row.status,
    nextRenewalIso: row.nextRenewalAt.toISOString(),
    skipNextRenewal: row.skipNextRenewal,
  };
}

async function loadDashboard(request: Request, context: LoaderFunctionArgs["context"]): Promise<LoaderData | LoaderError> {
  const env = (context.cloudflare?.env ?? {}) as Env;
  // The dashboard is embedded — App Bridge JWT auth runs first. When the
  // app isn't yet wired up (no SHOPIFY_API_KEY, request didn't come from
  // the iframe), surface a clear "configure" state instead of throwing.
  if (!env.SHOPIFY_API_KEY || !env.SHOPIFY_API_SECRET || !env.SHOPIFY_APP_URL) {
    return {
      configured: false,
      reason: "Shopify credentials aren't bound yet. Complete OAuth + secrets via AppApprove to enable the admin.",
    };
  }
  if (!env.D1) {
    return {
      configured: false,
      reason: "D1 binding missing — run `wrangler d1 create subsave-db` and paste the id into wrangler.toml.",
    };
  }
  try {
    const { shop } = await authenticate.admin(request, context);
    const [metrics, subs, settings] = await Promise.all([
      dashboardMetrics(env.D1, shop),
      listSubscriptions(env.D1, shop, { limit: 100 }),
      getAppSettings<DashboardSettings>(env.D1, shop),
    ]);
    return {
      configured: true,
      shop,
      metrics,
      subscriptions: subs.map(serialize),
      settings,
    };
  } catch (err) {
    if (err instanceof Response) throw err;
    return {
      configured: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const data = await loadDashboard(request, context);
  return json(data);
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = (context.cloudflare?.env ?? {}) as Env;
  if (!env.D1) {
    return json({ ok: false, error: "D1 not bound" }, { status: 503 });
  }
  const { shop } = await authenticate.admin(request, context);
  const form = await request.formData();
  const op = String(form.get("op") ?? "");
  switch (op) {
    case "pause": {
      await pauseSubscription(env.D1, requiredId(form));
      break;
    }
    case "resume": {
      await resumeSubscription(env.D1, requiredId(form));
      break;
    }
    case "skip": {
      await skipNextRenewal(env.D1, requiredId(form));
      break;
    }
    case "cancel": {
      await cancelSubscription(env.D1, requiredId(form), String(form.get("reason") ?? "merchant_cancelled"));
      break;
    }
    case "update_cadence": {
      const cadence = Number(form.get("cadenceDays"));
      if (!Number.isFinite(cadence)) {
        return json({ ok: false, error: "Invalid cadenceDays" }, { status: 400 });
      }
      await updateCadence(env.D1, requiredId(form), Math.round(cadence));
      break;
    }
    case "save_settings": {
      const settings: DashboardSettings = {
        preRenewalReminderDays: Number(form.get("preRenewalReminderDays")) || 3,
        defaultCadenceDays: Number(form.get("defaultCadenceDays")) || 30,
        supportEmail: String(form.get("supportEmail") ?? "").slice(0, 200),
      };
      await putAppSettings(env.D1, shop, settings);
      await captureSetupStep(env, "subsave_settings_saved", { shop });
      break;
    }
    case "create_demo": {
      // Quick-create a demo subscription so merchants can preview the
      // dashboard before real subscribers exist. Safe: uses a placeholder
      // product id; the renewals cron's stub charger marks the charge
      // as succeeded without touching Shopify.
      await createSubscription(env.D1, {
        shop,
        customerRemoteId: "gid://shopify/Customer/demo-" + Date.now(),
        customerEmail: String(form.get("demoEmail") ?? "demo@example.com"),
        productRemoteId: "gid://shopify/Product/demo",
        quantity: 1,
        cadenceDays: 30,
        priceCents: 2900,
        currencyCode: "USD",
      });
      await captureSetupStep(env, "subsave_demo_subscription_created", { shop });
      break;
    }
    default:
      return json({ ok: false, error: "Unknown op: " + op }, { status: 400 });
  }
  return redirect("/");
}

function requiredId(form: FormData): string {
  const id = String(form.get("id") ?? "");
  if (!id) throw new Response("Missing subscription id", { status: 400 });
  return id;
}

function moneyDisplay(cents: number, currency: string): string {
  return (cents / 100).toFixed(2) + " " + currency;
}

function shortDate(iso: string): string {
  return iso.slice(0, 10);
}

function statusBadge(status: SerializedSubscription["status"]) {
  if (status === "active") return <Badge tone="success">Active</Badge>;
  if (status === "paused") return <Badge tone="attention">Paused</Badge>;
  return <Badge tone="critical">Cancelled</Badge>;
}

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const submitting = nav.state !== "idle";

  return (
    <AppProvider i18n={enTranslations}>
      <Page
        title="SubSave"
        subtitle="Recurring subscriptions with pause, skip, cancel, dunning, and renewal reminders."
      >
        <Layout>
          {!data.configured ? (
            <Layout.Section>
              <Banner title="Finish setup to enable the dashboard" tone="warning">
                <p>{data.reason}</p>
              </Banner>
            </Layout.Section>
          ) : (
            <>
              <Layout.Section>
                <MetricsCard metrics={data.metrics!} />
              </Layout.Section>

              <Layout.Section>
                <SubscriptionsCard
                  subscriptions={data.subscriptions ?? []}
                  submitting={submitting}
                />
              </Layout.Section>

              <Layout.Section>
                <SettingsCard
                  initial={data.settings ?? {}}
                  submitting={submitting}
                  feedback={
                    actionData && "ok" in actionData && !actionData.ok
                      ? actionData.error
                      : undefined
                  }
                />
              </Layout.Section>

              <Layout.Section>
                <DemoCard submitting={submitting} />
              </Layout.Section>
            </>
          )}
        </Layout>
      </Page>
    </AppProvider>
  );
}

function MetricsCard({ metrics }: { metrics: DashboardMetrics }) {
  const mrr = moneyDisplay(metrics.mrrCents, metrics.currencyCode);
  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h2" variant="headingMd">
          Status overview
        </Text>
        <InlineGrid columns={{ xs: 2, md: 4 }} gap="400">
          <KpiTile label="MRR" value={mrr} />
          <KpiTile label="Active" value={String(metrics.activeCount)} />
          <KpiTile label="Paused" value={String(metrics.pausedCount)} />
          <KpiTile
            label="Churn (30d)"
            value={metrics.churnPct.toFixed(1) + "%"}
          />
        </InlineGrid>
      </BlockStack>
    </Card>
  );
}

function KpiTile({ label, value }: { label: string; value: string }) {
  return (
    <Box padding="400" background="bg-surface-secondary" borderRadius="200">
      <BlockStack gap="100">
        <Text as="p" tone="subdued" variant="bodySm">
          {label}
        </Text>
        <Text as="p" variant="headingLg">
          {value}
        </Text>
      </BlockStack>
    </Box>
  );
}

function SubscriptionsCard({
  subscriptions,
  submitting,
}: {
  subscriptions: SerializedSubscription[];
  submitting: boolean;
}) {
  if (subscriptions.length === 0) {
    return (
      <Card>
        <EmptyState
          heading="No subscriptions yet"
          image=""
          action={undefined}
        >
          <p>
            Subscriptions appear here once customers subscribe via checkout
            or you create one from the demo card below.
          </p>
        </EmptyState>
      </Card>
    );
  }
  const rows = subscriptions.map((sub) => [
    <span key={sub.id + "-email"}>{sub.customerEmail ?? "—"}</span>,
    <span key={sub.id + "-product"}>{sub.productRemoteId.replace("gid://shopify/Product/", "")}</span>,
    <span key={sub.id + "-cadence"}>{sub.cadenceDays + "d"}</span>,
    <span key={sub.id + "-price"}>
      {moneyDisplay(sub.priceCents * sub.quantity, sub.currencyCode)}
    </span>,
    <span key={sub.id + "-status"}>{statusBadge(sub.status)}</span>,
    <span key={sub.id + "-next"}>{shortDate(sub.nextRenewalIso)}</span>,
    <SubscriptionActions key={sub.id + "-actions"} sub={sub} submitting={submitting} />,
  ]);
  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h2" variant="headingMd">
          Subscriptions
        </Text>
        <DataTable
          columnContentTypes={["text", "text", "text", "numeric", "text", "text", "text"]}
          headings={["Customer", "Product", "Cadence", "Total", "Status", "Next renewal", "Actions"]}
          rows={rows}
        />
      </BlockStack>
    </Card>
  );
}

function SubscriptionActions({
  sub,
  submitting,
}: {
  sub: SerializedSubscription;
  submitting: boolean;
}) {
  if (sub.status === "cancelled") {
    return <Text as="span" tone="subdued">—</Text>;
  }
  return (
    <InlineStack gap="200" wrap>
      {sub.status === "active" ? (
        <Form method="post">
          <input type="hidden" name="op" value="pause" />
          <input type="hidden" name="id" value={sub.id} />
          <Button submit size="micro" disabled={submitting}>Pause</Button>
        </Form>
      ) : (
        <Form method="post">
          <input type="hidden" name="op" value="resume" />
          <input type="hidden" name="id" value={sub.id} />
          <Button submit size="micro" variant="primary" disabled={submitting}>Resume</Button>
        </Form>
      )}
      {sub.status === "active" && !sub.skipNextRenewal && (
        <Form method="post">
          <input type="hidden" name="op" value="skip" />
          <input type="hidden" name="id" value={sub.id} />
          <Button submit size="micro" disabled={submitting}>Skip next</Button>
        </Form>
      )}
      <CadenceForm sub={sub} submitting={submitting} />
      <Form method="post">
        <input type="hidden" name="op" value="cancel" />
        <input type="hidden" name="id" value={sub.id} />
        <Button submit size="micro" tone="critical" disabled={submitting}>Cancel</Button>
      </Form>
    </InlineStack>
  );
}

function CadenceForm({ sub, submitting }: { sub: SerializedSubscription; submitting: boolean }) {
  return (
    <Form method="post" style={{ display: "inline-flex", gap: "0.25rem", alignItems: "center" }}>
      <input type="hidden" name="op" value="update_cadence" />
      <input type="hidden" name="id" value={sub.id} />
      <input
        type="number"
        name="cadenceDays"
        defaultValue={sub.cadenceDays}
        min={1}
        max={365}
        aria-label="Cadence in days"
        style={{ width: 64, padding: "4px" }}
      />
      <Button submit size="micro" disabled={submitting}>Set</Button>
    </Form>
  );
}

function SettingsCard({
  initial,
  submitting,
  feedback,
}: {
  initial: DashboardSettings;
  submitting: boolean;
  feedback?: string;
}) {
  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h2" variant="headingMd">
          Settings
        </Text>
        {feedback && (
          <Banner tone="critical">
            <p>{feedback}</p>
          </Banner>
        )}
        <Form method="post">
          <input type="hidden" name="op" value="save_settings" />
          <FormLayout>
            <LabeledInput
              label="Pre-renewal reminder (days before)"
              name="preRenewalReminderDays"
              type="number"
              defaultValue={String(initial.preRenewalReminderDays ?? 3)}
              min={0}
              max={30}
            />
            <LabeledInput
              label="Default cadence (days)"
              name="defaultCadenceDays"
              type="number"
              defaultValue={String(initial.defaultCadenceDays ?? 30)}
              min={1}
              max={365}
            />
            <LabeledInput
              label="Support email (reply-to on customer mail)"
              name="supportEmail"
              type="email"
              defaultValue={initial.supportEmail ?? ""}
            />
            <ButtonGroup>
              <Button submit variant="primary" disabled={submitting}>
                Save settings
              </Button>
            </ButtonGroup>
          </FormLayout>
        </Form>
      </BlockStack>
    </Card>
  );
}

function DemoCard({ submitting }: { submitting: boolean }) {
  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h2" variant="headingMd">
          Create a demo subscription
        </Text>
        <Text as="p" tone="subdued">
          The renewals cron's stub charger marks demo charges as succeeded without contacting Shopify. Use this to exercise the dashboard end-to-end before customers subscribe.
        </Text>
        <Form method="post">
          <input type="hidden" name="op" value="create_demo" />
          <FormLayout>
            <LabeledInput
              label="Demo customer email"
              name="demoEmail"
              type="email"
              defaultValue="demo@example.com"
            />
            <ButtonGroup>
              <Button submit disabled={submitting}>
                Add demo subscription
              </Button>
            </ButtonGroup>
          </FormLayout>
        </Form>
      </BlockStack>
    </Card>
  );
}

function LabeledInput({
  label,
  name,
  type,
  defaultValue,
  min,
  max,
}: {
  label: string;
  name: string;
  type: "text" | "number" | "email";
  defaultValue?: string;
  min?: number;
  max?: number;
}) {
  // Polaris's TextField is controlled-only; for the settings + demo forms
  // the value flows through Remix Form post, so we use a plain input
  // styled to match Polaris's text-field metrics.
  return (
    <BlockStack gap="100">
      <label>
        <Text as="span" variant="bodyMd">
          {label}
        </Text>
        <input
          type={type}
          name={name}
          defaultValue={defaultValue}
          min={min}
          max={max}
          autoComplete="off"
          style={{
            display: "block",
            marginTop: 4,
            padding: "6px 12px",
            borderRadius: 8,
            border: "1px solid var(--p-color-border, #c9cccf)",
            fontSize: "0.875rem",
            width: "100%",
            maxWidth: 320,
          }}
        />
      </label>
    </BlockStack>
  );
}
