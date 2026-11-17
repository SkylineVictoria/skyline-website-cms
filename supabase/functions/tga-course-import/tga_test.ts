import { searchQualifications } from "./tga.ts";

Deno.test("SOAP search decodes UTF-8 and UTF-16 and diagnoses broken streams", async () => {
  const original = globalThis.fetch;
  const username = Deno.env.get("EF_TGA_SANDBOX_USERNAME");
  const password = Deno.env.get("EF_TGA_SANDBOX_PASSWORD");
  Deno.env.set("EF_TGA_SANDBOX_USERNAME", "mock");
  Deno.env.set("EF_TGA_SANDBOX_PASSWORD", "mock");
  const payload = '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><SearchResponse xmlns="http://training.gov.au/services/13/"><SearchResult><Results/></SearchResult></SearchResponse></s:Body></s:Envelope>';
  const assert = (ok: boolean) => { if (!ok) throw new Error("Assertion failed"); };
  try {
    globalThis.fetch = async () => new Response(payload);
    assert((await searchQualifications("BSB50120")).length === 0);
    // Reproduce a runtime that transfers the previous chunk on the next read.
    const bytes = new TextEncoder().encode(payload);
    let reads = 0;
    globalThis.fetch = async (_url, init) => {
      assert(new Headers(init?.headers).get("Accept-Encoding") === "identity");
      return {
        ok: true, status: 200, headers: new Headers(),
        body: { getReader: () => ({
          read: async () => {
            if (reads++ === 0) return { done: false, value: bytes };
            structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
            return { done: true };
          },
          cancel: async () => {},
        }) },
      } as unknown as Response;
    };
    assert((await searchQualifications("BSB50120")).length === 0);
    for (const bigEndian of [false, true]) {
      for (const bom of [false, true]) {
        const data = new Uint8Array(payload.length * 2 + (bom ? 2 : 0));
        const view = new DataView(data.buffer);
        if (bom) view.setUint16(0, 0xfeff, !bigEndian);
        for (let i=0;i<payload.length;i++) view.setUint16((bom ? 2 : 0)+i*2,payload.charCodeAt(i),!bigEndian);
        globalThis.fetch = async () => new Response(data);
        assert((await searchQualifications("BSB50120")).length === 0);
      }
    }
    for (const [response, expected] of [
      [new Response(new Uint8Array([255,255])), "XML decode failed"],
      [new Response(new ReadableStream({start(c){c.error(new Error("private diagnostic"));}})), "response download failed"],
    ] as const) {
      globalThis.fetch = async () => response;
      let message = "";
      try { await searchQualifications("BSB50120"); } catch (error) { message = (error as Error).message; }
      assert(message.includes(expected) && !message.includes("private diagnostic"));
    }
  } finally {
    globalThis.fetch = original;
    for (const [key, value] of [["EF_TGA_SANDBOX_USERNAME", username], ["EF_TGA_SANDBOX_PASSWORD", password]]) {
      if (value === undefined) Deno.env.delete(key!); else Deno.env.set(key!, value);
    }
  }
});

