"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Dialog as UiDialog, DialogContent as UiDialogContent, DialogHeader as UiDialogHeader, DialogTitle as UiDialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/components/ui/use-toast"
import { Checkbox } from "@/components/ui/checkbox"
import { Loader2 } from "lucide-react"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import {
  BASE_SKILL_SUGGESTIONS,
  DEPARTMENT_CATEGORY_OPTIONS,
  EDUCATION_MIN_OPTIONS,
  ENGLISH_LEVEL_OPTIONS,
  GENDER_PREFERENCE_OPTIONS,
  LANGUAGE_OPTIONS,
  LICENSE_TYPE_OPTIONS,
  ROLE_CATEGORY_OPTIONS,
  SKILL_SUGGESTIONS_BY_SUBCATEGORY,
  SUB_CATEGORY_OPTIONS,
} from "@/lib/constants/job-form"

interface CreateJobDialogProps {
  onJobCreated: () => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
  trigger?: React.ReactNode
  jobId?: string
  initialValues?: Partial<{
    title: string
    industry: string
    location: string
    employment_type: string
    shift_type: string
    urgency_tag: string
    city: string
    salary_type: string
    salary_min: number
    salary_max: number
    description: string
    client_name: string
    client_id: string
    apply_type: string
    external_apply_url: string
    skills_must_have: string[]
    skills_good_to_have: string[]
    sub_category: string
    openings: number
    education_min: string
    experience_min_years: number
    experience_max_years: number
    languages_required: string[]
    english_level: string
    license_type: string
    age_min: number
    age_max: number
    gender_preference: string
    role_category: string
    department_category: string
  }>
}

function formatMoneyIN(value: number) {
  if (!value) return ""
  return new Intl.NumberFormat("en-IN").format(value)
}

function parseMoneyIN(raw: string) {
  const digits = raw.replace(/[^\d]/g, "")
  return digits ? parseInt(digits, 10) : 0
}

