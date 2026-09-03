import { supabaseAdmin } from "@/lib/supabase"
import { logger } from "@/lib/logger"

let cachedPlaybook: { version: number; rules: any[]; qa_examples: any[]; prompt_override: string } | null | undefined
let cachedAt = 0
const CACHE_TTL_MS = 60_000

export interface ActivePlaybook {
  version: number
  rules: { category: string; rule: string }[]
  qa_examples: { question: string; answer: string }[]
  prompt_override: string
}

export async function getActivePlaybook(force?: boolean): Promise<ActivePlaybook | null> {
  if (!force && cachedPlaybook !== undefined && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedPlaybook
  }

  try {
    const { data } = await supabaseAdmin
      .from("ai_playbook_versions")
      .select("version, rules, qa_examples, prompt_override")
      .eq("status", "active")
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!data) {
      cachedPlaybook = null
      cachedAt = Date.now()
      return null
    }

    cachedPlaybook = {
      version: data.version,
      rules: Array.isArray(data.rules) ? data.rules : [],
      qa_examples: Array.isArray(data.qa_examples) ? data.qa_examples : [],
      prompt_override: data.prompt_override || "",
    }
    cachedAt = Date.now()
    return cachedPlaybook
  } catch (err: any) {
    logger.error("Failed to load active playbook", { error: err.message })
    return cachedPlaybook || null
  }
}

export function formatPlaybookForAgent(playbook: ActivePlaybook | null): string {
  if (!playbook || playbook.version <= 1 && playbook.rules.length === 0) {
    return ""
  }

  const sections: string[] = []

  if (playbook.rules.length > 0) {
    sections.push(
      "LESSONS LEARNED FROM RECENT CALLS (follow these):\n" +
        playbook.rules.map((r) => `- [${r.category}] ${r.rule}`).join("\n")
    )
  }

  if (playbook.prompt_override) {
    sections.push(playbook.prompt_override)
  }

  if (playbook.qa_examples.length > 0) {
    sections.push(
      "HOW TO ANSWER COMMON CANDIDATE QUESTIONS:\n" +
        playbook.qa_examples
          .map((e) => `- Q: ${e.question}\n  A: ${e.answer}`)
          .join("\n")
    )
  }

  return sections.join("\n\n")
}
