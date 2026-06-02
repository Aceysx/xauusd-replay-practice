/**
 * Vercel Edge：将 /api/* 代理到独立 Python API（环境变量 API_PROXY_TARGET）。
 * 例：API_PROXY_TARGET=https://your-app.up.railway.app
 */
export const config = { runtime: "edge" };

export default async function handler(request) {
  const base = process.env.API_PROXY_TARGET;
  if (!base) {
    return Response.json(
      { error: "API_PROXY_TARGET is not set on Vercel" },
      { status: 502 }
    );
  }

  const incoming = new URL(request.url);
  const sub = incoming.pathname.replace(/^\/api\/?/, "");
  const target = `${base.replace(/\/$/, "")}/api/${sub}${incoming.search}`;

  const upstream = await fetch(target, {
    method: request.method,
    headers: {
      accept: request.headers.get("accept") || "application/json",
    },
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type":
        upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