Deno.test("packaging rules: varied headings, unlabelled groups and prerequisite markers", async () => {
  const { parseQualificationRelease } = await import("./tga.ts");
  const assert = (ok: boolean, message: string) => { if (!ok) throw new Error(message); };
  const xml = (code: string, cells: string[]) => `<?xml version="1.0"?><AuthorIT xmlns="http://www.authorit.com/xml/authorit"><Objects>
<Book><VariableAssignments><VariableAssignment><Name>Code</Name><Value>${code}</Value></VariableAssignment>
<VariableAssignment><Name>ReleaseNumber</Name><Value>1</Value></VariableAssignment></VariableAssignments></Book>
<Topic><Headings><PrintHeading>Packaging Rules</PrintHeading></Headings><Text>${cells.map(cell => `<p>${cell}</p>`).join("")}</Text></Topic>
</Objects></AuthorIT>`;
  // RII30926 layout: "Core units of competency", "Electives", "Group A Title" without a dash, "*" in its own cell.
  const rii = parseQualificationRelease(xml("RII30926", ["Total number of units = 4", "2 core units", "2 elective units",
    "Core units of competency", "Unit code", "Unit title", "RIIBEF201", "Plan and organise work", "RIIWHS201E Work safely",
    "Electives", "Group A Asphalt Surfacing", "RIICBS202E Hand spread asphalt", "Group YA General – Asphalt",
    "RIICBM302E", "*", "Install pre-cast girders"]), "RII30926", "1");
  assert(rii.core.map(unit => unit.code).join() === "RIIBEF201,RIIWHS201E", "core " + JSON.stringify(rii.core));
  assert(rii.electives.length === 2 && rii.electives[1].name === "Install pre-cast girders" && rii.electives[1].groups[0] === "YA",
    "electives " + JSON.stringify(rii.electives));
  // CPC30220 layout: "Core Units", no electives heading (the first group starts them), "7 electives".
  const cpc = parseQualificationRelease(xml("CPC30220", ["3 units of competency:", "1 core units", "2 electives",
    "Core Units", "CPCCCA2002 Use carpentry tools", "Group A - Specialist Electives", "CPCCCA3009 Construct advanced roofs",
    "Group B - General Electives", "CPCCCA3012 Frame and fit wet area fixtures"]), "CPC30220", "1");
  assert(cpc.core.length === 1 && cpc.electives.length === 2 && cpc.requiredElectives === 2, "cpc " + JSON.stringify(cpc));
  assert(cpc.electives[0].groups[0] === "A" && cpc.electives[1].groups[0] === "B", "cpc groups " + JSON.stringify(cpc.groups));
});

Deno.test("RTO scope lists current qualifications whatever the field names", async () => {
  const { scopeQualifications } = await import("./tga.ts");
  const assert = (ok: boolean, message: string) => { if (!ok) throw new Error(message); };
  const body = { scope: { qualifications: [
    { trainingComponent: { code: "ICT60220", title: "Advanced Diploma of Information Technology" }, endDate: "2030-01-01" },
    { code: "CPC30220", title: "Certificate III in Carpentry", scopeEndDate: "2020-01-01" },
    { nrtCode: "AUR30620", trainingComponentTitle: "Certificate III in Light Vehicle Mechanical Technology", status: "Current" },
    { code: "BSBWHS521", title: "A unit, not a qualification" },
  ] } };
  const items = scopeQualifications(body, "2026-11-16");
  assert(items.map(i => i.code).join() === "AUR30620,CPC30220,ICT60220", "codes " + items.map(i => i.code).join());
  assert(items.find(i => i.code === "CPC30220")?.current === false, "ended scope is not current");
  assert(items.find(i => i.code === "ICT60220")?.current === true, "nested component inherits the parent end date");
});

