// Agent onboarding in stages (2026-11-17): the administrator actions of the business page (send the application form, send the
// referee checks again, change a referee, upload a referee's form, send the agreement) and what runs after a signature (the referee
// checks go out when the agent has signed the form; staff are told when both referees are back). Everything goes through the Sign
// module: PDF templates installed from the blanks, the sender's values printed, the signer's fields placed, the emailed link. The
// database decides the stages (public.agency_onboarding_*); this module makes the PDFs and the emails. Runtime-neutral (tests mock the ports).
import { AGENT_ONBOARDING_DOCS, AGENT_ONBOARDING_FIELDS, answerKey, composeRegistrationNumber, expiryDate, F04_RECORD_KEYS, groupOf, isPdfDate, normalizeOfficeAddress, resolveFields, signerRole, WITNESS_NAME_KEY,
  WITNESS_SIGNATURE_KEY, yesNoDefaults, optionalAnswerGroups, relaxAnswerGroups, REQUIRED_GROUP_LABELS, commissionText, isCommissionGst, type OnboardingDoc, type PlacedField } from "../_shared/agent-onboarding.ts";
import { loadRules, ruleList, ruleNumber, ruleText } from "../_shared/business-rules.ts";
import { ABR_PREFILL_KEYS, abnWithAcn, abrFacts, acnDigits, lookupAbr, lookupAbrCached, phoneE164, printAcn, type AbrConfirmed, type AbrDetails, type AbrFacts } from "../_shared/validation/abr.ts";
import { checkRecipients, signingNameValid } from "../_shared/signing.ts";
import { toBase64 } from "../_shared/notification/attachment.ts";
import { outcomeState } from "../_shared/hr-mail.ts";
import { abrCache, drainSigningMail, f04Prefill, isoToday, ONBOARDING_TEMPLATES_MISSING, sha256Hex, SigningError, type RpcError, type SigningPorts } from "./core.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const onboardingPdfModule = () => import("../_shared/agent-onboarding-pdf.ts");
const signingPdfModule = () => import("../_shared/signing-pdf.ts");
// deno-lint-ignore no-explicit-any
type Json = any;

/** What an action needs from the function: the caller's RPCs, the service RPCs, the bucket and the staged-file bookkeeping. */
export interface OnboardingContext {
  ports: SigningPorts;
  body: Record<string, unknown>;
  upload: { name: string; bytes: Uint8Array } | null;
  admin(operation: string, id?: unknown, data?: unknown): Promise<Json>;
  rpc(name: string, args: Record<string, unknown>): Promise<Json>;
  store(path: string, bytes: Uint8Array): Promise<void>;
  fileBytes(path: string, expected: string): Promise<Uint8Array>;
  /** Marks the staged files as committed (the database row that references them exists). */
  commit(): void;
  /** A draft request from a saved template for a record (the Sign module's "create": the record's values printed, the signers' fields placed). */
  createRequest?(input: Record<string, unknown>): Promise<Json>;
}
interface OnboardingTemplate { id: string; systemKey: string; status: string; sourcePath: string; sourceHash: string; sourcePages: number; fields: PlacedField[]; expiryDays: number; reminderDays: number }

const text = (value: unknown, max: number) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max); // eslint-disable-line no-control-regex
const serviceRpc = async (ports: SigningPorts, name: string, args: Record<string, unknown>) => {
  if (!ports.serviceRpc) throw new SigningError("Not available.");
  try { return await ports.serviceRpc(name, args); }
  catch (error) { const e = error as RpcError; throw new SigningError(e.message, e.code === "42501" ? 403 : 400); }
};

/**
 * Business Rules for agent onboarding, read once per action (the fallbacks are the values used before):
 *   agents.onboarding_document_expiry_default / _reminder_default: a template without its own expiry / reminder days;
 *   agents.agent_application_yes_no_fallback: an unanswered Yes / No question starts at No, or stays blank;
 *   agents.onboarding_required_answer_groups: which Yes / No questions must be answered before signing;
 *   agents.agency_witness_on_agreement / agents.slit_witness_on_agreement: whether each witness on the agreement is required;
 *   agents.referee_emails_must_differ: the two referees need different email addresses;
 *   agents.business_approval_waits_for_referees: approve / send back only once every referee replied (the database refuses too);
 *   agents.review_email_recipients: who the staff emails about an application go to.
 */
interface OnboardingRules {
  expiryDays: number; reminderDays: number; yesNoDefault: boolean; optionalGroups: Set<string>;
  agencyWitnessRequired: boolean; slitWitnessRequired: boolean; refereeEmailsDistinct: boolean; waitForReferees: boolean; reviewRecipients: Set<string>;
}
/** The three sources of the staff emails (agents.review_email_recipients); all three before the rule existed. */
export const REVIEW_RECIPIENTS = { starter: "Staff member who started it", admins: "Active CMS administrators", contacts: "Admissions and office contacts" } as const;
const rulesRead = new WeakMap<object, Promise<OnboardingRules>>();
function onboardingRules(ctx: Pick<OnboardingContext, "ports"> & Partial<Pick<OnboardingContext, "rpc">>): Promise<OnboardingRules> {
  let read = rulesRead.get(ctx);
  if (!read) {
    const call = ctx.ports.serviceRpc ? ctx.ports.serviceRpc.bind(ctx.ports) : ctx.rpc ? ctx.rpc.bind(ctx) : null;
    read = loadRules({ rpc: async (fn, args) => { try { if (!call) throw new Error("no rpc"); return { data: await call(fn, args), error: null }; } catch (error) { return { data: null, error }; } } },
      ["agents.onboarding_document_expiry_default", "agents.onboarding_document_reminder_default", "agents.agent_application_yes_no_fallback", "agents.onboarding_required_answer_groups",
        "agents.agency_witness_on_agreement", "agents.slit_witness_on_agreement", "agents.referee_emails_must_differ", "agents.business_approval_waits_for_referees", "agents.review_email_recipients"])
      .then((values) => ({
        expiryDays: Math.max(1, Math.round(ruleNumber(values, "agents.onboarding_document_expiry_default", 30))),
        reminderDays: Math.max(0, Math.round(ruleNumber(values, "agents.onboarding_document_reminder_default", 3))),
        yesNoDefault: ruleText(values, "agents.agent_application_yes_no_fallback", "No") === "No",
        optionalGroups: optionalAnswerGroups(ruleList(values, "agents.onboarding_required_answer_groups", Object.values(REQUIRED_GROUP_LABELS))),
        agencyWitnessRequired: ruleText(values, "agents.agency_witness_on_agreement", "Required") !== "Optional",
        slitWitnessRequired: ruleText(values, "agents.slit_witness_on_agreement", "Optional") === "Required",
        refereeEmailsDistinct: ruleText(values, "agents.referee_emails_must_differ", "Must be different") !== "May be the same",
        waitForReferees: ruleText(values, "agents.business_approval_waits_for_referees", "Approve without waiting") === "Wait for every referee",
        reviewRecipients: new Set(ruleList(values, "agents.review_email_recipients", Object.values(REVIEW_RECIPIENTS))),
      }));
    rulesRead.set(ctx, read);
  }
  return read;
}
/** The onboarding rules for the signing page (core.ts): the agency's witness and the referee emails. */
const signRulesCtx = new WeakMap<SigningPorts, Pick<OnboardingContext, "ports">>();
export function onboardingSignRules(ports: SigningPorts): Promise<OnboardingRules> {
  let ctx = signRulesCtx.get(ports);
  if (!ctx) { ctx = { ports } as Pick<OnboardingContext, "ports">; signRulesCtx.set(ports, ctx); }
  return onboardingRules(ctx);
}
const numbered = (fields: PlacedField[], offset = 0) => fields.map((f) => ({ ...f, page: Number(f.page) + offset, x: Number(f.x), y: Number(f.y), w: Number(f.w), h: Number(f.h) }));

/**
 * One of the three blanks (uploaded by the CMS from public/templates) as a PDF template of the Sign module, marked by its system key.
 * Installing is idempotent: a template already holding the key is reused (an archived one comes back active) and the upload is ignored;
 * otherwise the blank is stored and the database claims the key (insert ... on conflict do nothing, then select), so two sends installing
 * at once end with one template and the loser removes its copy of the file.
 */
export async function installBlank(ctx: OnboardingContext): Promise<Json> {
  await ctx.admin("subject_search", null, { type: "none" });
  const which = String(ctx.body.which ?? "") as OnboardingDoc;
  const spec = AGENT_ONBOARDING_DOCS[which];
  if (!spec) throw new SigningError("Say which blank to install: form, referee or agreement.");
  const installed = ((await ctx.rpc("agency_onboarding_templates", {})) as OnboardingTemplate[]).find((t) => t.systemKey === spec.key);
  // refresh: the blank shipped with the site changed; the same template takes the new file and the fields read from it (no new row).
  const refresh = ctx.body.refresh === true && !!installed;
  if (installed && !refresh) {
    const kept = await ctx.rpc("agency_onboarding_template_install", { p_key: spec.key, p_data: null });
    if (kept?.id) return { id: kept.id, systemKey: spec.key, fields: Number(kept.fields ?? installed.fields?.length ?? 0), pages: Number(kept.pages ?? installed.sourcePages), reused: true };
  }
  if (!ctx.upload) throw new SigningError(`Choose the ${spec.name} PDF.`);
  if (await sha256Hex(ctx.upload.bytes) !== spec.sha256) throw new SigningError(`This file is not the ${spec.name} blank (checksum mismatch). Use the copy shipped with the site.`);
  let read: Awaited<ReturnType<Awaited<ReturnType<typeof onboardingPdfModule>>["readBlankTemplate"]>>;
  try { read = await (await onboardingPdfModule()).readBlankTemplate(which, ctx.upload.bytes); }
  catch (error) { throw new SigningError((error as Error).message); }
  // A refreshed template keeps its id: its source files live under templates/<id>/ (hr.sign_templates kind_source check).
  const id = refresh && installed ? installed.id : ctx.ports.uuid();
  const path = `templates/${id}/source-${ctx.ports.uuid()}.pdf`;
  await ctx.store(path, read.flattened);
  const result = await ctx.rpc("agency_onboarding_template_install", { p_key: spec.key, p_data: { id, name: spec.name, title: spec.title, category: spec.category, roles: [signerRole(which)], fields: read.fields,
    signing_mode: "sequential", expiry_days: (await onboardingRules(ctx)).expiryDays, reminder_days: (await onboardingRules(ctx)).reminderDays, source_path: path, source_hash: await sha256Hex(read.flattened), source_pages: read.pages, refresh } });
  if (result?.refreshed) { ctx.commit(); return { id: result.id, systemKey: spec.key, fields: read.fields.length, pages: read.pages, reused: false, refreshed: true, version: Number(result.version ?? 0) }; }
  if (result?.reused) {
    // Another send installed this blank first: its template is the one; this upload is not referenced by anything.
    try { await ctx.ports.storage.remove([path]); } catch { /* left for a later clean-up */ }
    ctx.commit();
    return { id: result.id, systemKey: spec.key, fields: Number(result.fields ?? 0), pages: Number(result.pages ?? read.pages), reused: true };
  }
  ctx.commit();
  return { id: result?.id ?? id, systemKey: spec.key, fields: read.fields.length, pages: read.pages, reused: false };
}

async function installedTemplate(ctx: OnboardingContext, which: OnboardingDoc): Promise<OnboardingTemplate> {
  const templates = (await ctx.rpc("agency_onboarding_templates", {})) as OnboardingTemplate[];
  const found = templates.find((t) => t.systemKey === AGENT_ONBOARDING_DOCS[which].key && t.status === "active");
  // The CMS reads the name in brackets and installs that blank (public/templates), then tries again.
  if (!found) throw new SigningError(`${ONBOARDING_TEMPLATES_MISSING} (${which})`);
  return found;
}

/** The document of one template for one send: the sender's values printed into it, the signer's fields to place. */
async function buildDocument(ctx: OnboardingContext, template: OnboardingTemplate, values: Record<string, string>, title: string, options: { editablePrefill?: boolean } = {}) {
  const source = await ctx.fileBytes(template.sourcePath, template.sourceHash);
  const { printed, recipient } = resolveFields(numbered(template.fields), values, options);
  let bytes = source;
  if (printed.length) {
    const started = performance.now();
    // incremental: the prefilled values are appended to the installed blank (CPU budget, 2026-11-20); a full re-write when that is not possible.
    bytes = await (await signingPdfModule()).stampDocument(source, { reference: "", title, recipients: [], incremental: true,
      fields: printed.map((f) => ({ recipient_id: null, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, value: f.value, done: true, label: f.label })) });
    pdfWorkMs += performance.now() - started;
  }
  return { bytes, printed, recipient };
}
/** PDF time spent in buildDocument since the last call (the cpu_steps log of a call that builds documents deep inside, e.g. the referee checks). */
let pdfWorkMs = 0;
export function takePdfWorkMs(): number { const ms = Math.round(pdfWorkMs); pdfWorkMs = 0; return ms; }
const recipientFields = (fields: PlacedField[], role: string) => fields.map((f) => ({ type: f.type, role, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required, label: f.label, key: f.key, value: f.value }));

