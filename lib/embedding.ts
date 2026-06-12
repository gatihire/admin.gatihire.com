async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms))
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return []

  const model = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001"
  const targetDim = Number(process.env.EMBEDDING_DIM || 768)
  const input = String(text || "").trim().slice(0, 8000)
  if (!input) return []

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`
  const makeBody = (includeDim: boolean) => {
    const body: any = {
      model: `models/${model}`,
      content: { parts: [{ text: input }] },
    }
    if (includeDim && Number.isFinite(targetDim) && targetDim > 0) {
      body.output_dimensionality = targetDim
    }
    return body
  }

  const doRequest = async (body: any) => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
    })

    const json = await res.json().catch(() => null)
    if (!res.ok) {
      const msg = json?.error?.message || res.statusText || "Embedding request failed"
      const err = new Error(`[Gemini Embedding Error] ${res.status} ${msg}`)
      ;(err as any).status = res.status
      throw err
    }

    const values =
      json?.embedding?.values ||
      json?.embeddings?.[0]?.values ||
      json?.data?.[0]?.embedding?.values ||
      null

    if (!Array.isArray(values)) return []
    const vec = values.map((v: any) => Number(v)).filter((v: any) => Number.isFinite(v))
    if (!Number.isFinite(targetDim) || targetDim <= 0) return vec
    if (vec.length > targetDim) return vec.slice(0, targetDim)
    if (vec.length < targetDim) return [...vec, ...Array(targetDim - vec.length).fill(0)]
    return vec
  }

  try {
    return await doRequest(makeBody(true))
  } catch (e: any) {
    const status = Number((e as any)?.status || 0)
    const msg = String((e as any)?.message || e)
    if (status === 400 && /output_dimensionality|dimension|invalid value|unsupported/i.test(msg)) {
      return await doRequest(makeBody(false))
    }
    if (status === 429 || status === 503) {
      await sleep(600)
      return await doRequest(makeBody(true))
    }
    return []
  }
}
