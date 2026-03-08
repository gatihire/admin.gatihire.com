import Link from "next/link"
import { notFound } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { ArrowLeft, MapPin, Briefcase, Clock, DollarSign, Calendar } from "lucide-react"
import { supabase } from "@/lib/supabase"
import { JobApplyWidget } from "@/components/board/JobApplyWidget"
import { BoardAnalytics } from "@/components/board/BoardAnalytics"

export const revalidate = 0

function formatEnum(value: any): string {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

interface JobPageProps {
  params: {
    id: string
  }
}

export default async function JobPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  const { data: job, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", id)
    .single()

  const { data: sections } = await supabase
    .from("job_sections")
    .select("section_key,heading,body_md,sort_order,is_visible")
    .eq("job_id", id)
    .order("sort_order", { ascending: true })

  if (error || !job) {
    notFound()
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-12">
      <BoardAnalytics jobId={id} />
      <header className="bg-white border-b sticky top-0 z-10">
        <div className="container mx-auto py-4 px-4 flex items-center justify-between">
            <Button variant="ghost" asChild>
              <Link href="/board" className="flex items-center gap-2 text-gray-600 hover:text-gray-900">
                <ArrowLeft className="h-4 w-4" />
                Back to Jobs
              </Link>
            </Button>
            <div className="hidden sm:block font-semibold text-gray-700">Truckinzy Careers</div>
        </div>
      </header>

      <main className="container mx-auto py-8 px-4">
        <div className="max-w-3xl mx-auto space-y-8">
          
          {/* Job Header */}
          <div className="bg-white rounded-xl p-8 shadow-sm border space-y-6">
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                {job.city ? <Badge variant="secondary" className="text-sm px-3 py-1">{job.city}</Badge> : null}
                {job.employment_type ? <Badge variant="outline" className="text-sm px-3 py-1">{formatEnum(job.employment_type)}</Badge> : null}
                {job.status !== 'open' && (
                    <Badge variant="destructive" className="text-sm px-3 py-1">Closed</Badge>
                )}
              </div>
              <h1 className="text-3xl sm:text-4xl font-extrabold text-gray-900 tracking-tight">{job.title}</h1>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-gray-600">
              <div className="flex items-center gap-2">
                <MapPin className="h-5 w-5 text-gray-400" />
                <span>{[job.city, job.location].filter(Boolean).join(", ")}</span>
              </div>
              <div className="flex items-center gap-2">
                <DollarSign className="h-5 w-5 text-gray-400" />
                <span>
                  {job.salary_min || job.salary_max
                    ? `INR ${String(job.salary_min || "").replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${job.salary_max ? ` - ${String(job.salary_max).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}` : ""}${job.salary_type ? ` / ${formatEnum(job.salary_type)}` : ""}`
                    : "Competitive Salary"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Clock className="h-5 w-5 text-gray-400" />
                <span>Posted {new Date(job.created_at).toLocaleDateString()}</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-8">
              {/* Description */}
              <section className="bg-white rounded-xl p-8 shadow-sm border space-y-4">
                <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                  <Briefcase className="h-5 w-5 text-blue-600" />
                  About the Role
                </h2>
                <div className="prose max-w-none text-gray-600 whitespace-pre-wrap leading-relaxed">
                  {(() => {
                    const about = Array.isArray(sections) ? sections.find((s: any) => s?.is_visible !== false && String(s?.section_key || "") === "about_role") : null
                    return about?.body_md || job.description
                  })()}
                </div>
              </section>

              {Array.isArray(sections) && sections.filter((s: any) => s?.is_visible !== false && String(s?.body_md || "").trim()).length ? (
                <div className="space-y-8">
                  {sections
                    .filter((s: any) => s?.is_visible !== false && String(s?.body_md || "").trim() && String(s?.section_key || "") !== "about_role")
                    .map((s: any) => (
                      <section key={s.section_key} className="bg-white rounded-xl p-8 shadow-sm border space-y-4">
                        <h2 className="text-xl font-bold text-gray-900">{s.heading}</h2>
                        <div className="prose max-w-none text-gray-600 whitespace-pre-wrap leading-relaxed">{s.body_md}</div>
                      </section>
                    ))}
                </div>
              ) : null}

              <section className="bg-white rounded-xl p-8 shadow-sm border space-y-4">
                <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                  <Calendar className="h-5 w-5 text-green-600" />
                  Job requirements
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-gray-700">
                  {job.experience_min_years || job.experience_max_years ? (
                    <div>
                      <div className="text-xs text-gray-500">Experience</div>
                      <div className="font-medium">{job.experience_min_years || 0} - {job.experience_max_years || 0} years</div>
                    </div>
                  ) : null}
                  {job.education_min ? (
                    <div>
                      <div className="text-xs text-gray-500">Education</div>
                      <div className="font-medium">{formatEnum(job.education_min)}</div>
                    </div>
                  ) : null}
                  {job.english_level ? (
                    <div>
                      <div className="text-xs text-gray-500">English level</div>
                      <div className="font-medium">{formatEnum(job.english_level)}</div>
                    </div>
                  ) : null}
                  {job.license_type ? (
                    <div>
                      <div className="text-xs text-gray-500">License</div>
                      <div className="font-medium">{formatEnum(job.license_type)}</div>
                    </div>
                  ) : null}
                  {job.age_min || job.age_max ? (
                    <div>
                      <div className="text-xs text-gray-500">Age limit</div>
                      <div className="font-medium">{job.age_min || ""}{job.age_max ? ` - ${job.age_max}` : ""}</div>
                    </div>
                  ) : null}
                  {job.gender_preference ? (
                    <div>
                      <div className="text-xs text-gray-500">Gender</div>
                      <div className="font-medium">{formatEnum(job.gender_preference)}</div>
                    </div>
                  ) : null}
                </div>
              </section>
            </div>

            <div className="lg:col-span-1">
              {/* Application Form Widget */}
              <div className="sticky top-24">
                <JobApplyWidget job={job as any} />
              </div>
            </div>
          </div>

        </div>
      </main>
    </div>
  )
}