interface Prepared {
  agency: { id: string; name: string; abn: string | null }; agent: { id: string; name: string; email: string } | null;
  admin: { name: string; position: string; signaturePng: string | null }; values: Record<string, unknown>;
}
async function prepare(ctx: OnboardingContext, agencyId: string, agentId: unknown): Promise<Prepared> {
  if (!UUID.test(agencyId)) throw new SigningError("Choose a business.");
  const prepared = await ctx.rpc("agency_onboarding_prepare", { p_agency: agencyId, p_agent: UUID.test(String(agentId ?? "")) ? agentId : null }) as Prepared;
  if (!prepared?.agent) throw new SigningError("This business has no active agent to send the documents to. Add its business admin agent first.");
  return prepared;
}
/** The values our records give, plus the ABN Lookup (legal entity, trading name, GST, state, postcode). Unavailable: left for the agent. */
async function recordValues(ctx: OnboardingContext, prepared: Pick<Prepared, "agency" | "values">): Promise<Record<string, string>> {
  return (await recordValuesWithFacts(ctx, prepared)).values;
}
/**
 * The same, with the register's facts (status, entity type, GST date, ACN). The register's answer is cached by ABN (public.abr_businesses,
 * 2026-11-19): a send within 30 days of an earlier lookup does not ask again. One rule with the open (f04Prefill): trading name falls back to
 * the entity name, year founded from the ABN's status date, the ACN from the ASIC table, the postcode in the Suburb box. Our records win.
 */
async function recordValuesWithFacts(ctx: OnboardingContext, prepared: Pick<Prepared, "agency" | "values">): Promise<{ values: Record<string, string>; facts: AbrFacts | null }> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(prepared.values ?? {})) if (typeof value === "string" && value.trim()) values[key] = value.trim();
  let facts: AbrFacts | null = null, register: Record<string, string> = {};
  if (prepared.agency.abn) {
    const found = await lookupAbrCached(prepared.agency.abn, ctx.ports.abr?.guid, abrCache(ctx.ports), ctx.ports.abr?.fetch ?? fetch);
    if (found) {
      facts = abrFacts(found.details, found.fetchedAt);
      if (found.details.entityName) values.agent_organisation_name = found.details.entityName;
      register = f04Prefill({ details: found.details, confirmed: null, record: values });
    }
  }
  // The register's Suburb box is the record's suburb with the postcode joined (never a postcode alone, round 3).
  const merged: Record<string, string> = normalizeOfficeAddress({ ...register, ...values, ...(register.office_suburb ? { office_suburb: register.office_suburb } : {}) } as Record<string, string>);
  const phone = phoneE164(merged.contact_phone); if (phone) merged.contact_phone = phone;
  return { values: merged, facts };
}

/** What the business keeps from ABN Lookup (agencies.abr_*): the register's answer, the values staff confirmed, the contact's names. */
interface BusinessAbr { details: AbrDetails | null; confirmed: (AbrConfirmed & { givenName?: string; familyName?: string }) | null; fetchedAt: string | null }
/**
 * ABN prefill (2026-11-19): a business added with an ABN Lookup confirmation gets the F04 prefilled from what is kept on the business (no new
 * call to the register), every prefilled value editable by the contact; everything else is blank. A business without one keeps the earlier values.
 */
async function applicationValues(ctx: OnboardingContext, prepared: Prepared): Promise<{ values: Record<string, string>; prefill: Record<string, string> | null; facts: AbrFacts | null }> {
  const found = await applicationValuesFromRegister(ctx, prepared);
  // The business's ACN (2026-11-20) wins: the register's or a company's derived one kept on the business, or the one it typed before.
  // None kept: the register's answer computed above by the same rule (blank for a sole trader, partnership or trust: editable on the form).
  const acn = await businessAcn(ctx, prepared.agency.id);
  const values = { ...found.values }, prefill = found.prefill ? { ...found.prefill } : null;
  if (acn) { values.agent_acn = printAcn(acn); if (prefill) prefill.agent_acn = printAcn(acn); }
  return { values, prefill, facts: found.facts };
}
async function applicationValuesFromRegister(ctx: OnboardingContext, prepared: Prepared): Promise<{ values: Record<string, string>; prefill: Record<string, string> | null; facts: AbrFacts | null }> {
  let abr: BusinessAbr | null = null;
  try { abr = await ctx.rpc("agency_abr_get", { p_agency: prepared.agency.id }) as BusinessAbr | null; } catch { abr = null; }
  if (!abr?.confirmed) {
    // No ABR confirmation on the business (EF_ABR_GUID not set): the public page's values, still editable by the contact in the wizard.
    const { values, facts } = await recordValuesWithFacts(ctx, prepared);
    const prefill = Object.fromEntries([...new Set([...ABR_PREFILL_KEYS, ...F04_RECORD_KEYS])].filter((k) => values[k]).map((k) => [k, values[k]]));
    return { values, prefill: Object.keys(prefill).length ? prefill : null, facts };
  }
  const record = prepared.values ?? {};
  const parts = String(prepared.agent?.name ?? "").trim().split(/\s+/);
  // The register's answer kept on the business (staff confirmed it) and the business record (website, title, office, from the sign-up / profile).
  if (abr.details) { const cache = abrCache(ctx.ports); if (cache) await cache.put(abr.details).catch(() => undefined); }
  const prefill = f04Prefill({ details: abr.details, confirmed: { ...abr.confirmed,
    givenName: abr.confirmed.givenName || String(record.contact_given_name ?? "") || parts.slice(0, -1).join(" ") || parts[0] || "",
    familyName: abr.confirmed.familyName || String(record.contact_family_name ?? "") || (parts.length > 1 ? parts[parts.length - 1] : "") },
    record: { ...Object.fromEntries(F04_RECORD_KEYS.map((k) => [k, record[k]])), contact_email: String(prepared.agent?.email ?? ""), contact_phone: String(record.contact_phone ?? "") } });
  return { values: { ...prefill }, prefill, facts: abr.details ? abrFacts(abr.details, abr.fetchedAt ?? new Date().toISOString()) : null };
}

/** Add business: the ABN typed is looked up on the register (EF_ABR_GUID); the answer is cached by ABN for the business about to be saved. */
export async function abnLookup(ctx: OnboardingContext): Promise<Json> {
  await ctx.admin("subject_search", null, { type: "none" });
  const outcome = await lookupAbr(String(ctx.body.abn ?? ""), ctx.ports.abr?.guid, ctx.ports.abr?.fetch ?? fetch);
  if (!outcome.ok) return { configured: outcome.reason !== "not_configured", ok: false, reason: outcome.reason, message: outcome.message };
  let cached = true;
  try { await ctx.rpc("abr_lookup_save", { p_abn: outcome.details.abn, p_raw: outcome.raw, p_details: outcome.details }); } catch { cached = false; }
  return { configured: true, ok: true, details: outcome.details, fetchedAt: outcome.fetchedAt, cached };
}

/** Stage 1: the application form (F04) to the business's agent. */
export async function sendApplication(ctx: OnboardingContext): Promise<Json> {
  const agencyId = String(ctx.body.agencyId ?? "");
  const prepared = await prepare(ctx, agencyId, ctx.body.agentId);
  const template = await installedTemplate(ctx, "form");
  // The referee checks go out by themselves when the form is signed (no browser to install a blank then): all three must exist now.
  await installedTemplate(ctx, "referee"); await installedTemplate(ctx, "agreement");
  const { values, prefill, facts } = await applicationValues(ctx, prepared);
  // The ACN is kept as digits in the request's stored values (no box on the form; printed "603 584 676" on the page and in the registration box).
  if (values.agent_acn) values.agent_acn = acnDigits(values.agent_acn);
  // Every Yes / No question starts at No (2026-11-20), for any tick-box pair of the template.
  if ((await onboardingRules(ctx)).yesNoDefault) yesNoDefaults(template.fields, values);
  const title = `Agent application form: ${text(prepared.agency.name, 150)}`.slice(0, 200);
  // F04 wizard (2026-11-19): every value we hold is the contact's to correct (the Company summary's Edit), whatever its source.
  const made = await buildDocument(ctx, template, values, title, { editablePrefill: true });
  const recipients = checkRecipients([{ name: prepared.agent!.name, email: prepared.agent!.email, role: signerRole("form").key, label: signerRole("form").label, order: 1, required: true }]);
  const id = ctx.ports.uuid();
  await ctx.store(`${id}/original.pdf`, made.bytes);
  const record = await ctx.admin("create", id, { title, template_id: template.id, rendered_text: null, field_values: values, original_hash: await sha256Hex(made.bytes), recipients,
    fields: relaxAnswerGroups(recipientFields(made.recipient, signerRole("form").key), (await onboardingRules(ctx)).optionalGroups), subject_type: "agent", subject_id: prepared.agent!.id, category: "other", message: text(ctx.body.message, 2000) || null, edited: false,
    template_text: null, signing_mode: "sequential", expiry_days: template.expiryDays ?? (await onboardingRules(ctx)).expiryDays, reminder_days: template.reminderDays ?? (await onboardingRules(ctx)).reminderDays });
  let onboarding: Json;
  try {
    onboarding = await ctx.rpc("agency_onboarding_create", { p_agency: agencyId, p_agent: prepared.agent!.id, p_request: id,
      p_data: { form_pages: template.sourcePages, values, message: text(ctx.body.message, 2000) || null, admin_name: text(prepared.admin?.name, 150) } });
  } catch (error) {
    // One open onboarding per business (a double click, a retry): the draft made for this attempt is voided and never emailed.
    try { await ctx.admin("void", id, { reason: "Not sent: the business already has an onboarding in progress" }); } catch { /* left as an unsent draft */ }
    throw error;
  }
  ctx.commit();
  // The onboarding history says which values were prefilled; the database compares them with the signed answers (prefill_reviewed).
  if (prefill) { try { await ctx.rpc("agency_onboarding_prefill_record", { p_onboarding: onboarding.id, p_prefill: prefill }); } catch { /* the form still goes; only the history line is missing */ } }
  // The register's facts (status, entity type, GST date, ACN) on the business profile, shown read-only in the wizard's Company summary.
  if (facts) { try { await ctx.rpc("agency_abr_facts_record", { p_agency: agencyId, p_facts: facts }); } catch { /* the wizard looks them up itself */ } }
  return await sendRequest(ctx, id, { reference: record.reference, onboardingId: onboarding.id, stage: onboarding.stage, agent: { name: prepared.agent!.name, email: prepared.agent!.email }, printed: made.printed.length, fields: made.recipient.length, prefilled: prefill ? Object.keys(prefill).length : 0 });
}
async function sendRequest(ctx: OnboardingContext, id: string, result: Record<string, unknown>) {
  const { provider, config } = ctx.ports.mail;
  if (!provider || !config.siteUrl || !config.from) return { id, ...result, sent: false, warning: "Signing email is not configured, so nothing was emailed. The request was kept as a draft: send it from the request." };
  const sent = await ctx.admin("send", id, {});
  const mail = await drainSigningMail(ctx.ports);
  return { id, ...result, sent: true, state: sent.state, mail };
}

/** The SLIT signatory of an agreement: name, position and signature (saved, drawn or typed). */
/** The SLIT signatory from a request body (Approve, or Prepare application's data since 2026-11-21): name, position, saved / drawn / typed signature. */
async function signatoryOf(ctx: OnboardingContext, prepared: Prepared, source: Record<string, unknown> = ctx.body): Promise<{ adminName: string; adminPosition: string; adminSignature: string }> {
  const adminName = text(source.adminName ?? prepared.admin?.name, 150);
  const adminPosition = text(source.adminPosition ?? prepared.admin?.position, 150);
  if (!adminName) throw new SigningError("Enter the name of the SLIT signatory.");
  if (!adminPosition) throw new SigningError("Enter the position of the SLIT signatory.");
  const signature = source.adminSignature && typeof source.adminSignature === "object" ? source.adminSignature as { kind?: string; png?: string; name?: string; save?: boolean } : {};
  if (signature.kind === "saved") {
    if (!prepared.admin?.signaturePng) throw new SigningError("You have no saved signature yet. Draw one, or type your name.");
    return { adminName, adminPosition, adminSignature: `data:image/png;base64,${prepared.admin.signaturePng}` };
  }
  if (signature.kind === "drawn") {
    const bytes = (await signingPdfModule()).signatureImageBytes(signature.png);
    if (signature.save === true) await ctx.rpc("cms_user_signature_save", { p_png: toBase64(bytes) });
    return { adminName, adminPosition, adminSignature: `data:image/png;base64,${toBase64(bytes)}` };
  }
  const typed = text(signature.name ?? adminName, 150);
  if (!signingNameValid(typed)) throw new SigningError("Type the signatory's name as the signature, or draw one.");
  return { adminName, adminPosition, adminSignature: typed };
}

/**
 * A witness: a typed name and a DRAWN signature (owner brief 2026-11-20: never typed). Both or neither; a name alone (the earlier dialog's
 * "SLIT witness name") is refused, because the signature line would otherwise be empty or typed.
 */