Deno.test("elective packaging rules: read from the official text and checked against a selection", async () => {
  const { parseElectiveRules, checkElectives, prerequisiteCodes } = await import("./packaging.ts");
  const assert = (ok: boolean, message: string) => { if (!ok) throw new Error(message); };
  const brief = (text: string[], required: number | null, groups: string[]) => {
    const rules = parseElectiveRules(text.join("\n"), required, groups);
    return [rules.groupMin.map(rule => rule.groups.join("") + ":" + rule.count).join(" "), rules.groupMax.map(rule => rule.groups.join("") + ":" + rule.count).join(" "),
      rules.outsideMax, rules.unchecked.length].join(" | ");
  };
  const same = (got: string, want: string, name: string) => assert(got === want, `${name}: got "${got}", want "${want}"`);
  const rii = ["Total number of units = 12", "5 core units", "7 elective units,", "at least two (2) must be chosen from Group A",
    "at least three (3) must be chosen from Group B",
    "no more than two (2) units from elsewhere within this training package, or from another endorsed training package, or from an accredited course.",
    "All elective units selected from outside this qualification must reflect current occupational and learning outcomes of this AQF qualification level.",
    "Core units of competency", "RIICWD507D Prepare detailed geotechnical design"];
  same(brief(rii, 7, ["A", "B"]), "A:2 B:3 |  | 2 | 0", "RII60520");
  same(brief(["15 elective units consisting of:", "1 unit only from Group A", "at least 8 units in any combination from Groups B, C, D or E", "Core units"], 15, ["A", "B", "C", "D", "E"]),
    "A:1 BCDE:8 | A:1 | 0 | 0", "MSF30422: one only, a combination of groups, no outside units");
  same(brief(["7 elective units,", "2 elective units must be selected from Group A", "for the remaining 5 elective units:", "up to 5 units may be selected from Groups A – I",
    "if not listed, up to 2 units may be selected from a Certificate IV, Diploma or Advanced Diploma from this or any other currently endorsed Training Package qualification or accredited course.",
    "Specialisations", "4 elective units must be selected from Group B", "Core units"], 7, "ABCDEFGHI".split("")),
    "A:2 |  | 2 | 0", "BSB50120: the remaining units are not a group cap; specialisation rules are not read");
  same(brief(["3 elective units.", "3 from the listed electives", "2 from listed electives and 1 from any endorsed Training Package or accredited course, as long as it contributes", "Core units"], 3, []),
    " |  | 1 | 0", "CPC30620: one outside unit");
  same(brief(["7 elective units", "a minimum of five (5) units must be selected from Group A",
    "the remaining two (2) maybe selected from Group A or Group B or from any group or current training package, as long as it contributes", "Core Units"], 7, ["A", "B"]),
    "A:5 |  | 2 | 0", "CPC30326");
  same(brief(["17 elective units, consisting of:", "8 to 13 units from Groups A to F", "3 to 8 units from Group G", "1 or 2 units from Group H",
    "up to 5 units not listed below from any endorsed Training Package or accredited course. These units:", "must not include any unit coded MSFFP", "CORE UNITS"], 17, "ABCDEFGH".split("")),
    "ABCDEF:8 G:3 H:1 | ABCDEF:13 G:8 H:2 | 5 | 0", "MSF30322: ranges");
  same(brief(["16 elective units", "Elective units chosen must be relevant to the work environment and the qualification.", "Core Units"], 16, []), " |  | 0 | 0", "AUR30620: plain");
  assert(parseElectiveRules(["8 elective units.", "All Group A elective units", "Up to two elective units from either Group B or general electives.", "Core Units"].join("\n"), 8, ["A", "B"]).unchecked.length > 0,
    "a stream rule (all of a group) is flagged for confirmation by hand");
  assert(parseElectiveRules("Total number of units = 10\nCore Units", null, []).unchecked.length === 1, "no elective count: confirmation by hand");

  const rules = parseElectiveRules(rii.join("\n"), 7, ["A", "B"]);
  const pick = (count: number, group: string | null) => Array.from({ length: count }, (_, index) => ({ code: `${group ?? "X"}${index}`, groups: group === null ? null : [group] }));
  const state = (list: { code: string; groups: string[] | null }[]) => { const check = checkElectives(rules, list); return `${check.ok}/${check.complete}`; };
  same(state([]), "true/false", "nothing chosen is allowed but not complete");
  same(state([...pick(2, "A"), ...pick(3, "B"), ...pick(2, null)]), "true/true", "2 A + 3 B + 2 outside is complete");
  same(state([...pick(2, "A"), ...pick(3, "B"), ...pick(3, null)]), "false/false", "8 electives is blocked");
  same(state([...pick(2, "A"), ...pick(2, "B"), ...pick(3, null)]), "false/false", "3 outside units is blocked");
  same(state(pick(5, "A")), "false/false", "5 from A leaves no room for 3 from B");
  same(state(pick(4, "A")), "true/false", "4 from A can still be completed");
  const streams = parseElectiveRules(["8 elective units.", "All Group A elective units", "Up to two elective units from either Group B or general electives.", "Core Units"].join("\n"), 8, ["A", "B"]);
  assert(checkElectives(streams, pick(3, "B")).ok && !checkElectives(streams, pick(9, "B")).ok, "with unread rules only the total blocks");
  same(prerequisiteCodes("CPCCWHS2001 Apply WHS requirements\nCPCCCM2012* Work safely at heights", "CPCCCM2012").join(), "CPCCWHS2001", "prerequisite codes");
  same(prerequisiteCodes("Nil").join(), "", "Nil");
});
