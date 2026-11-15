import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { queryGsbQuota } from "@/lib/gsb-quota";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let body: { providerId?: unknown; refresh?: unknown };
  try {
    body = await request.json() as { providerId?: unknown; refresh?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const providerId = typeof body.providerId === "string" && body.providerId.trim()
    ? body.providerId.trim()
    : "";
  if (!providerId) {
    return NextResponse.json({ error: "providerId is required" }, { status: 400 });
  }

  const result = await queryGsbQuota(providerId, { refresh: body.refresh === true });
  return NextResponse.json(result);
}
