import type { InterviewPlan } from "@/lib/interview-plan"

/**
 * Per-call coverage and language audit.
 *
 * The 27 Nov Himanshu call exposed two failures that a prompt alone cannot
 * guarantee: the agent closed at 2:04 after only five of nine planned questions,
 * and it switched to Hinglish after the candidate's only word was "yes". Both
 * are measurable from the transcript, so they are measured here and stored on
 * the row. A call that closed before covering the plan is not a screening and
 * must not carry a fit score.
 *
 * This module is intentionally pure and provider-agnostic: `bolna-execution.ts`
 * uses it at terminal handling time, and the results sheet reads the stored
 * `_call_coverage` block. See docs/ai-call-quality-plan.md.
 */

export const MIN_EXPECTED_SECONDS = 270 // 4:30 — the earliest a complete call should close
export const MIN_TOPIC_EVIDENCE_WORDS = 6
export const MIN_SUBSTANTIVE_ANSWER_WORDS = 10

export interface CallCoverage {
  /** False when the row has no stored plan, so nothing can be asserted. */
  assessable: boolean
  topics_planned: number
  topics_asked: number
  digs_planned: number
  digs_asked: number
  topics_with_evidence: number
  question_turns: number
  substantive_question_turns: number
  duration_seconds: number
  min_expected_seconds: number
  has_closing_line: boolean
  closed_before_coverage: boolean
  coverage_ok: boolean
  declined_or_dnd: boolean
  candidate_turns: number
  candidate_words: number
  substantive_answers: number
  first_hinglish_assistant_segment: number | null
  first_hinglish_candidate_segment: number | null
  language_switch_segment: number | null
  early_language_switch: boolean
  reasons: string[]
}

type Segment = { speaker: "ai" | "candidate"; text: string }

const AI_LINE = /^(assistant|ai|agent|bot|system|hiring manager|recruiter|ai screener|screener):\s*(.*)$/i
const CANDIDATE_LINE = /^(user|candidate|human|applicant|interviewee|respondent):\s*(.*)$/i

/** Same shape the rest of the call code parses, kept local so this module has
 *  no dependency on the execution handler (and cannot create an import cycle). */
function parseSegments(transcript: string): Segment[] {
  const segments: Segment[] = []
  const lines = String(transcript || "").split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const ai = line.match(AI_LINE)
    const candidate = line.match(CANDIDATE_LINE)
    if (ai) {
      if (ai[2]?.trim()) segments.push({ speaker: "ai", text: ai[2].trim() })
      else if (lines[i + 1]?.trim()) {
        segments.push({ speaker: "ai", text: lines[i + 1].trim() })
        i++
      }
      continue
    }
    if (candidate) {
      if (candidate[2]?.trim()) segments.push({ speaker: "candidate", text: candidate[2].trim() })
      else if (lines[i + 1]?.trim()) {
        segments.push({ speaker: "candidate", text: lines[i + 1].trim() })
        i++
      }
      continue
    }
    if (/^AI Screener$/i.test(line)) {
      if (lines[i + 1]?.trim()) {
        segments.push({ speaker: "ai", text: lines[i + 1].trim() })
        i++
      }
      continue
    }
    if (/^Candidate$/i.test(line)) {
      if (lines[i + 1]?.trim()) {
        segments.push({ speaker: "candidate", text: lines[i + 1].trim() })
        i++
      }
      continue
    }
    const last = segments[segments.length - 1]
    if (last) last.text = `${last.text} ${line}`
    else segments.push({ speaker: "candidate", text: line })
  }
  return segments
}

function words(text: string): string[] {
  return String(text || "").trim().split(/\s+/).filter(Boolean)
}

function wordCount(text: string): number {
  return words(text).length
}

/**
 * Hinglish markers. A single "sir"/"ji" is not a language signal — the Himanshu
 * call opened with "yes", and a consent word must never flip the language.
 */
const HINGLISH_MARKERS =
  /\b(haan|han|nahi|nahin|hai|hain|tha|thi|kya|kaise|maine|humne|aapne|karte|karti|kiya|kiye|raha|rahi|aur|bhi|toh|matlab|boliye|samajh|gaya|koi|abhi|yahan|wahan|ka|ki|ke|se|mein|liye|karne|hota|hoti|wala|wali|log|kaam|bataiye|bilkul|theek|achha|shukriya|dhanyavaad|ji)\b/gi