async function drawnWitness(raw: unknown, legacyName?: unknown): Promise<{ name: string; png: string } | null> {
  const w = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as { name?: unknown; png?: unknown } : {};
  const name = text(w.name ?? legacyName, 150);
  const drawn = typeof w.png === "string" && w.png.trim() ? w.png : null;
  if (!name && !drawn) return null;
  if (!drawn) throw new SigningError("The witness must draw their signature (it cannot be typed). Draw it, or leave the witness empty.");
  if (name.length < 2) throw new SigningError("Enter the witness's full name.");
  let bytes: Uint8Array;
  try { bytes = (await signingPdfModule()).signatureImageBytes(drawn); } catch { throw new SigningError("The witness signature could not be read. Draw it again."); }
  return { name, png: toBase64(bytes) };
}
const SLIT_WITNESS_REQUIRED = "A SLIT witness is required on the agreement: the witness types their name and draws their signature.";
const witnessValues = (w: { name: string; png: string } | null): Record<string, string> => w ? { admin_witness_name: w.name, admin_witness_signature: `data:image/png;base64,${w.png}` } : {};

/** Stage 3: the agreement (P06) to the agent, at References received or earlier with a typed reason. */
export async function sendAgreement(ctx: OnboardingContext): Promise<Json> {
  const onboardingId = String(ctx.body.onboardingId ?? "");
  if (!UUID.test(onboardingId)) throw new SigningError("Choose an onboarding.");
  const prepared = await prepare(ctx, String(ctx.body.agencyId ?? ""), ctx.body.agentId);
  const template = await installedTemplate(ctx, "agreement");
  const commencement = text(ctx.body.commencementDate, 10);
  if (!isPdfDate(commencement) || Number.isNaN(Date.parse(commencement))) throw new SigningError("Enter the commencement date.");
  const territory = text(ctx.body.territory, 200);
  if (!territory) throw new SigningError("Enter the territory (Item 3).");
  const commission = text(ctx.body.commissionPercent, 10).replace(/%/g, "");
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(commission) || Number(commission) > 100) throw new SigningError("Enter the commission as a percentage, for example 25.");
  const { adminName, adminPosition, adminSignature } = await signatoryOf(ctx, prepared);
  const witness = await drawnWitness(ctx.body.adminWitness, ctx.body.adminWitnessName);
  if (!witness && (await onboardingRules(ctx)).slitWitnessRequired) throw new SigningError(SLIT_WITNESS_REQUIRED);
  const values = await recordValues(ctx, prepared);
  Object.assign(values, { agreement_commencement_date: commencement, agent_territory: territory, agent_commission_percent: commission, admin_name: adminName, admin_position: adminPosition,
    admin_signed_date: isoToday(), admin_signature: adminSignature, ...witnessValues(witness) });
  const title = `Agent agreement: ${text(prepared.agency.name, 150)}`.slice(0, 200);
  const built = await buildDocument(ctx, template, values, title);
  // The agent's witness signature is drawn, never typed (2026-11-20): no typing box for it on this (earlier-flow) agreement.
  const made = { ...built, recipient: built.recipient.filter((f) => f.key !== WITNESS_SIGNATURE_KEY) };
  const sentValues = Object.fromEntries(Object.entries(values).filter(([key]) => key !== "admin_signature"));
  const recipients = checkRecipients([{ name: prepared.agent!.name, email: prepared.agent!.email, role: signerRole("agreement").key, label: signerRole("agreement").label, order: 1, required: true }]);
  const id = ctx.ports.uuid();
  await ctx.store(`${id}/original.pdf`, made.bytes);
  const record = await ctx.admin("create", id, { title, template_id: template.id, rendered_text: null, field_values: sentValues, original_hash: await sha256Hex(made.bytes), recipients,
    fields: recipientFields(made.recipient, signerRole("agreement").key), subject_type: "agent", subject_id: prepared.agent!.id, category: AGENT_ONBOARDING_DOCS.agreement.category,
    message: text(ctx.body.message, 2000) || null, edited: false, template_text: null, signing_mode: "sequential", expiry_days: template.expiryDays ?? (await onboardingRules(ctx)).expiryDays, reminder_days: template.reminderDays ?? (await onboardingRules(ctx)).reminderDays });
  const onboarding = await ctx.rpc("agency_onboarding_agreement_create", { p_onboarding: onboardingId, p_request: id, p_data: { commencement_date: commencement, expiry_date: expiryDate(commencement),
    territory, commission_percent: commission, admin_name: adminName, admin_position: adminPosition, values: sentValues, override_reason: text(ctx.body.overrideReason, 500) || null } });
  ctx.commit();
  return await sendRequest(ctx, id, { reference: record.reference, onboardingId, stage: onboarding.stage, override: onboarding.override === true, printed: made.printed.length, fields: made.recipient.length });
}

/**
 * Onboarding per business (2026-11-19, owner): Add business saves the business and its point of contact (POC) and sends the Agent
 * Application Form (F04) to the POC at once, in one call. The three blanks are checked before anything is saved, so the CMS can install a
 * missing one and call again without a second business. Only this call sends the first F04: an existing business never gets one by itself
 * (staff use Resend application / Start again). The database allows one open onboarding per business, so a retry cannot send a second F04.
 */
/**
 * The business's ACN (agencies.acn): its ABN looked up first when given (the cached answer fills the ACN in the database), then read back.
 * Never fails a send or a save: "" when there is none (sole traders, partnerships, trusts) or the register is not answering.
 */
export async function businessAcn(ctx: OnboardingContext, agencyId: string, abn?: string | null): Promise<string> {
  try {
    if (abn && String(abn).replace(/\D/g, "").length === 11) {
      await lookupAbrCached(String(abn), ctx.ports.abr?.guid, abrCache(ctx.ports), ctx.ports.abr?.fetch ?? fetch).catch(() => null);
    }
    const kept = await ctx.rpc("agency_acn_sync", { p_agency: agencyId }) as { acn?: string | null } | null;
    return String(kept?.acn ?? "");
  } catch {
    return "";
  }
}

/**
 * Delete business (owner 2026-11-20): only at "Application sent", only by a SLIT administrator, never a system business, never with
 * students or applications; the database decides (public.admin_business_delete, with the typed name or ABN) and removes every row in one
 * transaction with triggers off (nothing emailed). The signing files it names are then removed from storage. Silent: no email to anyone.
 */
export async function deleteBusiness(ctx: OnboardingContext): Promise<Json> {
  await ctx.admin("subject_search", null, { type: "none" });
  const agencyId = agencyIdOf(ctx.body);
  const result = await ctx.rpc("admin_business_delete", { p_business: agencyId, p_confirm: text(ctx.body.confirm, 300) }) as
    { deleted: boolean; name: string; abn: string | null; files: string[] | null; counts: Record<string, number> };
  const files = (result.files ?? []).filter((path) => typeof path === "string" && path.length > 0);
  let filesLeft = 0;
  if (files.length) {
    try { await ctx.ports.storage.remove(files); }
    catch (error) {
      filesLeft = files.length;
      console.warn(JSON.stringify({ event: "business_delete_files_left", count: files.length, error: String((error as Error)?.message ?? error).slice(0, 200) }));
    }
  }
  return { deleted: true, name: result.name, abn: result.abn, counts: result.counts, filesRemoved: files.length - filesLeft, filesLeft };
}

export async function createBusiness(ctx: OnboardingContext): Promise<Json> {
  await ctx.admin("subject_search", null, { type: "none" });
  await installedTemplate(ctx, "form"); await installedTemplate(ctx, "referee"); await installedTemplate(ctx, "agreement");
  const agency = ctx.body.agency && typeof ctx.body.agency === "object" ? ctx.body.agency as Record<string, unknown> : null;
  if (!agency) throw new SigningError("Enter the business's details.");
  const contactName = text(ctx.body.contactName, 100), contactEmail = text(ctx.body.contactEmail, 254).toLowerCase();
  if (contactName.length < 2) throw new SigningError("Enter the point of contact's name (2 to 100 characters).");
  if (!/^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/.test(contactEmail)) throw new SigningError("Enter the point of contact's email address.");
  const created = await ctx.rpc("admin_business_create", { p_agency: agency, p_contact_email: contactEmail, p_contact_name: contactName }) as
    { agencyId: string; businessId: string; agencyName: string; contactAgentId: string };
  // ABN prefill: the values staff confirmed from ABN Lookup (and the register's cached answer) are kept on the business for the F04.
  let abrWarning: string | null = null;
  const abr = ctx.body.abr && typeof ctx.body.abr === "object" ? ctx.body.abr as Record<string, unknown> : null;
  if (abr) {
    try { await ctx.rpc("agency_abr_attach", { p_agency: created.agencyId, p_confirmed: abr }); }
    catch (error) { abrWarning = `The ABN details could not be kept on the business (${(error as Error).message}); the application form goes without the ABN prefill.`; }
  }
  // The ACN (2026-11-20, owner): the ABN's register entry is looked up and cached (abr_businesses, the public ABN Lookup page when the ABR
  // service is not set up); the database keeps the business's ACN from it by the rule (register ACN, or derived for a company only).
  await businessAcn(ctx, created.agencyId, String(agency.registration_number ?? ""));
  // 2026-11-20 (owner): nothing is emailed yet. A draft onboarding is opened for the pre-send step, where staff fill in and check the F04
  // and the agreement terms (and may add the witness) before Send to point of contact.
  try {
    const draft = await ctx.rpc("agency_onboarding_presend_save", { p_agency: created.agencyId, p_data: { agentId: created.contactAgentId, message: text(ctx.body.message, 2000) || null } }) as { onboardingId: string };
    return { ...created, application: null, presend: true, onboardingId: draft.onboardingId, ...(abrWarning ? { abrWarning } : {}) };
  } catch (error) {
    return { ...created, application: null, presend: true, onboardingId: null, warning: `The business was saved, but its application draft could not be started: ${(error as Error).message} Open Prepare application on its page.` };
  }
}

/* ------------------------------------------------------------------ pre-send step and one signature (owner brief 2026-11-20)
 * Add business opens a draft; staff fill in the F04 (the references stay empty), the agreement terms and optionally the SLIT witness
 * (typed name + drawn signature), then Save draft or Send to point of contact. Send makes ONE request: the F04 pages followed by the P06
 * pages, signed once by the agency admin (the one signature fills the signature box of both documents). Approve countersigns and issues
 * the signed agreement; no second signature is asked for.
 */
interface PresendSaved {
  onboardingId: string | null; stage: string | null; openStage: string | null;
  agency: { id: string; name: string; abn: string | null; status: string }; contact: { id: string; name: string; email: string } | null;
  presend: { answers?: Record<string, string>; acn?: string; marn?: string; message?: string } | null;
  terms: { commencementDate: string | null; territory: string | null; commissionPercent: number | string | null; commissionGst?: string | null } | null;
  witness: { name: string | null; png: string | null } | null; savedAt: string | null; savedBy: string | null;
  /** 2026-11-21: the SLIT signatory kept with the draft, and the organisation printed on the agreement (cms_settings.legal_name). */
  signatory?: { name: string | null; position: string | null } | null; organisation?: string | null;
}
interface PresendInput { answers: Record<string, string>; acn: string; marn: string; message: string; commencementDate: string; territory: string; commissionPercent: string;
  /** GST on the commission (2026-11-21): required to send; a draft may leave it empty. */
  commissionGst: "" | "inclusive" | "exclusive";
  /** The SLIT signatory as Prepare application sends it (adminName, adminPosition, adminSignature: saved / drawn / typed). */
  signatory: Record<string, unknown>;
  witness: { name: string; png: string } | null }
/** The SLIT signatory printed on the agreement when it is sent (2026-11-21): name, position, signature (PNG data URL or typed), date. */
interface SlitSignatory { name: string; position: string; signature: string; signedOn: string }
const REFERENCE_KEY = /^ref[12]_/;

