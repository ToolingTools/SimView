const root = new URL("./dist/", import.meta.url);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 4173),
  async fetch(request) {
    const url = new URL(request.url);
    const name = url.pathname === "/" ? "preview.html" : url.pathname.slice(1);
    const file = Bun.file(new URL(name, root));
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    return new Response(file);
  },
});

console.log(`SimView preview: ${server.url}`);
