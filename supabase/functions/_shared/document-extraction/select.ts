// Provider selection from already-read configuration values. Pure: reads no
// environment itself, so every runtime supplies its own settings. Only real
// providers are selectable; the deterministic mock is never reachable from here.
//
// EF_DOCUMENT_EXTRACTION_PROVIDER: unset/empty -> "openai" (existing behaviour, unchanged),
// or exactly "openai" | "azure". Anything else fails closed as configuration_invalid.
// EF_DOCUMENT_EXTRACTION_ROUTES (optional): "passport=azure,driving_licence=openai" routes single categories
// (passport, driving_licence, visa, english_test, academic) to a provider; unlisted categories use the
// default above. A category routed to Azure that Azure has no model for is configuration_invalid and names
// the category; there is never a silent fallback to another provider.
// Error results name variables and categories, never values.
import { EXTRACTION_CATEGORIES, type DocumentExtractionProvider, type ExtractionCategory } from "./contract.ts";
import { AZURE_MODEL_ID, AzureConfigurationError, createAzureProvider } from "./azure.ts";
import { createOpenAiProvider } from "./openai.ts";

export type ProviderUnavailable = { error: string; code: "configuration_unavailable" | "configuration_invalid"; variables: string[]; categories?: ExtractionCategory[] };
export type ProviderSelection = { provider: DocumentExtractionProvider; unavailable: null } | { provider: null; unavailable: ProviderUnavailable };

const unavailable = (code: ProviderUnavailable["code"], variables: string[], categories?: ExtractionCategory[]): ProviderSelection => ({ provider: null, unavailable: { error: "Edge Function configuration is unavailable.", code, variables, ...(categories?.length ? { categories } : {}) } });
const blank = (value: string | undefined) => !(value ?? "").trim();

type Choice = "openai" | "azure";
type Options = { fetch?: typeof fetch; category?: ExtractionCategory };
const ROUTE_KEYS: Record<string, ExtractionCategory> = { passport: "Passport", driving_licence: "Driving Licence", visa: "Visa", english_test: "English Test", academic: "Academic" };

/** null = malformed. Blank = no routes. Strict: known lowercase keys, openai|azure values, no duplicates or empty entries. */
function parseRoutes(raw: string | undefined): Map<ExtractionCategory, Choice> | null {
  const routes = new Map<ExtractionCategory, Choice>();
  if (blank(raw)) return routes;
  for (const entry of raw!.split(",")) {
    const [key, value, ...rest] = entry.split("=").map((part) => part.trim());
    const category = ROUTE_KEYS[key ?? ""];
    if (rest.length || !category || (value !== "openai" && value !== "azure") || routes.has(category)) return null;
    routes.set(category, value);
  }
  return routes;
}

function selectAzure(config: Record<string, string | undefined>, options: Options, routed: ExtractionCategory[] = []): ProviderSelection {
  const missing = ["EF_AZURE_DOCUMENT_ENDPOINT", "EF_AZURE_DOCUMENT_API_KEY", "EF_AZURE_DOCUMENT_MODEL"].filter((name) => blank(config[name]));
  if (missing.length) return unavailable("configuration_unavailable", missing);
  // The default model serves the categories prebuilt-idDocument covers; every other
  // category needs an explicit mapping, otherwise manual entry continues for it.
  const modelMap: Partial<Record<ExtractionCategory, string>> = { Passport: config.EF_AZURE_DOCUMENT_MODEL!.trim(), "Driving Licence": config.EF_AZURE_DOCUMENT_MODEL!.trim() };
  if (!blank(config.EF_AZURE_DOCUMENT_MODEL_MAP)) {
    try {
      const parsed = JSON.parse(config.EF_AZURE_DOCUMENT_MODEL_MAP!);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
      for (const [category, modelId] of Object.entries(parsed)) {
        if (!(EXTRACTION_CATEGORIES as readonly string[]).includes(category) || typeof modelId !== "string" || !AZURE_MODEL_ID.test(modelId)) throw new Error("entry");
        modelMap[category as ExtractionCategory] = modelId;
      }
    } catch { return unavailable("configuration_invalid", ["EF_AZURE_DOCUMENT_MODEL_MAP"]); }
  }
  const unsupported = routed.filter((category) => !modelMap[category]);
  if (unsupported.length) return unavailable("configuration_invalid", ["EF_DOCUMENT_EXTRACTION_ROUTES", "EF_AZURE_DOCUMENT_MODEL_MAP"], unsupported);
  try {
    return {
      provider: createAzureProvider({
        endpoint: config.EF_AZURE_DOCUMENT_ENDPOINT!.trim(), apiKey: config.EF_AZURE_DOCUMENT_API_KEY!.trim(), modelMap, fetch: options.fetch,
        ...(blank(config.EF_AZURE_DOCUMENT_API_VERSION) ? {} : { apiVersion: config.EF_AZURE_DOCUMENT_API_VERSION!.trim() }),
      }),
      unavailable: null,
    };
  } catch (error) {
    return unavailable("configuration_invalid", [error instanceof AzureConfigurationError ? error.variable : "EF_AZURE_DOCUMENT_ENDPOINT"]);
  }
}

function selectOpenAi(config: Record<string, string | undefined>, options: Options): ProviderSelection {
  const variables = ["OPENAI_API_KEY", "OPENAI_DOCUMENT_MODEL"].filter((name) => !(config[name] ?? "").trim());
  if (variables.length) return unavailable("configuration_unavailable", variables);
  return { provider: createOpenAiProvider({ apiKey: config.OPENAI_API_KEY!, model: config.OPENAI_DOCUMENT_MODEL!, fetch: options.fetch }), unavailable: null };
}

/**
 * With options.category: the provider for that category. Without it: validates every provider the
 * configuration can reach (the default for unrouted categories plus each routed one) and returns the
 * first problem, or the first provider; used for availability checks before a document is known.
 */
export function createDocumentExtractionProvider(config: Record<string, string | undefined>, options: Options = {}): ProviderSelection {
  const fallback = blank(config.EF_DOCUMENT_EXTRACTION_PROVIDER) ? "openai" : config.EF_DOCUMENT_EXTRACTION_PROVIDER!;
  if (fallback !== "openai" && fallback !== "azure") return unavailable("configuration_invalid", ["EF_DOCUMENT_EXTRACTION_PROVIDER"]);
  const routes = parseRoutes(config.EF_DOCUMENT_EXTRACTION_ROUTES);
  if (!routes) return unavailable("configuration_invalid", ["EF_DOCUMENT_EXTRACTION_ROUTES"]);
  const build = (choice: Choice, routedToAzure: ExtractionCategory[]) => choice === "azure" ? selectAzure(config, options, routedToAzure) : selectOpenAi(config, options);
  if (options.category) {
    const route = routes.get(options.category);
    return build(route ?? fallback, route === "azure" ? [options.category] : []);
  }
  const azureRoutes = EXTRACTION_CATEGORIES.filter((category) => routes.get(category) === "azure");
  const choices = new Set<Choice>(routes.size < EXTRACTION_CATEGORIES.length ? [fallback] : []);
  for (const choice of routes.values()) choices.add(choice);
  let first: ProviderSelection | null = null;
  for (const choice of choices) {
    const selection = build(choice, choice === "azure" ? azureRoutes : []);
    if (selection.unavailable) return selection;
    first ??= selection;
  }
  return first!;
}