/** The pre-send form as sent by the CMS; sending needs the agreement terms, a draft keeps whatever is there. */
async function presendInput(body: Record<string, unknown>, sending: boolean): Promise<PresendInput> {
  const raw = body.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data as Record<string, unknown> : {};
  const answers: Record<string, string> = {};
  if (raw.answers && typeof raw.answers === "object" && !Array.isArray(raw.answers)) {
    for (const [key, value] of Object.entries(raw.answers as Record<string, unknown>)) if (/^[a-z][a-z0-9_]{0,60}$/.test(key) && !REFERENCE_KEY.test(key)) answers[key] = text(value, 500);
  }
  const commencementDate = text(raw.commencementDate, 10), territory = text(raw.territory, 200), commissionPercent = text(raw.commissionPercent, 10).replace(/%/g, "");
  if ((sending || commencementDate) && (!isPdfDate(commencementDate) || Number.isNaN(Date.parse(commencementDate)))) throw new SigningError("Enter the agreement's commencement date (Item 5).");
  if (sending && !territory) throw new SigningError("Enter the territory (Item 3).");
  if ((sending || commissionPercent) && (!/^\d{1,3}(\.\d{1,2})?$/.test(commissionPercent) || Number(commissionPercent) > 100)) throw new SigningError("Enter the commission as a percentage, for example 25.");
  const acn = acnDigits(text(raw.acn, 20)), marn = text(raw.marn, 20).replace(/\s/g, "");
  if (acn && !/^\d{9}$/.test(acn)) throw new SigningError("The ACN has 9 digits.");
  if (marn && !/^\d{1,10}$/.test(marn)) throw new SigningError("The MARN is a number: digits only.");
  // GST on the commission: one of the two, or (a draft only) not chosen yet. Never guessed.
  const gstRaw = text(raw.commissionGst, 20).toLowerCase();
  if (gstRaw && !isCommissionGst(gstRaw)) throw new SigningError("Choose GST inclusive or GST exclusive for the commission.");
  if (sending && !gstRaw) throw new SigningError("Choose whether the commission is GST inclusive or GST exclusive (Item 4).");
  const commissionGst = (gstRaw || "") as PresendInput["commissionGst"];
  const signatory = { adminName: raw.adminName, adminPosition: raw.adminPosition, adminSignature: raw.adminSignature };
  const witness = await drawnWitness({ name: raw.witnessName, png: raw.witnessPng });
  return { answers, acn, marn, message: text(raw.message, 2000), commencementDate, territory, commissionPercent, commissionGst, signatory, witness };
}
async function savePresend(ctx: OnboardingContext, agencyId: string, input: PresendInput, agentId: string | null): Promise<{ onboardingId: string; savedAt: string; contact: { id: string; name: string; email: string } }> {
  return await ctx.rpc("agency_onboarding_presend_save", { p_agency: agencyId, p_data: { agentId, answers: input.answers, acn: input.acn || null, marn: input.marn || null, message: input.message || null,
    commencementDate: input.commencementDate || null, expiryDate: input.commencementDate ? expiryDate(input.commencementDate) : null, territory: input.territory, commissionPercent: input.commissionPercent || null,
    commissionGst: input.commissionGst || null, adminName: text(input.signatory.adminName, 150) || null, adminPosition: text(input.signatory.adminPosition, 150) || null,
    witnessName: input.witness?.name ?? null, witnessPng: input.witness?.png ?? null } });
}
const agencyIdOf = (body: Record<string, unknown>) => { const id = String(body.agencyId ?? ""); if (!UUID.test(id)) throw new SigningError("Choose a business."); return id; };

/** Opens the pre-send step: the F04 as the wizard reads it (our records and the register, then what staff saved), the terms and the witness. */
export async function presendOpen(ctx: OnboardingContext): Promise<Json> {
  await ctx.admin("subject_search", null, { type: "none" });
  const agencyId = agencyIdOf(ctx.body);
  const form = await installedTemplate(ctx, "form"); await installedTemplate(ctx, "referee"); await installedTemplate(ctx, "agreement");
  const saved = await ctx.rpc("agency_onboarding_presend_get", { p_agency: agencyId }) as PresendSaved;
  if (saved.openStage) throw new SigningError("This business's application has already been sent. Follow it on the business page.");
  const prepared = await prepare(ctx, agencyId, saved.contact?.id ?? ctx.body.agentId);
  const { values, facts } = await applicationValues(ctx, prepared);
  const answers: Record<string, string> = { ...values, ...(saved.presend?.answers ?? {}) };
  for (const key of Object.keys(answers)) if (REFERENCE_KEY.test(key)) delete answers[key];
  const rules = await onboardingRules(ctx);
  if (rules.yesNoDefault) yesNoDefaults(form.fields, answers);
  const fields = form.fields.filter((f) => f.key && (f.type === "text" || f.type === "checkbox")).map((f) => {
    const group = groupOf(f.key); const spec = AGENT_ONBOARDING_FIELDS[f.key];
    return { id: f.key, key: f.key, type: f.type, label: spec?.label ?? f.label, required: spec?.required === true && !(group && rules.optionalGroups.has(group.key)), page: Number(f.page), x: 0, y: 0, w: 0, h: 0, recipient_id: null,
      value: group ? (String(answers[group.key] ?? "").toUpperCase() === group.answer ? "true" : "") : String(answers[answerKey(f.key)] ?? "") };
  });
  const record = prepared.values ?? {};
  return { onboardingId: saved.onboardingId, agency: prepared.agency, contact: prepared.agent, fields, facts,
    acn: saved.presend?.acn ?? acnDigits(String(answers.agent_acn ?? "")), marn: saved.presend?.marn ?? "", message: saved.presend?.message ?? "",
    terms: { commencementDate: saved.terms?.commencementDate ?? "", territory: saved.terms?.territory || String(record.agent_territory ?? ""),
      commissionPercent: saved.terms?.commissionPercent != null ? String(saved.terms.commissionPercent) : String(record.agent_commission_percent ?? ""),
      // Never guessed: empty until SLIT staff choose (2026-11-21).
      commissionGst: isCommissionGst(saved.terms?.commissionGst) ? saved.terms!.commissionGst : "" },
    // The SLIT signatory block (2026-11-21): the sending admin by default; the signature is given (saved / drawn / typed) when sending; the date is the send date.
    signatory: { organisation: saved.organisation || "INDOPACIFIC GLOBAL PTY LTD", name: saved.signatory?.name || prepared.admin?.name || "", position: saved.signatory?.position || prepared.admin?.position || "",
      savedSignature: prepared.admin?.signaturePng ? `data:image/png;base64,${prepared.admin.signaturePng}` : null, signedOn: isoToday() },
    witness: { name: saved.witness?.name ?? "", png: saved.witness?.png ? `data:image/png;base64,${saved.witness.png}` : null }, savedAt: saved.savedAt, savedBy: saved.savedBy };
}

/** Save draft: nothing is emailed. */
export async function presendSave(ctx: OnboardingContext): Promise<Json> {
  await ctx.admin("subject_search", null, { type: "none" });
  const agencyId = agencyIdOf(ctx.body);
  const input = await presendInput(ctx.body, false);
  const before = await ctx.rpc("agency_onboarding_presend_get", { p_agency: agencyId }) as PresendSaved;
  return await savePresend(ctx, agencyId, input, before.contact?.id ?? null);
}

/** Throws an unsent draft away (the business stays; Prepare application starts again). */
export async function presendDiscard(ctx: OnboardingContext): Promise<Json> {
  const onboardingId = String(ctx.body.onboardingId ?? "");
  if (!UUID.test(onboardingId)) throw new SigningError("Choose an onboarding.");
  await ctx.rpc("agency_onboarding_presend_discard", { p_onboarding: onboardingId });
  return { discarded: true };
}

/**
 * Wall-clock time of each step of a heavy action, logged once as JSON (no names, no values). In these CPU-bound steps the wall time is
 * close to the CPU time the platform counts (2 s per request), so the function logs show how much of the budget each step takes.
 */
/**
 * Step timings of one call, logged as {"event":"cpu_steps"}. Wall time: a lap named io_* waits on storage, the database or email; every
 * other lap is synchronous work, so its time is CPU time, and computeMs (their sum) is the call's CPU apart from start-up and JSON.
 */
export function stepTimer(action: string) {
  const start = performance.now(); let last = start; const steps: Record<string, number> = {};
  return {
    lap(name: string) { const now = performance.now(); steps[name] = (steps[name] ?? 0) + Math.round(now - last); last = now; },
    done(extra: Record<string, unknown> = {}) {
      const computeMs = Object.entries(steps).filter(([name]) => !name.startsWith("io_")).reduce((sum, [, ms]) => sum + ms, 0);
      console.log(JSON.stringify({ event: "cpu_steps", action, computeMs, totalMs: Math.round(performance.now() - start), steps, ...extra }));
    },
  };
}

/**
 * The application form and the agreement blanks merged into one PDF, once per pair of template versions (2026-11-20, CPU budget): kept in
 * storage and recorded in agency_onboarding_blank_cache with its hash; every send appends its marks to it. Built here when missing (the
 * Prepare application dialog asks for it when it opens, agent_onboarding_presend_warm, so a send rarely builds it).
 */
export async function mergedBlank(ctx: OnboardingContext, form: OnboardingTemplate, agreement: OnboardingTemplate): Promise<Uint8Array> {
  // ":i4r1" (2026-11-21): the cached blank has the P06 Item 4 GST words removed (redacted), so blanks cached before are not reused.
  const key = `combined:${form.id}:${form.sourceHash.slice(0, 16)}:${agreement.id}:${agreement.sourceHash.slice(0, 16)}:i4r1`;
  const cached = await ctx.rpc("agency_onboarding_blank_cache_get", { p_key: key }) as { path: string; sha256: string } | null;
  if (cached?.path) {
    try { return await ctx.fileBytes(cached.path, cached.sha256); } catch { /* a missing or changed file: built again below */ }
  }
  const timer = stepTimer("onboarding_merge_blanks");
  const [formSource, agreementSource] = await Promise.all([ctx.fileBytes(form.sourcePath, form.sourceHash), ctx.fileBytes(agreement.sourcePath, agreement.sourceHash)]);
  timer.lap("io_download");
  // P06 Item 4 (2026-11-21): "Including/Excluding GST. This applies to eligible onshore and offshore" is removed from the blank's text
  // (true redaction) once, here; every send prints that tail again with the chosen basis (commissionGstWords).
  const { redactLineFrom } = await import("../_shared/pdf-redact.ts");
  const formPages = Number(form.sourcePages) || AGENT_ONBOARDING_DOCS.form.pages;
  let redacted = false;
  const merged = await (await onboardingPdfModule()).mergePdfs([formSource, agreementSource], (doc) => {
    const page = doc.getPages()[formPages + ITEM4_PAGE - 1];
    if (page) redacted = redactLineFrom(doc, page, { baseline: ITEM4_BASELINE, from: ITEM4_REDACT_FROM });
  });
  if (!redacted) console.warn(JSON.stringify({ event: "onboarding_item4_not_redacted", agreement: agreement.id })); // the send still removes it (stamp)
  timer.lap("merge");
  const sha = await sha256Hex(merged);
  const path = `templates/${form.id}/combined-${agreement.id}-${ctx.ports.uuid()}.pdf`;
  await ctx.store(path, merged);
  const saved = await ctx.rpc("agency_onboarding_blank_cache_put", { p_key: key, p_path: path, p_sha256: sha, p_pages: Number(form.sourcePages) + Number(agreement.sourcePages) }) as { path: string; mine: boolean };
  if (saved?.mine === false) { try { await ctx.ports.storage.remove([path]); } catch { /* left for a later clean-up */ } }
  ctx.commit();
  timer.lap("io_store"); timer.done({ bytes: merged.length, built: true });
  return merged;
}

/** Prepare application opened: the merged blank is made ready in its own call, so Send to point of contact only stamps. */
export async function presendWarm(ctx: OnboardingContext): Promise<Json> {
  await ctx.admin("subject_search", null, { type: "none" });
  const form = await installedTemplate(ctx, "form"), agreement = await installedTemplate(ctx, "agreement");
  await mergedBlank(ctx, form, agreement);
  return { ready: true };
}

/**
 * The combined document: the F04 (staff's values printed or prefilled, editable by the contact) followed by the P06 (the agency, ABN and
 * Items 3 to 5 printed; the SLIT witness printed when staff gave one in Prepare application). The agency admin's fields of both, on one
 * request, for one signature; the agency admin always gives their own witness (typed name, drawn on the signing page), except on a
 * correction, where the witness given with the first signature is printed again (agentWitness).
 * The SLIT signatory (2026-11-21): printed when SLIT sends (the sending admin's name, position, signature and the send date); an onboarding
 * sent before that has none and gets it when SLIT approves (issueAgreement). The GST choice is printed with the commission (Item 4).
 */
