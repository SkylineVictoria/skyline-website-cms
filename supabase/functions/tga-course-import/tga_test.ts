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
