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