async function buildCombined(ctx: OnboardingContext, input: { form: OnboardingTemplate; agreement: OnboardingTemplate; values: Record<string, string>; agency: { name: string; abn: string | null };
  terms: { commencementDate: string; territory: string; commissionPercent: string; commissionGst?: string | null }; slitWitness: { name: string; png: string } | null; agentWitness: { name: string; png: string } | null; title: string;
  slitSignatory?: SlitSignatory | null }) {
  // CPU budget (2026-11-20, 546 in production): the two blanks merged once and cached; the marks of this send are appended to that copy.
  const merged = await mergedBlank(ctx, input.form, input.agreement);
  const formResolved = resolveFields(numbered(input.form.fields), input.values, { editablePrefill: true });
  const formPart = { printed: formResolved.printed, recipient: formResolved.recipient };
  const formPages = Number(input.form.sourcePages) || AGENT_ONBOARDING_DOCS.form.pages;
  // The SLIT witness (2026-11-20, owner): the agreement's SLIT witness line, name and drawn signature (admin_witness_signature prints a picture).
  const agreementValues: Record<string, string> = { agent_organisation_name: input.values.agent_legal_entity || input.values.agent_organisation_name || input.agency.name,
    agent_abn: abnWithAcn(String(input.agency.abn ?? input.values.agent_abn ?? ""), input.values.agent_acn), agreement_commencement_date: input.terms.commencementDate, agent_territory: input.terms.territory,
    agent_commission_percent: input.terms.commissionPercent, ...witnessValues(input.slitWitness),
    ...(input.slitSignatory ? { admin_name: input.slitSignatory.name, admin_position: input.slitSignatory.position, admin_signature: input.slitSignatory.signature, admin_signed_date: input.slitSignatory.signedOn } : {}) };
  const placed = numbered(input.agreement.fields);
  const { printed, recipient } = resolveFields(placed, agreementValues);
  const nameBox = placed.find((f) => f.key === WITNESS_NAME_KEY) ?? null, signatureBox = placed.find((f) => f.key === WITNESS_SIGNATURE_KEY) ?? null;
  const print: PlacedField[] = [...printed];
  const gstWords = commissionGstWords(placed, input.terms);
  if (gstWords) print.push(gstWords);
  if (input.agentWitness) {
    if (nameBox) print.push({ ...nameBox, value: input.agentWitness.name });
    if (signatureBox) print.push({ ...signatureBox, type: "signature", value: `data:image/png;base64,${input.agentWitness.png}` });
  }
  // The agent's witness signature is never a field to type into; its name is the agency admin's to give (required unless Business Rules
  // make the agency's witness optional: agents.agency_witness_on_agreement).
  const witnessRequired = (await onboardingRules(ctx)).agencyWitnessRequired;
  const theirs = recipient.filter((f) => f.key !== WITNESS_SIGNATURE_KEY && !(input.agentWitness && f.key === WITNESS_NAME_KEY))
    .map((f) => f.key === WITNESS_NAME_KEY ? { ...f, required: witnessRequired } : f);
  const stamped = [...formPart.printed, ...print.map((f) => ({ ...f, page: f.page + formPages }))];
  const timer = stepTimer("onboarding_build_combined");
  const pdf = await signingPdfModule(); timer.lap("pdf_modules");
  const bytes = stamped.length ? await pdf.stampDocument(merged, { reference: "", title: input.title, recipients: [], incremental: true,
    fields: stamped.map((f) => ({ recipient_id: null, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, value: f.value, done: true, label: f.label, inline: f.inline ?? null })) }) : merged;
  timer.lap("stamp"); timer.done({ fields: stamped.length, bytes: bytes.length });
  const role = signerRole("form").key;
  // The stored field values never keep the SLIT signature picture (as before: the request's own copy of the agreement has it).
  return { bytes, formPages, agreementValues: Object.fromEntries(Object.entries(agreementValues).filter(([key]) => key !== "admin_signature")), printed: formPart.printed.length + print.length,
    fields: [...recipientFields(formPart.recipient, role), ...recipientFields(theirs.map((f) => ({ ...f, page: f.page + formPages })), role)],
    witnessBox: !input.agentWitness && signatureBox ? { page: signatureBox.page + formPages, x: signatureBox.x, y: signatureBox.y, w: signatureBox.w, h: signatureBox.h } : null };
}

/** The rest of the P06 Item 4 line after "Percentage of tuition fee ", as the blank prints it with the GST basis left open. */
export const ITEM4_LINE_TAIL = "GST. This applies to eligible onshore and offshore";
/** Where the GST words are on the P06 blank (v2, A4): agreement page 11, baseline 444.11 pt; removed from "Including/Excluding" on. */
export const ITEM4_PAGE = 11, ITEM4_BASELINE = 444.11, ITEM4_REDACT_FROM = "Including/Excluding";
/**
 * Item 4 with its GST choice on the agreement (2026-11-21, owner): the sentence reads "10% Percentage of tuition fee Including GST." (or
 * Excluding); "Including/Excluding" is never printed on a generated agreement. The words from "Including/Excluding" to the end of that
 * line are covered in white and reprinted with the chosen word in the page's own font (Calibri 9.96 pt, same baseline), so the line
 * closes up with no gap and nothing moves onto the next line or the "COMMISSION ELIGIBILITY" heading. The percentage stays in its blank.
 * P06 v2 blank, page 11 (A4): the blank's underscores 123.9-163.7 pt on baseline 444.11 (the box 126.6-162.5 x 442.25-454.28), "Including" from
 * 270.49 pt, the line ends at 559.3 pt; next line's baseline 431.87, the line above 456.24. Placed from the percentage box, so a shifted
 * page moves it with the box. No GST choice (sent before 2026-11-21): nothing, as before.
 */
export function commissionGstWords(placed: PlacedField[], terms: { commissionPercent: string; commissionGst?: string | null }): PlacedField | null {
  const box = placed.find((f) => f.key === "agent_commission_percent");
  if (!box) return null;
  // No GST choice (an onboarding sent before 2026-11-21, corrected now): the blank's own words, since the blank no longer has them.
  const word = terms.commissionGst === "inclusive" ? "Including" : terms.commissionGst === "exclusive" ? "Excluding" : ITEM4_REDACT_FROM;
  const W = 595.28, H = 841.89, boxTop = 454.28, coverTop = 453.4, coverBottom = 441.2;
  return { ...box, key: "agent_commission_gst", type: "text", role: "sender", required: false, label: "Commission GST basis",
    x: 270.49 / W, w: (561.8 - 270.49) / W, y: box.y + (boxTop - coverTop) / H, h: (coverTop - coverBottom) / H,
    value: `${word} ${ITEM4_LINE_TAIL}`, inline: { font: "Calibri", size: 9.96, baseline: ITEM4_BASELINE - coverBottom, redactFrom: ITEM4_REDACT_FROM } };
}

/** Send to point of contact: the draft is saved, the combined request made and emailed. */
export async function presendSend(ctx: OnboardingContext): Promise<Json> {
  await ctx.admin("subject_search", null, { type: "none" });
  const agencyId = agencyIdOf(ctx.body);
  const input = await presendInput(ctx.body, true);
  const form = await installedTemplate(ctx, "form"); await installedTemplate(ctx, "referee"); const agreement = await installedTemplate(ctx, "agreement");
  const before = await ctx.rpc("agency_onboarding_presend_get", { p_agency: agencyId }) as PresendSaved;
  if (before.openStage) throw new SigningError("This business's application has already been sent. Follow it on the business page.");
  const draft = await savePresend(ctx, agencyId, input, before.contact?.id ?? null);
  const prepared = await prepare(ctx, agencyId, draft.contact.id);
  const { values: base, prefill, facts } = await applicationValues(ctx, prepared);
  // What staff entered wins over our records and the register; the references stay for the agency admin.
  const values: Record<string, string> = { ...base, ...input.answers };
  for (const key of Object.keys(values)) if (REFERENCE_KEY.test(key)) delete values[key];
  const acn = input.acn || acnDigits(values.agent_acn ?? "");
  if (acn) values.agent_acn = acn; else delete values.agent_acn;
  if (input.marn) values.agent_marn = input.marn;
  if ((await onboardingRules(ctx)).yesNoDefault) yesNoDefaults(form.fields, values);
  const title = `Agent application and agreement: ${text(prepared.agency.name, 150)}`.slice(0, 200);
  // The SLIT signatory signs now (2026-11-21): the sending admin, or the name / position staff entered; saved, drawn or typed signature; today's date.
  const sig = await signatoryOf(ctx, prepared, input.signatory);
  const slitSignatory: SlitSignatory = { name: sig.adminName, position: sig.adminPosition, signature: sig.adminSignature, signedOn: isoToday() };
  const made = await buildCombined(ctx, { form, agreement, values, agency: prepared.agency, terms: input, slitWitness: input.witness, agentWitness: null, title, slitSignatory });
  const recipients = checkRecipients([{ name: prepared.agent!.name, email: prepared.agent!.email, role: signerRole("form").key, label: signerRole("form").label, order: 1, required: true }]);
  const id = ctx.ports.uuid();
  await ctx.store(`${id}/original.pdf`, made.bytes);
  const record = await ctx.admin("create", id, { title, template_id: form.id, rendered_text: null, field_values: { ...values, ...made.agreementValues }, original_hash: await sha256Hex(made.bytes), recipients,
    fields: relaxAnswerGroups(made.fields, (await onboardingRules(ctx)).optionalGroups), subject_type: "agent", subject_id: prepared.agent!.id, category: "other", message: input.message || null, edited: false,
    template_text: null, signing_mode: "sequential", expiry_days: form.expiryDays ?? (await onboardingRules(ctx)).expiryDays, reminder_days: form.reminderDays ?? (await onboardingRules(ctx)).reminderDays });
  let onboarding: Json;
  try {
    onboarding = await ctx.rpc("agency_onboarding_presend_send", { p_onboarding: draft.onboardingId, p_request: id,
      p_data: { form_pages: made.formPages, values, message: input.message || null, admin_name: slitSignatory.name, admin_position: slitSignatory.position,
        slit_signature_kind: slitSignatory.signature.startsWith("data:image/png;base64,") ? "drawn" : "typed", slit_signature: slitSignatory.signature, signed_on: slitSignatory.signedOn,
        witness_box: made.witnessBox } });
  } catch (error) {
    try { await ctx.admin("void", id, { reason: "Not sent: the application could not be recorded" }); } catch { /* left as an unsent draft */ }
    throw error;
  }
  ctx.commit();
  if (prefill) { try { await ctx.rpc("agency_onboarding_prefill_record", { p_onboarding: onboarding.id, p_prefill: { ...prefill, ...input.answers } }); } catch { /* history line only */ } }
  if (facts) { try { await ctx.rpc("agency_abr_facts_record", { p_agency: agencyId, p_facts: facts }); } catch { /* the wizard looks them up itself */ } }
  return await sendRequest(ctx, id, { reference: record.reference, onboardingId: onboarding.id, stage: onboarding.stage, combined: true, agent: { name: prepared.agent!.name, email: prepared.agent!.email },
    printed: made.printed, fields: made.fields.length, slitWitness: !!input.witness });
}

/**
 * Approve on a combined onboarding: the agreement the agency admin already signed gets the SLIT signatory (name, position, signature, date)
 * and, when given, SLIT's witness (typed name + drawn signature); it is stored as the issued agreement, emailed to the agency admin, and the
 * held sign-in invitations are released. No second signature from the agency.
 */
async function issueAgreement(ctx: OnboardingContext, onboardingId: string, prepared: Prepared, slitWitnessPrinted = false): Promise<Json> {
  const timer = stepTimer("onboarding_issue_agreement");
  const template = await installedTemplate(ctx, "agreement");
  const file = await ctx.rpc("agency_onboarding_file", { p_id: onboardingId, p_kind: "agreement" }) as { name: string; base64: string };
  const signed = Uint8Array.from(atob(String(file?.base64 ?? "")), (c) => c.charCodeAt(0));
  timer.lap("io_read_agreement");
  // 2026-11-21: an agreement sent with the SLIT signatory already carries it (signed when SLIT sent): it is not stamped again. One sent
  // before has none: the approver signs now, as before.
  const presigned = storedSignatory((await ctx.rpc("agency_onboarding_review_get", { p_onboarding: onboardingId }) as ReviewData).slitSignatory);
  const { adminName, adminPosition, adminSignature } = presigned ? { adminName: presigned.name, adminPosition: presigned.position, adminSignature: "" } : await signatoryOf(ctx, prepared);
  // The SLIT witness given in Prepare application is already on the agreement: it is not asked for (or printed) again.
  const witness = slitWitnessPrinted ? null : await drawnWitness(ctx.body.adminWitness);
  const values: Record<string, string> = { ...(presigned ? {} : { admin_name: adminName, admin_position: adminPosition, admin_signature: adminSignature, admin_signed_date: isoToday() }), ...witnessValues(witness) };
  const mine = resolveFields(numbered(template.fields), values).printed.filter((f) => f.key.startsWith("admin_"));
  const pdf = await signingPdfModule(); timer.lap("pdf_modules");
  // Appended to the signed agreement (incremental update): its bytes, and the agency admin's signature in them, stay as signed.
  // Nothing to add (SLIT signed when sending and the witness is already on it): the signed agreement is issued exactly as signed.
  const bytes = mine.length ? await pdf.stampDocument(signed, { reference: "", title: `Agent agreement: ${text(prepared.agency.name, 150)}`, recipients: [], incremental: true,
    fields: mine.map((f) => ({ recipient_id: null, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, value: f.value, done: true, label: f.label })) }) : signed;
  timer.lap("stamp");
  const base64 = toBase64(bytes); timer.lap("base64");
  const issued = await ctx.rpc("agency_onboarding_agreement_issue", { p_onboarding: onboardingId, p_base64: base64,
    p_data: { admin_name: adminName, admin_position: adminPosition, admin_witness_name: witness?.name ?? null } }) as
    { stage: string; already?: boolean; name: string; commencementDate?: string; expiryDate?: string; contact: { name: string; email: string } };
  let emailed = false;
  const { provider, config } = ctx.ports.mail;
  if (!issued.already && provider && config.from && issued.contact?.email) {
    const words = (iso?: string) => iso ? iso.slice(0, 10).split("-").reverse().join("/") : "";
    const outcome = outcomeState(await provider.send({ deliveryId: `onboarding-agreement-issued-${onboardingId}`, from: config.from, to: issued.contact.email,
      subject: `Your agent agreement with Skyline Institute of Technology: ${text(issued.name, 100)}`,
      textBody: `Hello ${text(issued.contact.name, 80) || "there"},\n\nSkyline Institute of Technology has approved the application of ${text(issued.name, 120)} and countersigned the Education Agent Agreement you signed with it. `
        + `The completed agreement is attached.${issued.commencementDate ? ` It runs from ${words(issued.commencementDate)} to ${words(issued.expiryDate)}.` : ""}\n\nYou will receive a separate email to set your password for the agent portal.` + SIGN_OFF,
      attachments: [{ name: `${text(issued.name, 80).replace(/[^\w .()-]/g, "_")} - Agent Agreement.pdf`, contentType: "application/pdf", contentBase64: base64 }] }));
    emailed = outcome.state === "sent";
  }
  timer.lap("io_store_and_email");
  const released = await releaseAfterAgreement(ctx, onboardingId);
  timer.lap("io_release"); timer.done({ bytes: bytes.length });
  return { issued: true, stage: issued.stage, to: issued.contact?.email ?? null, emailed, released: released.released, invitations: released.emailed };
}

