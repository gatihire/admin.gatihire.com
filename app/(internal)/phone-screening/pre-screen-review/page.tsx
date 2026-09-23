import { supabaseAdmin } from "@/lib/supabase"
import { getServerInternalPermissions } from "@/lib/server-internal-permissions"
import { redirect } from "next/navigation"

interface Candidate {
  id: string
  name: string
  phone: string
  email: string
}

interface Job {
  id: string
  title: string
  client_name: string
  salary_min?: number
  salary_max?: number
  experience_min_years?: number
  experience_max_years?: number
  city?: string
}

interface Participant {
  id: string
  status: string
  info_data: Record<string, any>
  screening_context: Record<string, any>
  created_at: string
  updated_at: string
  candidates: Candidate
  jobs: Job
}

async function getParticipants(): Promise<Participant[]> {
  const { data, error } = await supabaseAdmin
    .from("phone_screening_participants")
    .select(`
      id,
      status,
      info_data,
      screening_context,
      created_at,
      updated_at,
      candidates:candidate_id (id, name, phone, email),
      jobs:job_id (id, title, client_name, salary_min, salary_max, experience_min_years, experience_max_years, city)
    `)
    .eq("status", "pre_screen_review")
    .order("updated_at", { ascending: false })

  if (error) {
    console.error("Error fetching participants:", error)
    return []
  }
  return (data || []).map((p: any) => ({
    ...p,
    candidates: p.candidates?.[0] || { id: '', name: '', phone: '', email: '' },
    jobs: p.jobs?.[0] || { id: '', title: '', client_name: '' },
  }))
}

function getPreScreenResult(participant: Participant) {
  return participant.screening_context?.preScreenResult || null
}

function getCandidateInfo(infoData: Record<string, any>) {
  return {
    currentCtc: infoData.current_ctc ? `₹${infoData.current_ctc} LPA` : "—",
    expectedCtc: infoData.expected_ctc ? `₹${infoData.expected_ctc} LPA` : "—",
    noticePeriod: infoData.notice_period ? `${infoData.notice_period} days` : "—",
    experience: infoData.total_experience ? `${infoData.total_experience} years` : "—",
    currentLocation: infoData.current_location || "—",
    preferredLocation: infoData.preferred_location || "—",
    reasonForChange: infoData.reason_for_change || "—",
  }
}

export default async function PreScreenReviewPage() {
  const { isSuperAdmin, permissionKeys } = await getServerInternalPermissions()
  const hasPermission = (key: string) => isSuperAdmin || permissionKeys.has(key)

  if (!hasPermission("applications.manage")) {
    redirect("/dashboard")
  }

  const participants = await getParticipants()

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Pre-Screen Review</h1>
        <span className="px-3 py-1 bg-yellow-100 text-yellow-800 text-sm font-medium rounded-full">
          {participants.length} pending
        </span>
      </div>

      {participants.length === 0 ? (
        <div className="p-12 text-center text-gray-500">
          <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="mt-4 text-lg">No candidates pending pre-screen review</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Candidate</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Job</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Info Provided</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Pre-Screen Result</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {participants.map((participant) => {
                const preScreenResult = getPreScreenResult(participant)
                const info = getCandidateInfo(participant.info_data || {})

                return (
                  <tr key={participant.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4">
                      <div>
                        <p className="font-medium text-gray-900">{participant.candidates?.name}</p>
                        <p className="text-sm text-gray-500">{participant.candidates?.phone}</p>
                        <p className="text-sm text-gray-500">{participant.candidates?.email}</p>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <p className="font-medium text-gray-900">{participant.jobs?.title}</p>
                      <p className="text-sm text-gray-500">{participant.jobs?.client_name}</p>
                      <div className="mt-1 flex gap-2 text-xs text-gray-500">
                        {participant.jobs?.salary_min && participant.jobs?.salary_max && (
                          <span>₹{participant.jobs.salary_min}-{participant.jobs.salary_max} LPA</span>
                        )}
                        {participant.jobs?.experience_min_years && participant.jobs?.experience_max_years && (
                          <span>{participant.jobs.experience_min_years}-{participant.jobs.experience_max_years} yrs exp</span>
                        )}
                        {participant.jobs?.city && (
                          <span>{participant.jobs.city}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm">
                      <div className="space-y-1 max-w-xs">
                        <div className="flex justify-between">
                          <span className="text-gray-500">Current CTC:</span>
                          <span className="font-medium">{info.currentCtc}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-500">Expected CTC:</span>
                          <span className="font-medium">{info.expectedCtc}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-500">Notice:</span>
                          <span className="font-medium">{info.noticePeriod}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-500">Experience:</span>
                          <span className="font-medium">{info.experience}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-500">Current Loc:</span>
                          <span className="font-medium">{info.currentLocation}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-500">Preferred Loc:</span>
                          <span className="font-medium">{info.preferredLocation}</span>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      {preScreenResult ? (
                        <div className="space-y-2">
                          <div className={`px-2 py-1 rounded text-xs font-medium ${
                            preScreenResult.decision === "proceed" ? "bg-green-100 text-green-800" :
                            preScreenResult.decision === "needs_review" ? "bg-yellow-100 text-yellow-800" :
                            "bg-red-100 text-red-800"
                          }`}>
                            {preScreenResult.decision.replace("_", " ").toUpperCase()}
                          </div>
                          <p className="text-sm text-gray-600">{preScreenResult.summary}</p>
                          {preScreenResult.reasons && preScreenResult.reasons.length > 0 && (
                            <details className="text-xs text-gray-500">
                              <summary className="cursor-pointer hover:text-gray-700">View reasons</summary>
                              <ul className="mt-1 list-disc list-inside space-y-1">
                                {preScreenResult.reasons.map((reason: string, i: number) => (
                                  <li key={i}>{reason}</li>
                                ))}
                              </ul>
                            </details>
                          )}
                        </div>
                      ) : (
                        <span className="text-gray-400">No pre-screen data</span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <form action={`/api/phone-screening/participants/${participant.id}/pre-screen-review`} method="POST">
                        <select name="decision" className="w-full px-3 py-1 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-2">
                          <option value="">Select decision</option>
                          <option value="proceed">✅ Proceed to AI Call</option>
                          <option value="filter_out">❌ Filter Out</option>
                        </select>
                        <textarea name="note" placeholder="Optional note..." rows={2} className="w-full px-3 py-1 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-2" />
                        <button type="submit" className="w-full px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700">
                          Submit
                        </button>
                      </form>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}