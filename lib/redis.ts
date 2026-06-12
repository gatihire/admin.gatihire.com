import { Redis } from "@upstash/redis"

function cleanEnvValue(raw: string) {
  return raw.trim().replace(/^['"`]+|['"`]+$/g, "").trim()
}

function pickRedisConfig(): { url: string; token: string } | null {
  const envUrl = cleanEnvValue(process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_URL || "")
  const envToken = cleanEnvValue(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_TOKEN || "")

  if (envUrl.includes("<") || envUrl.includes(">")) return null
  if (envToken.includes("<") || envToken.includes(">")) return null

  if (envUrl && envToken) {
    try {
      const parsed = new URL(envUrl)
      return { url: `${parsed.protocol}//${parsed.host}`, token: envToken }
    } catch {
      return null
    }
  }

  if (!envUrl) return null

  try {
    const parsed = new URL(envUrl)
    const tokenFromUserInfo = parsed.username || parsed.password
    if (!tokenFromUserInfo) return null
    return { url: `${parsed.protocol}//${parsed.host}`, token: tokenFromUserInfo }
  } catch {
    return null
  }
}

export const redis = (() => {
  const cfg = pickRedisConfig()
  if (!cfg) return null
  return new Redis({ url: cfg.url, token: cfg.token })
})()