/** A combined application is signed: staff are told it is ready for review at once (the referees no longer hold it up). */
export async function notifyApplicationSigned(ctx: Pick<OnboardingContext, "ports">, onboardingId: string): Promise<{ notified: boolean }> {
  const { ports } = ctx;
  const follow = await serviceRpc(ports, "agency_onboarding_followup", { p_onboarding: onboardingId }) as Followup;
  if (!follow.combined || !["application_signed", "references_pending", "references_received"].includes(follow.stage)) return { notified: false };
  const { provider, config } = ports.mail;
  const rules = await onboardingRules(ctx);
  const to = staffRecipients(follow, config.adminTo, rules.reviewRecipients);
  if (!provider || !config.from || !to.length) return { notified: false };
  const outcome = outcomeState(await provider.send({ deliveryId: `onboarding-signed-${onboardingId}`, from: config.from, to: to.join(", "), subject: `Ready for review: ${text(follow.agency.name, 120)}`,
    textBody: `${text(follow.agent.name, 80)} has signed the Agent Application Form and the Education Agent Agreement for ${text(follow.agency.name, 120)} (one signature on both).\n\n`
      + (rules.waitForReferees ? "Both referees have been sent a referee check. You can approve the application, or send it back, once both have replied: the review shows each referee's status.\n\n"
        : "Both referees have been sent a referee check. You do not need to wait for them: the review shows each referee's status.\n\n")
      + `Open the business in the CMS (Businesses > ${text(follow.agency.name, 120)}) and choose Review application: approve it (the agreement is countersigned and issued), or send it back for correction.` + SIGN_OFF }));
  return { notified: outcome.state === "sent" };
}

/**
 * Activate (2026-11-19): the signed business agreement (or an uploaded signed copy) makes the business Ready to activate; an administrator
 * presses Activate. The database makes the business, its POC and every agent added meanwhile Active and returns the invitations; each gets
 * ONE set-password email here (an invitation already emailed is not emailed again).
 */
interface BusinessActivation {
  businessId: string; name: string; status: string; onboardingId: string | null; contact: { id: string; name: string; email: string }; heldReleased: number;
  invitations: Array<{ id: string; email: string; name: string; role: string; expiresAt: string | null; sent: boolean; contact: boolean; agentId: string }>;
  skipped: Array<{ email: string; reason: string }>;
}
export async function activateBusinessByAdmin(ctx: OnboardingContext): Promise<Json> {
  const businessId = String(ctx.body.businessId ?? "");
  if (!UUID.test(businessId)) throw new SigningError("Choose a business.");
  const result = await ctx.rpc("agency_business_activate", { p_business: businessId }) as BusinessActivation;
  const emailed: string[] = [], failed: string[] = [];
  for (const inv of result.invitations ?? []) {
    if (inv.sent) continue;
    const ok = await sendSetPasswordEmail(ctx.ports, { invitationId: inv.id, email: inv.email, name: inv.name, role: inv.role, agencyName: result.name, expiresAt: inv.expiresAt, kind: inv.contact ? "business" : "member" });
    (ok ? emailed : failed).push(inv.email);
  }
  return { ...result, emailed, failed };
}

/** The business agreement is signed: staff are told the business is ready to activate (once); nothing goes to the business until then. */
export async function notifyBusinessReady(ctx: Pick<OnboardingContext, "ports">, onboardingId: string): Promise<{ notified: boolean }> {
  const { ports } = ctx;
  const follow = await serviceRpc(ports, "agency_onboarding_followup", { p_onboarding: onboardingId }) as Followup;
  if (follow.kind === "agent" || follow.stage !== "agreement_signed") return { notified: false };
  const { provider, config } = ports.mail;
  const to = [...new Set([follow.sentBy?.email, ...(follow.contacts ?? []), ...(follow.sentBy?.email ? [] : config.adminTo)].filter((e): e is string => !!e && /@/.test(e)).map((e) => e.toLowerCase()))];
  if (!provider || !config.from || !to.length) return { notified: false };
  const outcome = outcomeState(await provider.send({ deliveryId: `onboarding-ready-${onboardingId}`, from: config.from, to: to.join(", "),
    subject: `Ready to activate: ${text(follow.agency.name, 120)}`,
    textBody: `${text(follow.agent.name, 80)} has signed the Agent Agreement for ${text(follow.agency.name, 120)}.\n\n`
      + `Open the business in the CMS (Businesses > ${text(follow.agency.name, 120)}) and press Activate. The business goes active, ${text(follow.agent.email, 254)} gets the set-password email, `
      + "and every agent added to the business meanwhile gets their sign-in invitation. Nothing is sent to them until you do." + SIGN_OFF }));
  return { notified: outcome.state === "sent" };
}

/** Agent-level onboarding was retired (2026-11-19): every per-agent action is refused; the business onboarding covers its agents. */
const AGENT_LEVEL_RETIRED = "Agents have no onboarding of their own: the business onboarding covers them. Add the agent; their sign-in invitation goes out when the business is active.";
const retired = (): Promise<Json> => Promise.reject(new SigningError(AGENT_LEVEL_RETIRED, 410));

interface Followup {
  id: string; kind?: "business" | "agent"; combined?: boolean; stage: string; agency: { id: string; name: string; status?: string }; agent: { id: string; name: string; email: string }; sentBy: { email: string | null; name: string | null }; contacts: string[];
  /** 2026-11-18: the business status in words, the correction rounds so far, the active CMS administrators (told at Ready for review). */
  label?: string | null; round?: number; admins?: string[];
  values: Record<string, string>; referees: Array<{ id: string; position: number; name: string; organisation: string; positionTitle: string; email: string; phone: string; address: string; status: string; requestId: string | null }>;
  received: number; total: number; template: OnboardingTemplate | null; notified: { agentReferees: boolean; staffReferences: boolean };
}
const SIGN_OFF = "\n\nSkyline Institute of Technology\nThis is an automated message.";

/**
 * Stage 2: an Agent Referee Check Form (F05) to every referee still to be contacted, prefilled from the signed application form. Runs
 * when the agent has signed (no administrator session: the service role makes the requests, as the offer letter's are made) and from
 * the business page (Send referee checks, a changed email). The agent is told once that their referees were contacted.
 */
export async function sendRefereeChecks(ctx: Pick<OnboardingContext, "ports" | "store" | "fileBytes" | "commit">, onboardingId: string): Promise<{ sent: number; skipped: number }> {
  const { ports } = ctx;
  const follow = await serviceRpc(ports, "agency_onboarding_followup", { p_onboarding: onboardingId }) as Followup;
  if (!["application_signed", "references_pending", "references_received", "resubmitted", "references_approved", "agreement_sent", "agreement_signed"].includes(follow.stage)) return { sent: 0, skipped: follow.referees?.length ?? 0 };
  const pending = (follow.referees ?? []).filter((r) => r.status === "pending" && !r.requestId);
  if (!pending.length) return { sent: 0, skipped: 0 };
  if (!follow.template || follow.template.status !== "active") throw new SigningError(ONBOARDING_TEMPLATES_MISSING);
  const template = follow.template;
  const pdf = await signingPdfModule();
  let sent = 0;
  for (const referee of pending) {
    const values: Record<string, string> = { agent_agency_name: follow.values?.agent_agency_name ?? follow.agency.name, agent_office_address: follow.values?.agent_office_address ?? "",
      referee_organisation: referee.organisation, referee_address: referee.address, referee_contact_person_1: [referee.name, referee.positionTitle].filter((v) => v && v.trim()).join(", "),
      referee_phone: referee.phone, referee_email: referee.email };
    const source = await ctx.fileBytes(template.sourcePath, template.sourceHash);
    const { printed, recipient } = resolveFields(numbered(template.fields), values);
    const title = `Agent referee check: ${text(follow.agency.name, 120)} (reference ${referee.position})`.slice(0, 200);
    const bytes = printed.length ? await pdf.stampDocument(source, { reference: "", title, recipients: [],
      fields: printed.map((f) => ({ recipient_id: null, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, value: f.value, done: true, label: f.label })) }) : source;
    const id = ports.uuid();
    await ctx.store(`${id}/original.pdf`, bytes);
    const message = `${text(follow.agent.name, 80)} of ${text(follow.agency.name, 120)} has applied to become an education agent for Skyline Institute of Technology and named you as a referee. `
      + "Please review the details, complete the form and sign it online. If you would rather, you can also email the completed form to the address printed on it.";
    await serviceRpc(ports, "agency_onboarding_referee_request_create", { p_referee: referee.id, p_data: { id, title, original_hash: await sha256Hex(bytes), template_id: template.id,
      fields: recipientFields(recipient, signerRole("referee").key), message, expiry_days: template.expiryDays ?? (await onboardingRules(ctx)).expiryDays, reminder_days: template.reminderDays ?? (await onboardingRules(ctx)).reminderDays,
      values: Object.fromEntries(Object.entries(values).filter(([key]) => key !== "referee_email")) } });
    ctx.commit();
    sent++;
  }
  await drainSigningMail(ports);
  // The agent: their referees have been contacted (once).
  const { provider, config } = ports.mail;
  if (sent && provider && config.from && !follow.notified.agentReferees && follow.agent.email) {
    const names = (follow.referees ?? []).map((r) => `${r.name || r.email}${r.organisation ? ` (${r.organisation})` : ""}`).join(" and ");
    const outcome = outcomeState(await provider.send({ deliveryId: `onboarding-referees-${onboardingId}`, from: config.from, to: follow.agent.email, subject: "Your referees have been contacted",
      textBody: `Hello ${text(follow.agent.name, 80) || "there"},\n\nThank you for signing the Agent Application Form for ${text(follow.agency.name, 120)}. We have emailed a referee check form to ${names}. `
        + (follow.kind === "agent" ? "Once both referees have completed it, our team will review your application and let you know by email."
          : follow.combined ? "You do not need to wait for them: our team is now reviewing your application and the agreement you signed. Once it is approved you will receive the countersigned agreement and your sign-in email."
          : "Once both referees have completed it, our team will send you the Agent Agreement. You can see where things are up to on your agency dashboard.") + SIGN_OFF }));
    if (outcome.state === "sent") await serviceRpc(ports, "agency_onboarding_mark_notified", { p_onboarding: onboardingId, p_kind: "agent_notified_referees", p_detail: { to: follow.agent.email, referees: sent } }).catch(() => undefined);
  }
  return { sent, skipped: 0 };
}

/** Both referees are back: the staff member who started the onboarding and the admissions contact are told (once). */
export async function notifyReferencesReceived(ctx: Pick<OnboardingContext, "ports">, onboardingId: string): Promise<{ notified: boolean }> {
  const { ports } = ctx;
  const follow = await serviceRpc(ports, "agency_onboarding_followup", { p_onboarding: onboardingId }) as Followup;
  // Ready for review (both referees back), or a resubmitted application whose re-sent referee check is back (once per correction round).
  const again = follow.stage === "resubmitted" && follow.total > 0 && follow.received >= follow.total;
  if (!again && (follow.stage !== "references_received" || follow.notified.staffReferences)) return { notified: false };
  const { provider, config } = ports.mail;
  const to = staffRecipients(follow, config.adminTo, (await onboardingRules(ctx)).reviewRecipients);
  if (!provider || !config.from || !to.length) return { notified: false };
  const lines = (follow.referees ?? []).map((r) => `- ${r.name || r.email}${r.organisation ? `, ${r.organisation}` : ""}: ${r.status === "received" ? "received" : r.status}`).join("\n");
  const agent = follow.kind === "agent";
  const outcome = outcomeState(await provider.send({ deliveryId: `onboarding-references-${onboardingId}${again ? `-r${follow.round ?? 0}` : ""}`, from: config.from, to: to.join(", "),
    subject: agent ? `Agent references received: ${text(follow.agent.name, 80)} (${text(follow.agency.name, 100)})` : follow.combined ? `Both referees replied: ${text(follow.agency.name, 120)}` : `Ready for review: ${text(follow.agency.name, 120)}`,
    textBody: `Both referee checks for ${text(follow.agent.name, 80)} (${text(follow.agency.name, 120)}) are in.\n\n${lines}\n\n`
      + (agent ? `Open the business in the CMS (Businesses > ${text(follow.agency.name, 120)} > Agents) to read them, then send the agent their individual agent agreement or reject them. The agent can be activated once the agreement is signed.`
        : `The application is ready for review. Open the business in the CMS (Businesses > ${text(follow.agency.name, 120)}) and choose Review application: approve it, or send it back for correction.`) + SIGN_OFF }));
  if (outcome.state !== "sent") return { notified: false };
  if (again) return { notified: true };
  await serviceRpc(ports, "agency_onboarding_mark_notified", { p_onboarding: onboardingId, p_kind: "staff_notified_references", p_detail: { to } }).catch(() => undefined);
  return { notified: true };
}