function hinglishScore(text: string): number {
  if (/[\u0900-\u097F]/.test(text)) return 10
  const matches = String(text || "").match(HINGLISH_MARKERS) || []
  return matches.length
}

/**
 * Two markers for the assistant, one for the candidate. "Haan ji" is a real
 * Hindi answer and must permit a switch, but a lone "ji" in an English sentence
 * is not. The assistant gets the stricter threshold so its own "Achha,
 * shukriya" cannot be mistaken for the candidate having switched first.
 */
function isHinglish(text: string, threshold = 2): boolean {
  return hinglishScore(text) >= threshold
}

const STOPWORDS = new Set([
  "the", "and", "you", "your", "did", "was", "were", "have", "has", "had", "what", "which",
  "when", "where", "with", "that", "this", "from", "for", "about", "into", "they", "them",
  "there", "then", "than", "aap", "aapne", "aapka", "aapki", "aapko", "kya", "kaise", "kaun",
  "kaunsi", "kaunse", "kitna", "kitni", "kitne", "kis", "kisi", "ek", "baar", "bataiye",
  "batao", "please", "tell", "give", "example", "real", "ka", "ki", "ke", "se", "mein",
  "hai", "hain", "tha", "thi", "the", "aur", "par", "liye", "kar", "karna", "kiya", "karte",
])

function keywords(text: string): string[] {
  const raw = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097F\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
  const out: string[] = []
  for (const token of raw) {
    if (token.length < 4) continue
    if (STOPWORDS.has(token)) continue
    if (!out.includes(token)) out.push(token)
  }
  return out
}

/**
 * Weighted overlap. Rare words (shipment, negotiation, FCL) carry more signal
 * than words that appear in every topic ("client", "work"), so a translated or
 * paraphrased ask still matches its topic.
 */
function overlapScore(
  segmentText: string,
  target: string[],
  documentFrequency: Map<string, number>,
  totalTopics: number
): number {
  if (target.length === 0) return 0
  const present = new Set(keywords(segmentText))
  let matched = 0
  let total = 0
  for (const token of target) {
    const df = documentFrequency.get(token) || 1
    const weight = totalTopics / Math.max(1, df)
    total += weight
    if (present.has(token)) matched += weight
  }
  return total > 0 ? matched / total : 0
}

const QUESTION_MARK = /\?/
const INTERROGATIVE =
  /\b(kaise|kaun|kaunsi|kaunse|kitna|kitni|kitne|kya|kab|kahan|kyun|kyu|bataiye|batao|which|what|how|when|where|why|tell me|describe|walk me)\b/i

function isQuestion(text: string): boolean {
  return QUESTION_MARK.test(text) || INTERROGATIVE.test(text)
}

const CLOSING_LINE =
  /(dhanyavaad|goodbye|good bye|aapka bahut shukriya|thank you for your time|we'?ll let you know on whatsapp|shortlist hote hain|next round ke liye shortlist|if you'?re shortlisted)/i

