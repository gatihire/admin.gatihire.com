import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

type RefreshedSession = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
};

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
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    return NextResponse.redirect(loginUrl);
  }

  const tryRefresh = async (): Promise<RefreshedSession | null> => {
    if (!refreshToken) return null;
    try {
      const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: {
          apikey: supabaseAnonKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!res.ok) return null;
      const data = (await res.json().catch(() => null)) as any;
      const access_token = String(data?.access_token || "");
      const refresh_token = String(data?.refresh_token || "");
      const expires_in = Number(data?.expires_in || 0);
      if (!access_token || !refresh_token || !Number.isFinite(expires_in) || expires_in <= 0) return null;
      return { access_token, refresh_token, expires_in };
    } catch {
      return null;
    }
  };

  const validateAccessToken = async (token: string): Promise<boolean> => {
    try {
      const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: {
          apikey: supabaseAnonKey,
          authorization: `Bearer ${token}`,
        },
      });
      return res.ok;
    } catch {
      return false;
    }
  };

  let accessToken = initialAccessToken;
  if (!accessToken) {
    const refreshed = await tryRefresh();
    if (!refreshed) {
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = "/login";
      return NextResponse.redirect(loginUrl);
    }
    const response = NextResponse.next();
    response.cookies.set("sb-access-token", refreshed.access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: refreshed.expires_in,
    });
    response.cookies.set("sb-refresh-token", refreshed.refresh_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return response;
  }

  try {
    const ok = await validateAccessToken(accessToken);
    if (ok) return NextResponse.next();

    const refreshed = await tryRefresh();
    if (!refreshed) {
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = "/login";
      return NextResponse.redirect(loginUrl);
    }

    const response = NextResponse.next();
    response.cookies.set("sb-access-token", refreshed.access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: refreshed.expires_in,
    });
    response.cookies.set("sb-refresh-token", refreshed.refresh_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return response;
  } catch {
    const refreshed = await tryRefresh();
    if (refreshed) {
      const response = NextResponse.next();
      response.cookies.set("sb-access-token", refreshed.access_token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        path: "/",
        maxAge: refreshed.expires_in,
      });
      response.cookies.set("sb-refresh-token", refreshed.refresh_token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      });
      return response;
    }

    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    return NextResponse.redirect(loginUrl);
  }
}

export const config = {
  matcher: ["/((?!_next|api|public|login|board).*)"],
};