/** After a link holder's signature completed a request of an onboarding: the referee checks after the form, the staff email after the second referee, the "ready to activate" email after the agreement. */
export async function afterCompletion(ctx: Pick<OnboardingContext, "ports" | "store" | "fileBytes" | "commit">, plan: { id: string; kind?: string }): Promise<void> {
  if (plan.kind === "application") { await sendRefereeChecks(ctx, plan.id); await notifyApplicationSigned(ctx, plan.id); await notifyResubmitted(ctx, plan.id); }
  else if (plan.kind === "referee") await notifyReferencesReceived(ctx, plan.id);
  // 2026-11-18: an approved business (already Active) releases its held sign-in invitations when the agreement is signed. A business on the
  // earlier flow (still Onboarding) is ready to activate: staff are told; an administrator activates it.
  else if (plan.kind === "agreement") { const released = await releaseAfterAgreement(ctx, plan.id); if (!released.released) await notifyBusinessReady(ctx, plan.id); }
}

const base64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * A new one-time link for an invitation, mailed through the signing mail provider; the database keeps only the token's hash. The link is
 * our own page (/agency/accept-invite#t=…): the token is checked only when the person presses the button there, so a mail scanner that
 * opens the link does not use it up. A later resend issues a new token and the old link stops working.
 * kind "business": the POC at activation; "member": an agent added to the business (their invitation was held until activation).
 */
export async function sendSetPasswordEmail(ports: SigningPorts, inv: { invitationId: string; email: string; name: string; role: string; agencyName: string; expiresAt: string | null; kind?: "business" | "member" }): Promise<boolean> {
  const { provider, config } = ports.mail;
  if (!provider || !config.from || !config.siteUrl) return false;
  const token = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await sha256Hex(new TextEncoder().encode(token));
  await serviceRpc(ports, "portal_invitation_link_issue", { p_invitation: inv.invitationId, p_token_hash: hash });
  const link = `${config.siteUrl.replace(/\/+$/, "")}/agency/accept-invite#t=${token}`;
  const role = inv.role === "agency_admin" ? "the business admin agent" : "an agent";
  const until = inv.expiresAt && isoToday() <= inv.expiresAt.slice(0, 10) ? ` This link works until ${inv.expiresAt.slice(0, 10).split("-").reverse().join("/")}.` : "";
  const member = inv.kind === "member";
  const outcome = outcomeState(await provider.send({ deliveryId: `onboarding-activation-${inv.invitationId}-${hash.slice(0, 8)}`, from: config.from, to: inv.email,
    subject: member ? `Your Skyline agent portal sign-in for ${text(inv.agencyName, 100)}` : "Set your password for the Skyline agent portal",
    textBody: `Hello ${text(inv.name, 80) || "there"},\n\n`
      + (member ? `You have been added as ${role} of ${text(inv.agencyName, 120)} in the Skyline Institute of Technology agent portal.\n\n`
        : `Your agent agreement with Skyline Institute of Technology is signed and ${text(inv.agencyName, 120)} is now active. You are ${role} for it.\n\n`)
      + `Set your password to open the agent portal:\n${link}\n\nOpen the link and press the button on the page to continue.${until} If the link has expired, the page lets you ask for a new one.` + SIGN_OFF }));
  return outcome.state === "sent";
}

/** Business page: the references are rejected; the onboarding is declined (reason for staff only), its open requests voided, the agent told politely. */
export async function rejectOnboarding(ctx: OnboardingContext): Promise<Json> {
  await ctx.admin("subject_search", null, { type: "none" });
  const onboardingId = String(ctx.body.onboardingId ?? "");
  if (!UUID.test(onboardingId)) throw new SigningError("Choose an onboarding.");
  const declined = await ctx.rpc("agency_onboarding_decline", { p_onboarding: onboardingId, p_reason: text(ctx.body.reason, 1000) }) as
    { id: string; stage: string; kind?: "business" | "agent"; openRequestIds: string[]; agent: { id: string; name: string; email: string }; agency: { id: string; name: string } };
  for (const id of declined.openRequestIds ?? []) { try { await ctx.admin("void", id, { reason: "Onboarding declined" }); } catch { /* already closed */ } }
  const { provider, config } = ctx.ports.mail;
  let emailed = false;
  if (provider && config.from && declined.agent?.email) {
    const outcome = outcomeState(await provider.send({ deliveryId: `onboarding-declined-${onboardingId}`, from: config.from, to: declined.agent.email, subject: "Your agent application with Skyline Institute of Technology",
      textBody: declined.kind === "agent"
        ? `Hello ${text(declined.agent.name, 80) || "there"},\n\nThank you for your interest in becoming an agent for Skyline Institute of Technology with ${text(declined.agency.name, 120)}, and for the time you put into your application. `
          + "After reviewing it, we are unable to proceed at this time.\n\nWe appreciate your interest and wish you every success." + SIGN_OFF
        : `Hello ${text(declined.agent.name, 80) || "there"},\n\nThank you for your interest in representing Skyline Institute of Technology and for the time you put into the application for ${text(declined.agency.name, 120)}. `
        + "After reviewing it, we are unable to proceed with an agent agreement at this time.\n\nWe appreciate your interest and wish you every success. If you have any questions, please reply to this email." + SIGN_OFF }));
    emailed = outcome.state === "sent";
  }
  return { ...declined, emailed };
}

/** Business page: send the referee checks still outstanding (after a failed automatic send, or a changed email address). */
export async function sendRefereesNow(ctx: OnboardingContext): Promise<Json> {
  await ctx.admin("subject_search", null, { type: "none" });
  const onboardingId = String(ctx.body.onboardingId ?? "");
  if (!UUID.test(onboardingId)) throw new SigningError("Choose an onboarding.");
  return await sendRefereeChecks(ctx, onboardingId);
}

/** Business page: a referee's email address (and name) changes; the old request is voided and a new referee check goes out. */
export async function changeReferee(ctx: OnboardingContext): Promise<Json> {
  const refereeId = String(ctx.body.refereeId ?? "");
  if (!UUID.test(refereeId)) throw new SigningError("Choose a referee.");
  const changed = await ctx.rpc("agency_onboarding_referee_change_email", { p_referee: refereeId, p_email: text(ctx.body.email, 254), p_name: text(ctx.body.name, 150) || null }) as { onboardingId: string; previousRequestId: string | null; email: string };
  if (changed.previousRequestId) { try { await ctx.admin("void", changed.previousRequestId, { reason: "Referee email address changed" }); } catch { /* already closed */ } }
  const result = await sendRefereeChecks(ctx, changed.onboardingId);
  return { ...changed, ...result };
}

/** Business page: a signed referee check received by email, uploaded by staff; it counts as received and the open request is voided. */
export async function uploadRefereeForm(ctx: OnboardingContext): Promise<Json> {
  const refereeId = String(ctx.body.refereeId ?? "");
  if (!UUID.test(refereeId)) throw new SigningError("Choose a referee.");
  if (!ctx.upload) throw new SigningError("Choose the signed referee check (PDF).");
  const inspected = await (await import("../_shared/offer-pdf.ts")).inspectOfferPdf(ctx.upload.bytes);
  if (!inspected.ok) throw new SigningError(inspected.error.replaceAll("offer letter", "referee check"));
  const stored = await ctx.rpc("agency_onboarding_referee_upload", { p_referee: refereeId, p_file_name: text(ctx.upload.name, 200) || "referee-check.pdf", p_base64: toBase64(ctx.upload.bytes) }) as { onboardingId: string; previousRequestId: string | null; stage: string };
  if (stored.previousRequestId) { try { await ctx.admin("void", stored.previousRequestId, { reason: "Signed referee check received by email" }); } catch { /* already closed */ } }
  const notified = await notifyReferencesReceived(ctx, stored.onboardingId);
  return { ...stored, ...notified };
}

/*
 * Staff review and the correction loop (owner brief 2026-11-18). The application is reviewed in the F04 wizard (admin-review mode):
 *   Save changes       -> every changed field audited (who, old, new) and a new PDF revision "edited by SLIT staff" (no re-signing)
 *   Send back          -> a new F04 request to the business's agency admin, prefilled; only the flagged fields can change (core.ts)
 *   Approve & activate -> the business goes Active and the P06 goes to the agency admin; the sign-in invitations follow its signature
 */
const reviewChanges = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SigningError("Nothing to save.");
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => /^[a-z][a-z0-9_]{0,60}$/.test(key)).map(([key, v]) => [key, text(v, 500)]));
};
/** The F04 field values from the onboarding's answers (text by key, a tick box "true" when it is the answer, the registration box from ACN + MARN). */
export function valuesFromAnswers(fields: Array<{ key?: string | null; type: string; value?: string | null }>, answers: Record<string, string>): string[] {
  return fields.map((f) => {
    if (!f.key || (f.type !== "text" && f.type !== "checkbox")) return String(f.value ?? "");
    const group = groupOf(f.key);
    if (group) return String(answers[group.key] ?? "").toUpperCase() === group.answer ? "true" : "false";
    if (answerKey(f.key) === "agent_registration_number") return composeRegistrationNumber(answers.agent_acn, answers.agent_marn);
    return String(answers[answerKey(f.key)] ?? "");
  });
}
interface RevisionSource {
  requestId: string; reference: string; title: string; originalPath: string; originalHash: string; nextRevision: number; answers: Record<string, string>;
  fields: Array<{ recipient_id: string | null; type: string; page: number; x: number; y: number; w: number; h: number; key: string | null; label: string | null; value: string | null }>;
  recipients: Array<{ id: string; name: string; email: string; role: string; state: string; signer_name: string | null; signed_at: string | null; signature_kind: string | null; signature_image: string | null }>;
}
async function makeRevision(ctx: OnboardingContext, onboardingId: string, changes: unknown[]): Promise<Json> {
  const src = await ctx.rpc("agency_onboarding_revision_source", { p_onboarding: onboardingId }) as RevisionSource;
  const original = await ctx.fileBytes(src.originalPath, src.originalHash);
  const values = valuesFromAnswers(src.fields, src.answers ?? {});
  const fields = src.fields.map((f, i) => ({ recipient_id: f.recipient_id, type: f.type, page: Number(f.page), x: Number(f.x), y: Number(f.y), w: Number(f.w), h: Number(f.h), label: f.label, value: values[i], done: true }));
  const stamped = await (await signingPdfModule()).stampDocument(original, { reference: src.reference, title: src.title, fields, recipients: src.recipients });
  const note = `Revision ${src.nextRevision}: edited by SLIT staff on ${isoToday().split("-").reverse().join("/")} - not signed again by the applicant (${src.reference})`;
  const bytes = await (await onboardingPdfModule()).markRevision(stamped, note);
  return await ctx.rpc("agency_onboarding_revision_add", { p_onboarding: onboardingId, p_base64: toBase64(bytes), p_note: note, p_changes: changes });
}
export async function reviewSave(ctx: OnboardingContext): Promise<Json> {
  const onboardingId = String(ctx.body.onboardingId ?? "");
  if (!UUID.test(onboardingId)) throw new SigningError("Choose an onboarding.");
  const saved = await ctx.rpc("agency_onboarding_review_save", { p_onboarding: onboardingId, p_changes: reviewChanges(ctx.body.changes) }) as { changed: number; changes: unknown[] };
  if (!saved.changed) return saved;
  try { return { ...saved, revision: await makeRevision(ctx, onboardingId, saved.changes) }; }
  catch (error) { return { ...saved, revision: null, warning: `The changes are saved, but the edited PDF could not be made: ${(error as Error).message}` }; }
}

