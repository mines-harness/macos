import type { APIRoute } from "astro";

import { buildMinesProjectFileJsonSchema } from "@t3tools/shared/minesProjectFile";

export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildMinesProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
