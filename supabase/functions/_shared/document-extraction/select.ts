// Provider selection from already-read configuration values. Pure: reads no
// environment itself, so every runtime supplies its own settings. Only real
// providers are selectable; the deterministic mock is never reachable from here.
//
// EF_DOCUMENT_EXTRACTION_PROVIDER: unset/empty -> "openai" (existing behaviour, unchanged),
// or exactly "openai" | "azure". Anything else fails closed as configuration_invalid.
// Error results name variables, never values.
import { EXTRACTION_CATEGORIES, type DocumentExtractionProvider, type ExtractionCategory } from "./contract.ts";
import { AZURE_MODEL_ID, AzureConfigurationError, createAzureProvider } from "./azure.ts";
import { createOpenAiProvider } from "./openai.ts";

export type ProviderUnavailable = { error: string; code: "configuration_unavailable" | "configuration_invalid"; variables: string[] };
export type ProviderSelection = { provider: DocumentExtractionProvider; unavailable: null } | { provider: null; unavailable: ProviderUnavailable };

const unavailable = (code: ProviderUnavailable["code"], variables: string[]): ProviderSelection => ({ provider: null, unavailable: { error: "Edge Function configuration is unavailable.", code, variables } });
const blank = (value: string | undefined) => !(value ?? "").trim();

function selectAzure(config: Record<string, string | undefined>, options: { fetch?: typeof fetch }): ProviderSelection {
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

export function createDocumentExtractionProvider(config: Record<string, string | undefined>, options: { fetch?: typeof fetch } = {}): ProviderSelection {
  const choice = blank(config.EF_DOCUMENT_EXTRACTION_PROVIDER) ? "openai" : config.EF_DOCUMENT_EXTRACTION_PROVIDER!;
  if (choice === "azure") return selectAzure(config, options);
  if (choice !== "openai") return unavailable("configuration_invalid", ["EF_DOCUMENT_EXTRACTION_PROVIDER"]);
  const variables = ["OPENAI_API_KEY", "OPENAI_DOCUMENT_MODEL"].filter((name) => !(config[name] ?? "").trim());
  if (variables.length) return unavailable("configuration_unavailable", variables);
  return { provider: createOpenAiProvider({ apiKey: config.OPENAI_API_KEY!, model: config.OPENAI_DOCUMENT_MODEL!, fetch: options.fetch }), unavailable: null };
}