interface ReviewData {
  onboardingId: string; stage: string; agency: { id: string; name: string; abn?: string | null }; contact: { id: string; name: string; email: string; role: string }; answers: Record<string, string>;
  combined?: boolean; terms?: { commencementDate: string | null; territory: string | null; commissionPercent: number | string | null; commissionGst?: string | null } | null; witness?: { name: string; by: string; png?: string | null } | null; slitWitness?: { name: string; png: string | null } | null;
  /** 2026-11-21: the SLIT signatory signed when the application was sent (null for one sent before). */
  slitSignatory?: { name: string | null; position: string | null; kind: string | null; image: string | null; typed: string | null; signedOn: string | null } | null;
}
/** The stored SLIT signatory, printed again as it was signed (a correction, Approve). */
function storedSignatory(s: ReviewData["slitSignatory"]): SlitSignatory | null {
  const signature = s?.kind === "drawn" ? s.image : s?.kind === "typed" ? s.typed : null;
  return s && signature && s.name && s.position && s.signedOn ? { name: s.name, position: s.position, signature, signedOn: String(s.signedOn).slice(0, 10) } : null;
}
export async function correctionSend(ctx: OnboardingContext): Promise<Json> {
  const onboardingId = String(ctx.body.onboardingId ?? "");
  if (!UUID.test(onboardingId)) throw new SigningError("Choose an onboarding.");
  const flags = ctx.body.flags && typeof ctx.body.flags === "object" && !Array.isArray(ctx.body.flags) ? Object.fromEntries(Object.entries(ctx.body.flags as Record<string, unknown>)
    .filter(([key]) => /^[a-z][a-z0-9_]{0,60}$/.test(key)).map(([key, note]) => [key, text(note, 500)])) : {};
  if (!Object.keys(flags).length) throw new SigningError("Flag at least one field for correction.");
  const message = text(ctx.body.message, 2000);
  const review = await ctx.rpc("agency_onboarding_review_get", { p_onboarding: onboardingId }) as ReviewData;
  if (review.contact?.role !== "agency_admin" || !review.contact.email) throw new SigningError("The correction goes only to the business's agency admin (point of contact).");
  const template = await installedTemplate(ctx, "form");
  const answers = review.answers ?? {};
  const values: Record<string, string> = { ...answers, agent_registration_number: composeRegistrationNumber(answers.agent_acn, answers.agent_marn) };
  const title = `Agent application ${review.combined ? "and agreement " : "form "}(correction): ${text(review.agency.name, 140)}`.slice(0, 200);
  // A combined application goes back with its agreement: the corrected answers and the agreement are signed again with one signature.
  // The witnesses already given (SLIT's before sending, the agency's with the first signature) are printed and stay as they are.
  const made = review.combined && review.terms
    ? await (async () => {
      const combined = await buildCombined(ctx, { form: template, agreement: await installedTemplate(ctx, "agreement"), values, agency: { name: review.agency.name, abn: review.agency.abn ?? null },
        terms: { commencementDate: String(review.terms!.commencementDate ?? ""), territory: String(review.terms!.territory ?? ""), commissionPercent: String(review.terms!.commissionPercent ?? ""),
          commissionGst: review.terms!.commissionGst ?? null },
        slitWitness: review.slitWitness?.png && review.slitWitness.name ? { name: review.slitWitness.name, png: review.slitWitness.png } : null,
        agentWitness: review.witness?.png && review.witness.name ? { name: review.witness.name, png: review.witness.png } : null, title, slitSignatory: storedSignatory(review.slitSignatory) });
      return { bytes: combined.bytes, fields: combined.fields };
    })()
    : await (async () => { const single = await buildDocument(ctx, template, values, title, { editablePrefill: true }); return { bytes: single.bytes, fields: recipientFields(single.recipient, signerRole("form").key) }; })();
  const recipients = checkRecipients([{ name: review.contact.name, email: review.contact.email, role: signerRole("form").key, label: signerRole("form").label, order: 1, required: true }]);
  const id = ctx.ports.uuid();
  await ctx.store(`${id}/original.pdf`, made.bytes);
  const intro = "SLIT has reviewed your agent application and asks you to correct the highlighted answers, then sign again.";
  const record = await ctx.admin("create", id, { title, template_id: template.id, rendered_text: null, field_values: values, original_hash: await sha256Hex(made.bytes), recipients,
    fields: relaxAnswerGroups(made.fields, (await onboardingRules(ctx)).optionalGroups), subject_type: "agent", subject_id: review.contact.id, category: "other", message: [intro, message].filter(Boolean).join("\n\n").slice(0, 2000), edited: false,
    template_text: null, signing_mode: "sequential", expiry_days: template.expiryDays ?? (await onboardingRules(ctx)).expiryDays, reminder_days: template.reminderDays ?? (await onboardingRules(ctx)).reminderDays });
  let correction: Json;
  try { correction = await ctx.rpc("agency_onboarding_correction_request", { p_onboarding: onboardingId, p_request: id, p_data: { flags, message } }); }
  catch (error) {
    try { await ctx.admin("void", id, { reason: "Not sent: the correction could not be recorded" }); } catch { /* left as an unsent draft */ }
    throw error;
  }
  ctx.commit();
  return await sendRequest(ctx, id, { reference: record.reference, round: correction.round, stage: correction.stage, to: review.contact.email, flagged: Object.keys(flags).length });
}

/** Approve and activate agency: the business goes Active; the P06 goes to the agency admin with the SLIT signatory filled in (as Send agreement). */
export async function approveAndActivate(ctx: OnboardingContext): Promise<Json> {
  const onboardingId = String(ctx.body.onboardingId ?? "");
  if (!UUID.test(onboardingId)) throw new SigningError("Choose an onboarding.");
  // A witness named without a drawn signature is refused before anything is approved; so is a missing SLIT witness when Business Rules
  // require one (agents.slit_witness_on_agreement) and none was given before sending.
  const approveWitness = await drawnWitness(ctx.body.adminWitness, ctx.body.adminWitnessName);
  if (!approveWitness && (await onboardingRules(ctx)).slitWitnessRequired
    && await ctx.rpc("agency_onboarding_slit_witness_needed", { p_onboarding: onboardingId }).catch(() => false) === true) throw new SigningError(SLIT_WITNESS_REQUIRED);
  // The signed documents not split yet (the follow-up call failed or is still running): it is asked for again, nothing is approved yet.
  if (ctx.ports.serviceRpc) {
    const split = await ctx.ports.serviceRpc("agency_onboarding_split_source", { p_onboarding: onboardingId }).catch(() => null) as { pending?: boolean; state?: string } | null;
    if (split?.pending && split.state === "signed") {
      await ctx.ports.serviceRpc("agency_onboarding_followup_queue", { p_onboarding: onboardingId, p_step: "split" }).catch(() => undefined);
      throw new SigningError("The signed application and agreement are still being prepared. Try Approve again in a minute.", 409);
    }
  }
  const approved = await ctx.rpc("agency_onboarding_approve", { p_onboarding: onboardingId }) as { stage: string; agencyStatus: string; combined?: boolean; refereesPending?: number; slitWitness?: boolean };
  // 2026-11-20: the agreement was signed with the application; it is countersigned and issued now (no P06 to sign again).
  if (approved.combined) {
    try {
      const prepared = await prepare(ctx, String(ctx.body.agencyId ?? ""), ctx.body.agentId);
      return { approved: true, combined: true, agencyStatus: approved.agencyStatus, refereesPending: approved.refereesPending ?? 0, agreement: null, issued: await issueAgreement(ctx, onboardingId, prepared, approved.slitWitness === true) };
    } catch (error) {
      return { approved: true, combined: true, agencyStatus: approved.agencyStatus, agreement: null, issued: null,
        warning: `The application is approved, but the agreement could not be issued: ${(error as Error).message} Choose Approve again on the business page to issue it.` };
    }
  }
  try { return { approved: true, agencyStatus: approved.agencyStatus, agreement: await sendAgreement(ctx) }; }
  catch (error) { return { approved: true, agencyStatus: approved.agencyStatus, agreement: null, warning: `The business is approved and active, but the agent agreement could not be sent: ${(error as Error).message} Send it from the business page.` }; }
}

/** The agent agreement of an approved business is signed: the held sign-in invitations go out (POC and agents added meanwhile). */
export async function releaseAfterAgreement(ctx: Pick<OnboardingContext, "ports">, onboardingId: string): Promise<{ released: boolean; emailed: string[] }> {
  const { ports } = ctx;
  const result = await serviceRpc(ports, "agency_business_release", { p_onboarding: onboardingId }) as { released: boolean; already?: boolean; name: string; contact?: { name: string; email: string };
    heldReleased?: number; invitations: Array<{ id: string; email: string; name: string; role: string; expiresAt: string | null; sent: boolean; contact: boolean }> };
  if (!result.released) return { released: false, emailed: [] };
  const emailed: string[] = [];
  for (const inv of result.invitations ?? []) {
    if (inv.sent) continue;
    if (await sendSetPasswordEmail(ports, { invitationId: inv.id, email: inv.email, name: inv.name, role: inv.role, agencyName: result.name, expiresAt: inv.expiresAt, kind: inv.contact ? "business" : "member" })) emailed.push(inv.email);
  }
  const follow = await serviceRpc(ports, "agency_onboarding_followup", { p_onboarding: onboardingId }) as Followup;
  const { provider, config } = ports.mail;
  const to = staffRecipients(follow, config.adminTo, (await onboardingRules(ctx)).reviewRecipients);
  if (provider && config.from && to.length) {
    await provider.send({ deliveryId: `onboarding-released-${onboardingId}`, from: config.from, to: to.join(", "), subject: `Agreement signed: ${text(result.name, 120)} can sign in`,
      textBody: `${text(follow.agent.name, 80)} has signed the Agent Agreement for ${text(result.name, 120)}.\n\nThe sign-in emails went out: ${emailed.length ? emailed.join(", ") : "none needed"}.` + SIGN_OFF }).catch(() => undefined);
  }
  return { released: true, emailed };
}

/**
 * Staff to tell, as Business Rules choose (agents.review_email_recipients; before the rule: all three): whoever started the onboarding, the
 * admissions contacts, every active CMS administrator. The configured admin inbox stands in when the chosen people give no address.
 */
function staffRecipients(follow: Followup, fallback: string[], chosen: Set<string>): string[] {
  const valid = (e: string | null | undefined): e is string => !!e && /@/.test(e);
  const wantPeople = chosen.has(REVIEW_RECIPIENTS.starter) || chosen.has(REVIEW_RECIPIENTS.admins);
  const people = [...(chosen.has(REVIEW_RECIPIENTS.starter) ? [follow.sentBy?.email] : []), ...(chosen.has(REVIEW_RECIPIENTS.admins) ? follow.admins ?? [] : [])].filter(valid);
  const contacts = (chosen.has(REVIEW_RECIPIENTS.contacts) ? follow.contacts ?? [] : []).filter(valid);
  const backup = !people.length && (wantPeople || !contacts.length) ? fallback : [];
  return [...new Set([...people.slice(0, 1), ...contacts, ...people.slice(1), ...backup].filter(valid).map((e) => e.toLowerCase()))];
}

/** The corrected application is signed again: staff are told (once per round). */
export async function notifyResubmitted(ctx: Pick<OnboardingContext, "ports">, onboardingId: string): Promise<{ notified: boolean }> {
  const { ports } = ctx;
  const follow = await serviceRpc(ports, "agency_onboarding_followup", { p_onboarding: onboardingId }) as Followup;
  if (follow.stage !== "resubmitted") return { notified: false };
  const { provider, config } = ports.mail;
  const to = staffRecipients(follow, config.adminTo, (await onboardingRules(ctx)).reviewRecipients);
  if (!provider || !config.from || !to.length) return { notified: false };
  const waiting = follow.label === "Awaiting referees";
  const outcome = outcomeState(await provider.send({ deliveryId: `onboarding-resubmitted-${onboardingId}-r${follow.round ?? 0}`, from: config.from, to: to.join(", "),
    subject: `Resubmitted: ${text(follow.agency.name, 120)}`,
    textBody: `${text(follow.agent.name, 80)} has corrected and signed again the Agent Application Form for ${text(follow.agency.name, 120)} (correction round ${follow.round ?? 1}).\n\n`
      + (waiting ? "A referee's details changed, so a new referee check went out. The application is ready for review once both referees have replied.\n\n" : "")
      + `Open the business in the CMS (Businesses > ${text(follow.agency.name, 120)}) and choose Review application.` + SIGN_OFF }));
  return { notified: outcome.state === "sent" };
}

export const ONBOARDING_ACTIONS: Record<string, (ctx: OnboardingContext) => Promise<Json>> = {
  agent_onboarding_review_save: reviewSave,
  agent_onboarding_presend_open: presendOpen,
  agent_onboarding_presend_save: presendSave,
  agent_onboarding_presend_send: presendSend,
  agent_onboarding_presend_discard: presendDiscard,
  agent_onboarding_presend_warm: presendWarm,
  agent_onboarding_correction_send: correctionSend,
  agent_onboarding_approve: approveAndActivate,
  agent_onboarding_install: installBlank,
  agent_onboarding_send: sendApplication,
  agent_onboarding_send_application: sendApplication,
  agent_onboarding_send_agreement: sendAgreement,
  agent_onboarding_send_referees: sendRefereesNow,
  agent_onboarding_reject: rejectOnboarding,
  agent_onboarding_referee_change: changeReferee,
  agent_onboarding_referee_upload: uploadRefereeForm,
  agent_onboarding_business_create: createBusiness,
  agent_onboarding_business_delete: deleteBusiness,
  agent_onboarding_business_activate: activateBusinessByAdmin,
  agent_onboarding_abn_lookup: abnLookup,
  // Retired (2026-11-19): agents have no onboarding of their own.
  agent_onboarding_add_agent: retired,
  agent_onboarding_agent_activate: retired,
  agent_onboarding_agent_agreement_send: retired,
  agent_onboarding_agent_agreement_upload: retired,
  agent_onboarding_agent_countersigner_change: retired,
};