const DECLINED_OR_DND =
  /(not interested|not looking|don'?t call|do not call|wrong number|galat number|\bdnd\b|do not disturb|not a good time|call me later|call back later|sochke|soch kar|busy right now|abhi busy|interested nahi)/i

const EXPLICIT_NO_EXPERIENCE =
  /(nahi kiya|nahin kiya|nahi karte|nahi hota|pata nahi|not done|never did|didn'?t do|have not done|haven'?t done|not handled|nahi handle|sirf air cargo|only air cargo|mostly air cargo|air cargo hi|aisa kaam nahi|itna bada shipment nahi)/i

function topicAskText(topic: InterviewPlan["topics"][number]): string {
  return [topic.ask, topic.ask_en, topic.label, topic.resume_hook].filter(Boolean).join(" ")
}

function digText(dig: InterviewPlan["topics"][number]["digs"][number]): string {
  return [dig.prompt, dig.prompt_en].filter(Boolean).join(" ")
}

/**
 * Analyse one finished call against the plan it was supposed to run.
 *
 * Matching is deliberately tolerant: the agent translates and paraphrases, so
 * exact string comparison would report "topic not asked" on every good call.
 * Topic order is preserved by the prompt, so a forward-only search plus weighted
 * keyword overlap is enough to tell "asked" from "skipped".
 */
export function analyzeCallCoverage(opts: {
  transcript: string
  plan?: InterviewPlan | null
  durationSec?: number | null
  hangupReason?: string | null
}): CallCoverage {
  const transcript = String(opts.transcript || "")
  const segments = parseSegments(transcript)
  const assistant = segments.filter((s) => s.speaker === "ai")
  const candidate = segments.filter((s) => s.speaker === "candidate")
  const duration = Number(opts.durationSec || 0) || 0

  const questionSegments = assistant.filter((s) => isQuestion(s.text))
  const candidateWords = candidate.reduce((total, s) => total + wordCount(s.text), 0)
  const substantiveAnswers = candidate.filter(
    (s) => wordCount(s.text) >= MIN_SUBSTANTIVE_ANSWER_WORDS
  ).length

  const declined = DECLINED_OR_DND.test(transcript)
  const hasClosingLine = CLOSING_LINE.test(transcript)

  // Language audit: compare positions in the full transcript, not turn numbers,
  // so "assistant switched before the candidate ever spoke Hindi" is exact.
  let firstHinglishAssistant: number | null = null
  let firstHinglishCandidate: number | null = null
  segments.forEach((s, i) => {
    if (firstHinglishAssistant == null && s.speaker === "ai" && isHinglish(s.text)) {
      firstHinglishAssistant = i
    }
    if (firstHinglishCandidate == null && s.speaker === "candidate" && isHinglish(s.text, 1)) {
      firstHinglishCandidate = i
    }
  })
  const earlyLanguageSwitch =
    firstHinglishAssistant != null &&
    (firstHinglishCandidate == null || firstHinglishAssistant < firstHinglishCandidate)

  const plan = opts.plan && Array.isArray(opts.plan.topics) ? opts.plan : null
  const plannedTopics = plan ? plan.topics.length : 0
  const plannedDigs = plan
    ? plan.topics.reduce((total, t) => total + (Array.isArray(t.digs) ? t.digs.length : 0), 0)
    : 0

  if (!plan || plannedTopics === 0) {
    return {
      assessable: false,
      topics_planned: 0,
      topics_asked: 0,
      digs_planned: 0,
      digs_asked: 0,
      topics_with_evidence: 0,
      question_turns: questionSegments.length,
      substantive_question_turns: questionSegments.filter((s) => wordCount(s.text) >= 3).length,
      duration_seconds: duration,
      min_expected_seconds: MIN_EXPECTED_SECONDS,
      has_closing_line: hasClosingLine,
      closed_before_coverage: false,
      coverage_ok: false,
      declined_or_dnd: declined,
      candidate_turns: candidate.length,
      candidate_words: candidateWords,
      substantive_answers: substantiveAnswers,
      first_hinglish_assistant_segment: firstHinglishAssistant,
      first_hinglish_candidate_segment: firstHinglishCandidate,
      language_switch_segment: firstHinglishAssistant,
      early_language_switch: earlyLanguageSwitch,
      reasons: ["No stored interview plan — coverage cannot be measured."],
    }
  }

  // Document frequency across topics so a word shared by every topic does not
  // dominate the match.
  const df = new Map<string, number>()
  const topicKeywords = plan.topics.map((t) => {
    const set = new Set(keywords(topicAskText(t)))
    for (const token of set) df.set(token, (df.get(token) || 0) + 1)
    return Array.from(set)
  })

  // Find the assistant segment that asked each topic, forward only.
  const topicAskIndex: (number | null)[] = []
  let searchFrom = 0
  for (let ti = 0; ti < plan.topics.length; ti++) {
    let found: number | null = null
    let best = 0
    for (let si = searchFrom; si < segments.length; si++) {
      if (segments[si].speaker !== "ai" || !isQuestion(segments[si].text)) continue
      const score = overlapScore(segments[si].text, topicKeywords[ti], df, plannedTopics)
      if (score >= 0.3 && score > best) {
        best = score
        found = si
      }
      // Once the next topic's distinctive words appear, stop looking.
      if (score >= 0.55) break
    }
    topicAskIndex.push(found)
    if (found != null) searchFrom = found + 1
  }

  const topicsAsked = topicAskIndex.filter((i) => i != null).length
  let digsAsked = 0
  let topicsWithEvidence = 0
  const reasons: string[] = []

  for (let ti = 0; ti < plan.topics.length; ti++) {
    const topic = plan.topics[ti]
    const askAt = topicAskIndex[ti]
    if (askAt == null) {
      reasons.push(`topic ${ti + 1} was never asked`)
      continue
    }
    const nextAsk = topicAskIndex.slice(ti + 1).find((i) => i != null) ?? segments.length
    const window = segments.slice(askAt + 1, nextAsk)

    // Digs asked in this topic's window.
    const digKeywords = (topic.digs || []).map((d) => keywords(digText(d)))
    const usedDigs = new Set<number>()
    for (const seg of window) {
      if (seg.speaker !== "ai" || !isQuestion(seg.text)) continue
      for (let di = 0; di < digKeywords.length; di++) {
        if (usedDigs.has(di)) continue
        if (overlapScore(seg.text, digKeywords[di], df, plannedTopics) >= 0.35) {
          usedDigs.add(di)
          break
        }
      }
    }
    digsAsked += usedDigs.size

    const answers = window.filter((s) => s.speaker === "candidate")
    const answerWords = answers.reduce((total, s) => total + wordCount(s.text), 0)
    const explicitNo = answers.some((s) => EXPLICIT_NO_EXPERIENCE.test(s.text))
    const hasEvidence = answerWords >= MIN_TOPIC_EVIDENCE_WORDS || explicitNo
    if (hasEvidence) topicsWithEvidence++
    else reasons.push(`topic ${ti + 1} had no concrete answer`)

    // A thin topic should have been dug into at least once. If it was asked and
    // the candidate gave a one-word answer, no dig means the agent moved on.
    if (!hasEvidence && usedDigs.size === 0) {
      reasons.push(`topic ${ti + 1} was thin and was not dug into`)
    }
  }

  const questionTurns = questionSegments.length
  const minQuestionTurns = plannedTopics + 1
  const coverageOk =
    topicsAsked >= plannedTopics &&
    topicsWithEvidence >= plannedTopics &&
    questionTurns >= minQuestionTurns &&
    duration >= MIN_EXPECTED_SECONDS

  if (topicsAsked < plannedTopics) {
    reasons.push(`only ${topicsAsked} of ${plannedTopics} topics were asked`)
  }
  if (topicsWithEvidence < plannedTopics) {
    reasons.push(`only ${topicsWithEvidence} of ${plannedTopics} topics produced evidence`)
  }
  if (questionTurns < minQuestionTurns) {
    reasons.push(`only ${questionTurns} question turns (expected at least ${minQuestionTurns})`)
  }
  if (duration > 0 && duration < MIN_EXPECTED_SECONDS) {
    const mins = Math.floor(duration / 60)
    const secs = Math.round(duration % 60)
    reasons.push(`call closed at ${mins}m ${secs}s, before the 4m 30s floor`)
  }

  const closedBeforeCoverage = hasClosingLine && !declined && !coverageOk

  return {
    assessable: true,
    topics_planned: plannedTopics,
    topics_asked: topicsAsked,
    digs_planned: plannedDigs,
    digs_asked: digsAsked,
    topics_with_evidence: topicsWithEvidence,
    question_turns: questionTurns,
    substantive_question_turns: questionSegments.filter((s) => wordCount(s.text) >= 3).length,
    duration_seconds: duration,
    min_expected_seconds: MIN_EXPECTED_SECONDS,
    has_closing_line: hasClosingLine,
    closed_before_coverage: closedBeforeCoverage,
    coverage_ok: coverageOk,
    declined_or_dnd: declined,
    candidate_turns: candidate.length,
    candidate_words: candidateWords,
    substantive_answers: substantiveAnswers,
    first_hinglish_assistant_segment: firstHinglishAssistant,
    first_hinglish_candidate_segment: firstHinglishCandidate,
    language_switch_segment: firstHinglishAssistant,
    early_language_switch: earlyLanguageSwitch,
    reasons,
  }
}

/** Short, honest line for the card and for WhatsApp/activity history. */
export function describeCoverage(coverage: CallCoverage | null | undefined): string | null {
  if (!coverage || !coverage.assessable) return null
  if (coverage.coverage_ok) {
    return `Coverage: ${coverage.topics_asked}/${coverage.topics_planned} topics · ${coverage.digs_asked} digs`
  }
  return `Screening incomplete — ${coverage.topics_asked}/${coverage.topics_planned} topics, ${coverage.digs_asked} digs. ${
    coverage.reasons[0] ? coverage.reasons[0] + "." : ""
  } No score given.`
}
