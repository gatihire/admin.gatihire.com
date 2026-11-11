import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

type RefreshedSession = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
};

type ValidationResult = "valid" | "invalid" | "unavailable";

const VALIDATE_TIMEOUT_MS = 5000;
const REFRESH_TIMEOUT_MS = 5000;

function applySessionCookies(response: NextResponse, session: RefreshedSession) {
  response.cookies.set("sb-access-token", session.access_token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: session.expires_in,
  });
  response.cookies.set("sb-refresh-token", session.refresh_token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return response;
}

function toLogin(request: NextRequest) {
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  return NextResponse.redirect(loginUrl);
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/login")) {
    return NextResponse.next();
  }

  const initialAccessToken = request.cookies.get("sb-access-token")?.value || null;
  const refreshToken = request.cookies.get("sb-refresh-token")?.value || null;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    return toLogin(request);
  }

  const tryRefresh = async (): Promise<{ session: RefreshedSession | null; unavailable: boolean }> => {
    if (!refreshToken) return { session: null, unavailable: false };
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
      const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: {
          apikey: supabaseAnonKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      // 5xx / 429 mean the auth backend is degraded, not that the token is bad.
      if (!res.ok) return { session: null, unavailable: res.status >= 500 || res.status === 429 };
      const data = (await res.json().catch(() => null)) as any;
      const access_token = String(data?.access_token || "");
      const refresh_token = String(data?.refresh_token || "");
      const expires_in = Number(data?.expires_in || 0);
      if (!access_token || !refresh_token || !Number.isFinite(expires_in) || expires_in <= 0) {
        return { session: null, unavailable: false };
      }
      return { session: { access_token, refresh_token, expires_in }, unavailable: false };
    } catch {
      // Abort (timeout), DNS failure, Cloudflare 522, connection reset…
      return { session: null, unavailable: true };
    }
  };

  const validateAccessToken = async (token: string): Promise<ValidationResult> => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);
      const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: {
          apikey: supabaseAnonKey,
          authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (res.ok) return "valid";
      if (res.status === 401 || res.status === 403) return "invalid";
      // 5xx / 429 / anything unexpected: treat as outage, do not log the user out.
      return "unavailable";
    } catch {
      return "unavailable";
    }
  };

  if (!initialAccessToken) {
    const { session, unavailable } = await tryRefresh();
    if (session) return applySessionCookies(NextResponse.next(), session);
    // Backend down and we cannot refresh: let the request through and let the
    // route handlers decide. Redirecting here is what caused the mass logout.
    if (unavailable) return NextResponse.next();
    return toLogin(request);
  }

  const validity = await validateAccessToken(initialAccessToken);
  if (validity === "valid") return NextResponse.next();

  if (validity === "unavailable") {
    // Supabase is unreachable/slow. Never interpret that as "signed out";
    // API routes still enforce authentication.
    return NextResponse.next();
  }

  const { session, unavailable } = await tryRefresh();
  if (session) return applySessionCookies(NextResponse.next(), session);
  if (unavailable) return NextResponse.next();

  return toLogin(request);
}

export const config = {
  matcher: ["/((?!_next|api|public|login|board).*)"],
};
