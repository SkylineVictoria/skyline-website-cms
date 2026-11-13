// Retired at the user's request. No imports, database access or continuation.
Deno.serve(() => new Response(JSON.stringify({error:"Job deleted"}), {status:410,headers:{"Content-Type":"application/json"}}));