export function CreateJobDialog({ onJobCreated, open, onOpenChange, trigger, jobId, initialValues }: CreateJobDialogProps) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const { toast } = useToast()
  const [clients, setClients] = useState<{ id: string; name: string; slug: string }[]>([])
  const [clientOpen, setClientOpen] = useState(false)
  const [formData, setFormData] = useState({
    title: initialValues?.title || "",
    industry: initialValues?.industry || "",
    sub_category: (initialValues as any)?.sub_category || "",
    location: initialValues?.location || "",
    employment_type: (initialValues as any)?.employment_type || "full_time",
    shift_type: (initialValues as any)?.shift_type || "day",
    urgency_tag: (initialValues as any)?.urgency_tag || "",
    city: (initialValues as any)?.city || "",
    salary_type: (initialValues as any)?.salary_type || "monthly",
    salary_min: typeof (initialValues as any)?.salary_min === "number" ? (initialValues as any).salary_min : 0,
    salary_max: typeof (initialValues as any)?.salary_max === "number" ? (initialValues as any).salary_max : 0,
    description: initialValues?.description || "",
    openings: (initialValues as any)?.openings ?? 1,
    client_name: initialValues?.client_name || "",
    client_id: (initialValues as any)?.client_id || "",
    apply_type: (initialValues as any)?.apply_type || "in_platform",
    external_apply_url: (initialValues as any)?.external_apply_url || "",
    source: (initialValues as any)?.source || "truckinzy",
    is_external_link: (initialValues as any)?.is_external_link || false,
    external_link: (initialValues as any)?.external_link || "",
    auto_matchmaking_enabled: (initialValues as any)?.auto_matchmaking_enabled !== false,
    messaging_preferences: (initialValues as any)?.messaging_preferences || "both",
    skills_must_have: Array.isArray((initialValues as any)?.skills_must_have)
      ? ((initialValues as any).skills_must_have as string[])
        : [],
    skills_good_to_have: Array.isArray((initialValues as any)?.skills_good_to_have) ? ((initialValues as any).skills_good_to_have as string[]) : [],
    education_min: (initialValues as any)?.education_min || "",
    experience_min_years: typeof (initialValues as any)?.experience_min_years === "number" ? (initialValues as any).experience_min_years : 0,
    experience_max_years: typeof (initialValues as any)?.experience_max_years === "number" ? (initialValues as any).experience_max_years : 0,
    languages_required: Array.isArray((initialValues as any)?.languages_required) ? ((initialValues as any).languages_required as string[]) : [],
    english_level: (initialValues as any)?.english_level || "",
    license_type: (initialValues as any)?.license_type || "",
    age_min: typeof (initialValues as any)?.age_min === "number" ? (initialValues as any).age_min : 0,
    age_max: typeof (initialValues as any)?.age_max === "number" ? (initialValues as any).age_max : 0,
    gender_preference: (initialValues as any)?.gender_preference || "",
    role_category: (initialValues as any)?.role_category || "",
    department_category: (initialValues as any)?.department_category || "",
  })
  const [internalOpen, setInternalOpen] = useState(false)
  const [industryOpen, setIndustryOpen] = useState(false)
  const [generateHintOpen, setGenerateHintOpen] = useState(false)
  const [outreachProgressOpen, setOutreachProgressOpen] = useState(false)
  const [outreachProgressTitle, setOutreachProgressTitle] = useState<string>("")
  const [outreachProgressDetail, setOutreachProgressDetail] = useState<string>("")
  const [outreachProgressJobId, setOutreachProgressJobId] = useState<string>("")
  const [outreachProgressCounts, setOutreachProgressCounts] = useState<{ email: number; whatsapp: number; total: number } | null>(null)
  const [outreachProgressError, setOutreachProgressError] = useState<string | null>(null)
  const [minRequirements, setMinRequirements] = useState("")
  const [mustSkillInput, setMustSkillInput] = useState("")
  const [goodSkillInput, setGoodSkillInput] = useState("")

  const mustSkills = useMemo(() => {
    return Array.from(new Set((formData.skills_must_have || []).map((s) => String(s || "").trim()).filter(Boolean)))
  }, [formData.skills_must_have])

  const goodSkills = useMemo(() => {
    return Array.from(new Set((formData.skills_good_to_have || []).map((s) => String(s || "").trim()).filter(Boolean)))
  }, [formData.skills_good_to_have])

  const filteredMustSkillSuggestions = useMemo(() => {
    const q = mustSkillInput.trim().toLowerCase()
    if (!q) return []
    const existing = new Set(mustSkills.map((s) => s.toLowerCase()))
    const dynamic = [
      ...(SKILL_SUGGESTIONS_BY_SUBCATEGORY[formData.sub_category] || []),
      ...BASE_SKILL_SUGGESTIONS
    ]
    const unique = Array.from(new Set(dynamic.map((s) => s.trim()).filter(Boolean)))
    return unique.filter((s) => s.toLowerCase().includes(q) && !existing.has(s.toLowerCase())).slice(0, 8)
  }, [mustSkillInput, mustSkills, formData.sub_category])

  const filteredGoodSkillSuggestions = useMemo(() => {
    const q = goodSkillInput.trim().toLowerCase()
    if (!q) return []
    const existing = new Set([...mustSkills, ...goodSkills].map((s) => s.toLowerCase()))
    const dynamic = [
      ...(SKILL_SUGGESTIONS_BY_SUBCATEGORY[formData.sub_category] || []),
      ...BASE_SKILL_SUGGESTIONS
    ]
    const unique = Array.from(new Set(dynamic.map((s) => s.trim()).filter(Boolean)))
    return unique.filter((s) => s.toLowerCase().includes(q) && !existing.has(s.toLowerCase())).slice(0, 8)
  }, [goodSkillInput, mustSkills, goodSkills, formData.sub_category])

  const suggestedSkills = useMemo(() => {
    const existing = new Set([...mustSkills, ...goodSkills].map((s) => s.toLowerCase()))
    const dynamic = [
      ...(SKILL_SUGGESTIONS_BY_SUBCATEGORY[formData.sub_category] || []),
      ...BASE_SKILL_SUGGESTIONS
    ]
    const unique = Array.from(new Set(dynamic.map((s) => s.trim()).filter(Boolean)))
    return unique.filter((s) => !existing.has(s.toLowerCase())).slice(0, 10)
  }, [formData.sub_category, mustSkills, goodSkills])

  const addMustSkill = (value: string) => {
    const v = value.trim()
    if (!v) return
    const existing = new Set([...mustSkills, ...goodSkills].map((s) => s.toLowerCase()))
    if (existing.has(v.toLowerCase())) return
    const next = [...mustSkills, v]
    setFormData({ ...formData, skills_must_have: next })
    setMustSkillInput("")
  }

  const addGoodSkill = (value: string) => {
    const v = value.trim()
    if (!v) return
    const existing = new Set([...mustSkills, ...goodSkills].map((s) => s.toLowerCase()))
    if (existing.has(v.toLowerCase())) return
    const next = [...goodSkills, v]
    setFormData({ ...formData, skills_good_to_have: next })
    setGoodSkillInput("")
  }

  const removeMustSkill = (value: string) => {
    const next = mustSkills.filter((s) => s !== value)
    setFormData({ ...formData, skills_must_have: next })
  }

  const removeGoodSkill = (value: string) => {
    const next = goodSkills.filter((s) => s !== value)
    setFormData({ ...formData, skills_good_to_have: next })
  }

  const toggleLanguage = (value: string) => {
    const current = Array.isArray(formData.languages_required) ? formData.languages_required : []
    const exists = current.includes(value)
    const next = exists ? current.filter((v) => v !== value) : [...current, value]
    setFormData({ ...formData, languages_required: next })
  }

  // Handle controlled vs uncontrolled state
  const isOpen = open !== undefined ? open : internalOpen
  const setIsOpen = onOpenChange || setInternalOpen

  useEffect(() => {
    if (initialValues) {
      setFormData({
        title: initialValues.title || "",
        industry: initialValues.industry || "",
        sub_category: (initialValues as any)?.sub_category || "",
        location: initialValues.location || "",
        employment_type: (initialValues as any)?.employment_type || "full_time",
        shift_type: (initialValues as any)?.shift_type || "day",
        urgency_tag: (initialValues as any)?.urgency_tag || "",
        city: (initialValues as any)?.city || "",
        salary_type: (initialValues as any)?.salary_type || "monthly",
        salary_min: typeof (initialValues as any)?.salary_min === "number" ? (initialValues as any).salary_min : 0,
        salary_max: typeof (initialValues as any)?.salary_max === "number" ? (initialValues as any).salary_max : 0,
        description: initialValues.description || "",
        openings: (initialValues as any)?.openings ?? 1,
        client_name: initialValues.client_name || "",
        client_id: (initialValues as any)?.client_id || "",
        apply_type: (initialValues as any)?.apply_type || "in_platform",
        external_apply_url: (initialValues as any)?.external_apply_url || "",
        source: (initialValues as any)?.source || "truckinzy",
        is_external_link: (initialValues as any)?.is_external_link || false,
        external_link: (initialValues as any)?.external_link || "",
        auto_matchmaking_enabled: (initialValues as any)?.auto_matchmaking_enabled !== false,
        messaging_preferences: (initialValues as any)?.messaging_preferences || "both",
        skills_must_have: Array.isArray((initialValues as any)?.skills_must_have) ? ((initialValues as any).skills_must_have as string[]) : [],
        skills_good_to_have: Array.isArray((initialValues as any)?.skills_good_to_have) ? ((initialValues as any).skills_good_to_have as string[]) : [],
        education_min: (initialValues as any)?.education_min || "",
        experience_min_years: typeof (initialValues as any)?.experience_min_years === "number" ? (initialValues as any).experience_min_years : 0,
        experience_max_years: typeof (initialValues as any)?.experience_max_years === "number" ? (initialValues as any).experience_max_years : 0,
        languages_required: Array.isArray((initialValues as any)?.languages_required) ? ((initialValues as any).languages_required as string[]) : [],
        english_level: (initialValues as any)?.english_level || "",
        license_type: (initialValues as any)?.license_type || "",
        age_min: typeof (initialValues as any)?.age_min === "number" ? (initialValues as any).age_min : 0,
        age_max: typeof (initialValues as any)?.age_max === "number" ? (initialValues as any).age_max : 0,
        gender_preference: (initialValues as any)?.gender_preference || "",
        role_category: (initialValues as any)?.role_category || "",
        department_category: (initialValues as any)?.department_category || "",
      })
    }
  }, [initialValues, isOpen])

  useEffect(() => {
    if (!isOpen) return
    fetch("/api/clients")
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        setClients(Array.isArray(data) ? data.map((c: any) => ({ id: c.id, name: c.name, slug: c.slug })) : [])
      })
      .catch(() => setClients([]))
  }, [isOpen])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (formData.apply_type === "external" && !String(formData.external_apply_url || "").trim()) {
      toast({
        title: "External URL required",
        description: "Add the company apply link for external jobs.",
        variant: "destructive",
      })
      return
    }

    setLoading(true)

    try {
      const optional = (value: string) => {
        const trimmed = value.trim()
        return trimmed.length ? trimmed : null
      }
      const employmentTypeLabel =
        formData.employment_type === "full_time"
          ? "Full-time"
          : formData.employment_type === "part_time"
            ? "Part-time"
            : formData.employment_type === "contract"
              ? "Contract"
              : "Full-time"

      const sections = [
        {
          section_key: "about_role",
          heading: "About the role",
          body_md: String(formData.description || "").trim(),
          sort_order: 0,
          is_visible: true,
        },
      ].filter((s) => String(s.body_md || "").trim().length)

      const payload = {
        title: formData.title,
        client_name: optional(formData.client_name),
        client_id: optional(formData.client_id),
        apply_type: formData.apply_type === "external" ? "external" : "in_platform",
        external_apply_url: formData.apply_type === "external" ? optional(formData.external_apply_url) : null,
        source: formData.source,
        is_external_link: formData.is_external_link,
        external_link: formData.is_external_link ? optional(formData.external_link) : null,
        auto_matchmaking_enabled: formData.auto_matchmaking_enabled,
        messaging_preferences: formData.messaging_preferences,
        industry: optional(formData.industry),
        sub_category: optional(formData.sub_category),
        location: formData.location,
        city: optional(formData.city),
        employment_type: optional(formData.employment_type) || "full_time",
        shift_type: optional(formData.shift_type) || "day",
        urgency_tag: optional(formData.urgency_tag),
        openings: formData.openings,
        salary_type: optional(formData.salary_type),
        salary_min: formData.salary_min,
        salary_max: formData.salary_max,
        education_min: optional(formData.education_min),
        experience_min_years: formData.experience_min_years,
        experience_max_years: formData.experience_max_years,
        languages_required: formData.languages_required,
        english_level: optional(formData.english_level),
        license_type: optional(formData.license_type),
        age_min: formData.age_min,
        age_max: formData.age_max,
        gender_preference: optional(formData.gender_preference),
        role_category: optional(formData.role_category),
        department_category: optional(formData.department_category),
        skills_must_have: mustSkills,
        skills_good_to_have: goodSkills,
        description: formData.description,
        sections,
      }

      const url = jobId ? `/api/jobs/${jobId}` : "/api/jobs"
      const method = jobId ? "PUT" : "POST"
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })

      const created = await res.json().catch(() => null)
      if (!res.ok) throw new Error(created?.error || "Failed to create job")

      toast({
        title: "Success",
        description: jobId ? "Job updated successfully" : "Job created successfully",
      })

      const createdJobId = String(created?.id || "")
      const shouldAutoOutreach = !jobId && !formData.is_external_link && formData.auto_matchmaking_enabled && (formData.messaging_preferences === "email" || formData.messaging_preferences === "whatsapp" || formData.messaging_preferences === "both")
      const pref = formData.messaging_preferences

      setIsOpen(false)
      onJobCreated()

      if (shouldAutoOutreach && createdJobId) {
        setOutreachProgressOpen(true)
        setOutreachProgressJobId(createdJobId)
        setOutreachProgressCounts(null)
        setOutreachProgressError(null)
        setOutreachProgressTitle("Finding relevant candidates")
        setOutreachProgressDetail("Preparing to send outreach messages…")

        try {
          setOutreachProgressTitle("Preparing messages")
          const outRes = await fetch(`/api/jobs/${createdJobId}/outreach`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jobId: createdJobId,
              messagingPreference: pref,
              autoMatchmaking: true,
            })
          })

          const outData = await outRes.json().catch(() => null)
          if (!outRes.ok) throw new Error(outData?.error || "Failed to send outreach")

          const emailCount = Number(outData?.sent_by_channel?.email || 0)
          const whatsappCount = Number(outData?.sent_by_channel?.whatsapp || 0)
          const total = Number(outData?.messages_sent || emailCount + whatsappCount || 0)

          setOutreachProgressCounts({ email: emailCount, whatsapp: whatsappCount, total })
          setOutreachProgressTitle("Outreach completed")
          setOutreachProgressDetail(`Sent ${total} messages (${emailCount} email, ${whatsappCount} WhatsApp).`)
        } catch (e: any) {
          setOutreachProgressTitle("Outreach failed")
          setOutreachProgressDetail("Could not send outreach messages.")
          setOutreachProgressError(e?.message || "Failed")
        }
      }

      setFormData({
        title: "",
        industry: "",
        sub_category: "",
        location: "",
        employment_type: "full_time",
        shift_type: "day",
        urgency_tag: "",
        city: "",
        salary_type: "monthly",
        salary_min: 0,
        salary_max: 0,
        description: "",
        openings: 1,
        client_name: "",
        client_id: "",
        apply_type: "in_platform",
        external_apply_url: "",
        source: "truckinzy",
        is_external_link: false,
        external_link: "",
        auto_matchmaking_enabled: true,
        messaging_preferences: "both",
        skills_must_have: [],
        skills_good_to_have: [],
        education_min: "",
        experience_min_years: 0,
        experience_max_years: 0,
        languages_required: [],
        english_level: "",
        license_type: "",
        age_min: 0,
        age_max: 0,
        gender_preference: "",
        role_category: "",
        department_category: "",
      })
    } catch (error) {
      toast({
        title: "Error",
        description: jobId ? "Failed to update job" : "Failed to create job",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  const INDUSTRY_OPTIONS = [
    "Logistics",
    "Transportation",
    "Warehousing",
    "Supply Chain",
    "Freight Forwarding",
    "3PL / 4PL",
    "Last-mile Delivery",
    "Line Haul",
    "E-commerce Logistics",
    "Cold Chain",
    "Manufacturing",
    "Retail",
    "FMCG",
    "Automotive",
    "Construction",
    "Healthcare",
    "Technology",
    "Finance",
  ]

  const generateJD = async () => {
    try {
      setLoading(true)
      const res = await fetch("/api/generate-jd", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customInputs: {
            jobTitle: formData.title,
            industry: formData.industry,
            subCategory: formData.sub_category,
            location: formData.location,
            type: formData.employment_type,
            skillsRequired: mustSkills,
            additionalRequirements: minRequirements
          }
        })
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || "Failed to generate JD")

      const jd = data?.jobDescription || data
      const responsibilities = Array.isArray(jd?.responsibilities) ? jd.responsibilities : []
      const requirements = Array.isArray(jd?.requirements) ? jd.requirements : []
      const skills = Array.isArray(jd?.skills) ? jd.skills : []

      const formattedDescription = [
        jd?.description || "",
        responsibilities.length ? "\n### Key Responsibilities\n" + responsibilities.map((r: string) => `• ${r}`).join("\n") : "",
      ]
        .filter((x) => typeof x === "string" && x.trim().length)
        .join("\n")

      setFormData((prev) => ({
        ...prev,
        description: formattedDescription,
        skills_must_have: Array.from(new Set([...(prev.skills_must_have || []), ...skills.map((s: string) => String(s || "")).filter(Boolean)])),
      }))

      setGenerateHintOpen(false)
      toast({ title: "Generated JD", description: "Job description generated (no benefits section)." })
    } catch (error: any) {
      toast({ title: "Generation failed", description: error.message, variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="w-[95vw] sm:max-w-[900px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{jobId ? "Edit Job Opening" : "Create Job Opening"}</DialogTitle>
          <DialogDescription>
            {jobId ? "Update job opening details and requirements." : "Post a new job opening to track applicants."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="title">Job Title</Label>
              <Input
                id="title"
                required
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Industry</Label>
              <Button type="button" variant="outline" className="w-full justify-start" onClick={() => setIndustryOpen(true)}>
                {formData.industry ? formData.industry : "Select or type industry"}
              </Button>
              <UiDialog open={industryOpen} onOpenChange={setIndustryOpen}>
                <UiDialogContent className="sm:max-w-[420px]">
                  <UiDialogHeader>
                    <UiDialogTitle>Select Industry</UiDialogTitle>
                  </UiDialogHeader>
                  <Command>
                    <CommandInput placeholder="Search industry..." />
                    <CommandList>
                      <CommandEmpty>
                        <div className="space-y-3">
                          <div>No results.</div>
                          <div className="flex gap-2">
                            <Input
                              placeholder="Create new industry"
                              value={formData.industry}
                              onChange={(e) => setFormData({ ...formData, industry: e.target.value })}
                            />
                            <Button
                              onClick={() => setIndustryOpen(false)}
                            >
                              Use
                            </Button>
                          </div>
                        </div>
                      </CommandEmpty>
                      <CommandGroup heading="Suggestions">
                        {INDUSTRY_OPTIONS.map((opt) => (
                          <CommandItem key={opt} onSelect={() => { setFormData({ ...formData, industry: opt }); setIndustryOpen(false) }}>
                            {opt}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </UiDialogContent>
              </UiDialog>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="sub_category">Sub-category</Label>
              <Select value={formData.sub_category} onValueChange={(val) => setFormData({ ...formData, sub_category: val })}>
                <SelectTrigger>
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  {SUB_CATEGORY_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
            <Label htmlFor="location">Job location</Label>
            <Input
              id="location"
              value={formData.location}
              placeholder="e.g. Bhiwandi, Manesar, Sriperumbudur"
              onChange={(e) => setFormData({ ...formData, location: e.target.value })}
            />
          </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="city">City (optional)</Label>
            <Input id="city" value={formData.city} onChange={(e) => setFormData({ ...formData, city: e.target.value })} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="employment_type">Employment type</Label>
              <Select value={formData.employment_type} onValueChange={(val) => setFormData({ ...formData, employment_type: val })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="full_time">Full-time</SelectItem>
                  <SelectItem value="part_time">Part-time</SelectItem>
                  <SelectItem value="contract">Contract</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="shift_type">Shift type</Label>
              <Select value={formData.shift_type} onValueChange={(val) => setFormData({ ...formData, shift_type: val })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="day">Day</SelectItem>
                  <SelectItem value="night">Night</SelectItem>
                  <SelectItem value="rotational">Rotational</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="urgency_tag">Urgency tag</Label>
              <Select
                value={formData.urgency_tag ? formData.urgency_tag : "__none__"}
                onValueChange={(val) => setFormData({ ...formData, urgency_tag: val === "__none__" ? "" : val })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None</SelectItem>
                  <SelectItem value="urgently_hiring">Urgently Hiring</SelectItem>
                  <SelectItem value="immediate_joining">Immediate Joining</SelectItem>
                  <SelectItem value="limited_openings">Limited Openings</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="openings">Number of openings</Label>
              <Input
                id="openings"
                type="number"
                min={1}
                value={formData.openings}
                onChange={(e) => setFormData({ ...formData, openings: parseInt(e.target.value || "1", 10) })}
              />
            </div>
          </div>

          <div className="grid grid-cols-12 gap-4">
            <div className="col-span-4 space-y-2">
              <Label htmlFor="salary_type">Salary type</Label>
              <Select value={formData.salary_type} onValueChange={(val) => setFormData({ ...formData, salary_type: val })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="annual">Annual</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="per_trip">Per Trip</SelectItem>
                  <SelectItem value="hourly">Hourly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-4 space-y-2">
              <Label htmlFor="salary_min">Min amount</Label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-muted-foreground">₹</span>
                <Input
                  id="salary_min"
                  inputMode="numeric"
                  placeholder="e.g. 25,000"
                  className="pl-7"
                  value={formatMoneyIN(formData.salary_min)}
                  onChange={(e) => setFormData({ ...formData, salary_min: parseMoneyIN(e.target.value) })}
                />
              </div>
            </div>
            <div className="col-span-4 space-y-2">
              <Label htmlFor="salary_max">Max amount</Label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-muted-foreground">₹</span>
                <Input
                  id="salary_max"
                  inputMode="numeric"
                  placeholder="e.g. 35,000"
                  className="pl-7"
                  value={formatMoneyIN(formData.salary_max)}
                  onChange={(e) => setFormData({ ...formData, salary_max: parseMoneyIN(e.target.value) })}
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Client</Label>
              <Button type="button" variant="outline" className="w-full justify-start" onClick={() => setClientOpen(true)}>
                {formData.client_name ? formData.client_name : "Select client"}
              </Button>
              <UiDialog open={clientOpen} onOpenChange={setClientOpen}>
                <UiDialogContent className="sm:max-w-[420px]">
                  <UiDialogHeader>
                    <UiDialogTitle>Select client</UiDialogTitle>
                  </UiDialogHeader>
                  <Command>
                    <CommandInput placeholder="Search client..." />
                    <CommandList>
                      <CommandEmpty>No clients found.</CommandEmpty>
                      <CommandGroup heading="Clients">
                        {clients.map((c) => (
                          <CommandItem
                            key={c.id}
                            onSelect={() => {
                              setFormData({ ...formData, client_id: c.id, client_name: c.name })
                              setClientOpen(false)
                            }}
                          >
                            {c.name}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </UiDialogContent>
              </UiDialog>
            </div>
          </div>

          <div className="rounded-xl border bg-muted/30 p-4">
            <div className="text-sm font-semibold mb-4">Application & Outreach Settings</div>
            
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div className="space-y-2">
                <Label>Job Source</Label>
                <Select value={formData.source} onValueChange={(val) => setFormData({ ...formData, source: val })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="truckinzy">Truckinzy Side</SelectItem>
                    <SelectItem value="employee">Employee Side</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Where this job posting originates from</p>
              </div>
              <div className="space-y-2">
                <Label>Apply Method</Label>
                <Select value={formData.apply_type} onValueChange={(val) => setFormData({ ...formData, apply_type: val })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="in_platform">Apply on GatiHire</SelectItem>
                    <SelectItem value="external">External Company Site</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">How candidates will apply to this job</p>
              </div>
            </div>

            {formData.apply_type === "external" && (
              <div className="space-y-2 mb-4 p-3 bg-blue-50 rounded-lg border border-blue-200">
                <Label htmlFor="external_apply_url" className="text-blue-900">External Application URL</Label>
                <Input
                  id="external_apply_url"
                  value={formData.external_apply_url}
                  placeholder="https://company.com/careers/job-id"
                  onChange={(e) => setFormData({ ...formData, external_apply_url: e.target.value })}
                  className="border-blue-200 focus:ring-blue-500"
                />
                <p className="text-xs text-blue-700">Candidates will be redirected to this URL to complete their application</p>
              </div>
            )}

            <div className="space-y-4 border-t pt-4">
              <div className="p-3 bg-amber-50 rounded-lg border border-amber-200">
                <div className="flex items-start space-x-3">
                  <Checkbox
                    id="is_external_link"
                    checked={formData.is_external_link}
                    onCheckedChange={(checked) => setFormData({ ...formData, is_external_link: checked as boolean })}
                    className="mt-1"
                  />
                  <div className="flex-1">
                    <Label htmlFor="is_external_link" className="font-medium text-amber-900">External Link Job (No outreach/matchmaking)</Label>
                    <p className="text-xs text-amber-700 mt-1">Enable this for jobs that should not have candidate outreach or matchmaking. These jobs will be listed as external opportunities only.</p>
                  </div>
                </div>
                
                {formData.is_external_link && (
                  <div className="mt-3 space-y-2 ml-6">
                    <Label htmlFor="external_link" className="text-amber-900">External Job Posting URL</Label>
                    <Input
                      id="external_link"
                      value={formData.external_link}
                      placeholder="https://external-company.com/job-posting"
                      onChange={(e) => setFormData({ ...formData, external_link: e.target.value })}
                      className="border-amber-200 focus:ring-amber-500"
                    />
                    <p className="text-xs text-amber-700">The actual job posting URL on the external company's website</p>
                  </div>
                )}
              </div>

              {!formData.is_external_link && (
                <div className="grid grid-cols-2 gap-4 p-3 bg-green-50 rounded-lg border border-green-200">
                  <div className="space-y-2">
                    <Label className="text-green-900">Messaging Preferences</Label>
                    <Select value={formData.messaging_preferences} onValueChange={(val) => setFormData({ ...formData, messaging_preferences: val })}>
                      <SelectTrigger className="border-green-200">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="both">Email + WhatsApp</SelectItem>
                        <SelectItem value="email">Email Only</SelectItem>
                        <SelectItem value="whatsapp">WhatsApp Only</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-green-700">How to reach out to matched candidates</p>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-green-900">Auto Matchmaking</Label>
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="auto_matchmaking_enabled"
                        checked={formData.auto_matchmaking_enabled}
                        onCheckedChange={(checked) => setFormData({ ...formData, auto_matchmaking_enabled: checked as boolean })}
                      />
                      <Label htmlFor="auto_matchmaking_enabled" className="text-green-900">Enable automatic candidate matching</Label>
                    </div>
                    <p className="text-xs text-green-700">Automatically find and outreach to relevant candidates</p>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Skills (Must have)</Label>
            <div className="rounded-lg border p-3">
              <div className="flex flex-wrap gap-2">
                {mustSkills.map((s) => (
                  <button key={s} type="button" onClick={() => removeMustSkill(s)} className="rounded-full border bg-muted px-3 py-1 text-xs hover:bg-muted/70" title="Remove">
                    {s} ×
                  </button>
                ))}
              </div>
              {suggestedSkills.length ? (
                <div className="mt-3">
                  <div className="text-xs font-medium text-muted-foreground">Suggested</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {suggestedSkills.map((s) => (
                      <button key={s} type="button" onClick={() => addMustSkill(s)} className="rounded-full border bg-card px-3 py-1 text-xs hover:bg-accent">
                        + {s}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="mt-3">
                <Input
                  value={mustSkillInput}
                  onChange={(e) => setMustSkillInput(e.target.value)}
                  placeholder="e.g. Warehouse Mgmt, Excel, Tally (Type & Enter)"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      addMustSkill(mustSkillInput)
                    }
                  }}
                />
                {filteredMustSkillSuggestions.length ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {filteredMustSkillSuggestions.map((s) => (
                      <button key={s} type="button" onClick={() => addMustSkill(s)} className="rounded-full border bg-card px-3 py-1 text-xs hover:bg-accent">
                        + {s}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Skills (Good to have)</Label>
            <div className="rounded-lg border p-3">
              <div className="flex flex-wrap gap-2">
                {goodSkills.map((s) => (
                  <button key={s} type="button" onClick={() => removeGoodSkill(s)} className="rounded-full border bg-muted px-3 py-1 text-xs hover:bg-muted/70" title="Remove">
                    {s} ×
                  </button>
                ))}
              </div>
              <div className="mt-3">
                <Input
                  value={goodSkillInput}
                  onChange={(e) => setGoodSkillInput(e.target.value)}
                  placeholder="Type a skill and press Enter"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      addGoodSkill(goodSkillInput)
                    }
                  }}
                />
                {filteredGoodSkillSuggestions.length ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {filteredGoodSkillSuggestions.map((s) => (
                      <button key={s} type="button" onClick={() => addGoodSkill(s)} className="rounded-full border bg-card px-3 py-1 text-xs hover:bg-accent">
                        + {s}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="rounded-xl border bg-muted/30 p-4">
            <div className="text-sm font-semibold">Requirements matrix</div>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Minimum education</Label>
                <Select
                  value={formData.education_min ? formData.education_min : "__none__"}
                  onValueChange={(val) => setFormData({ ...formData, education_min: val === "__none__" ? "" : val })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Not set</SelectItem>
                    {EDUCATION_MIN_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Experience range (years)</Label>
                <div className="grid grid-cols-2 gap-3">
                  <Input type="number" min={0} value={formData.experience_min_years} onChange={(e) => setFormData({ ...formData, experience_min_years: parseInt(e.target.value || "0", 10) })} />
                  <Input type="number" min={0} value={formData.experience_max_years} onChange={(e) => setFormData({ ...formData, experience_max_years: parseInt(e.target.value || "0", 10) })} />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Languages required</Label>
                <div className="grid grid-cols-2 gap-2 rounded-lg border bg-card p-3">
                  {LANGUAGE_OPTIONS.map((l) => {
                    const checked = formData.languages_required.includes(l)
                    return (
                      <label key={l} className="flex items-center gap-2 text-sm">
                        <Checkbox checked={checked} onCheckedChange={() => toggleLanguage(l)} />
                        <span>{l}</span>
                      </label>
                    )
                  })}
                </div>
              </div>

              <div className="space-y-2">
                <Label>English level</Label>
                <Select
                  value={formData.english_level ? formData.english_level : "__none__"}
                  onValueChange={(val) => setFormData({ ...formData, english_level: val === "__none__" ? "" : val })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Not set</SelectItem>
                    {ENGLISH_LEVEL_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>License type</Label>
                <Select
                  value={formData.license_type ? formData.license_type : "__none__"}
                  onValueChange={(val) => setFormData({ ...formData, license_type: val === "__none__" ? "" : val })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Not set</SelectItem>
                    {LICENSE_TYPE_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Age range</Label>
                <div className="grid grid-cols-2 gap-3">
                  <Input type="number" min={0} value={formData.age_min} onChange={(e) => setFormData({ ...formData, age_min: parseInt(e.target.value || "0", 10) })} />
                  <Input type="number" min={0} value={formData.age_max} onChange={(e) => setFormData({ ...formData, age_max: parseInt(e.target.value || "0", 10) })} />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Gender preference</Label>
                <Select
                  value={formData.gender_preference ? formData.gender_preference : "__none__"}
                  onValueChange={(val) => setFormData({ ...formData, gender_preference: val === "__none__" ? "" : val })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Not set</SelectItem>
                    {GENDER_PREFERENCE_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <div className="rounded-xl border bg-muted/30 p-4">
            <div className="text-sm font-semibold">Job classification</div>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Role category</Label>
                <Select
                  value={formData.role_category ? formData.role_category : "__none__"}
                  onValueChange={(val) => setFormData({ ...formData, role_category: val === "__none__" ? "" : val })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Not set</SelectItem>
                    {ROLE_CATEGORY_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Department</Label>
                <Select
                  value={formData.department_category ? formData.department_category : "__none__"}
                  onValueChange={(val) => setFormData({ ...formData, department_category: val === "__none__" ? "" : val })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Not set</SelectItem>
                    {DEPARTMENT_CATEGORY_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Job Description</Label>
            <div className="flex justify-between items-center mb-2">
              <span className="text-xs text-muted-foreground">Generate a relevant JD from title, subcategory and skills.</span>
              <Button type="button" variant="secondary" size="sm" onClick={() => setGenerateHintOpen(true)}>
                Generate with AI
              </Button>
            </div>
            <Textarea
              id="description"
              className="min-h-[200px]"
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder="Job description will appear here..."
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setIsOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {jobId ? "Update Job" : "Create Job"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
      
      
      <UiDialog open={generateHintOpen} onOpenChange={setGenerateHintOpen}>
        <UiDialogContent className="sm:max-w-[520px]">
          <UiDialogHeader>
            <UiDialogTitle>Generate JD with AI</UiDialogTitle>
          </UiDialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Add any must-haves (no benefits). Example: lanes, shift, tools, compliance, team size.
            </p>
            <Textarea
              placeholder="Optional: must-have requirements, constraints, tools"
              value={minRequirements}
              onChange={(e) => setMinRequirements(e.target.value)}
              className="min-h-[90px]"
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setGenerateHintOpen(false)}>
                Cancel
              </Button>
              <Button onClick={generateJD} disabled={loading}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Generate
              </Button>
            </div>
          </div>
        </UiDialogContent>
      </UiDialog>

      <UiDialog open={outreachProgressOpen} onOpenChange={setOutreachProgressOpen}>
        <UiDialogContent className="sm:max-w-[520px]">
          <UiDialogHeader>
            <UiDialogTitle>{outreachProgressTitle || "Outreach"}</UiDialogTitle>
          </UiDialogHeader>
          <div className="space-y-3">
            <div className="text-sm text-muted-foreground">{outreachProgressDetail}</div>
            {!outreachProgressCounts && !outreachProgressError ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Working…
              </div>
            ) : null}
            {outreachProgressCounts ? (
              <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                <div>Total sent: {outreachProgressCounts.total}</div>
                <div>Email: {outreachProgressCounts.email}</div>
                <div>WhatsApp: {outreachProgressCounts.whatsapp}</div>
              </div>
            ) : null}
            {outreachProgressError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{outreachProgressError}</div>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setOutreachProgressOpen(false)}>
                Close
              </Button>
              {outreachProgressJobId ? (
                <Button
                  onClick={() => {
                    setOutreachProgressOpen(false)
                    window.open(`/jobs/${outreachProgressJobId}/outreach`, "_blank")
                  }}
                >
                  View Dashboard
                </Button>
              ) : null}
            </div>
          </div>
        </UiDialogContent>
      </UiDialog>
    </Dialog>
  )
}
