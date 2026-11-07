import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '.env.local');
const env = fs.readFileSync(envPath,'utf8');
const cfg = {};
env.split('\n').forEach(line=>{
  line=line.trim();
  if(!line||line.startsWith('#'))return;
  const idx=line.indexOf('=');
  if(idx>0){
    const key=line.slice(0,idx).trim();
    let val=line.slice(idx+1).trim();
    if((val[0]==='"'&&val[val.length-1]==='"')||(val[0]==="'"&&val[val.length-1]==="'")){val=val.slice(1,-1);}
    cfg[key]=val;
  }
});

const { createClient } = await import('@supabase/supabase-js');
const { GoogleGenerativeAI } = await import('@google/generative-ai');

const supabaseAdmin = createClient(cfg.NEXT_PUBLIC_SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY);
const EMBEDDING_DIM = Number(cfg.EMBEDDING_DIM || 768);

async function embedWithGeminiRest(input, model) {
  const apiKey = cfg.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`;
  const makeBody = (includeDim) => {
    const body = { model: `models/${model}`, content: { parts: [{ text: input }] } };
    if (includeDim && Number.isFinite(EMBEDDING_DIM) && EMBEDDING_DIM > 0) {
      body.output_dimensionality = EMBEDDING_DIM;
    }
    return body;
  };
  const doRequest = async (body) => {
    const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json','x-goog-api-key':apiKey}, body: JSON.stringify(body) });
    const json = await res.json().catch(()=>null);
    if(!res.ok) throw new Error(json?.error?.message || res.statusText);
    const values = json?.embedding?.values || json?.embeddings?.[0]?.values || json?.data?.[0]?.embedding?.values || null;
    if(!Array.isArray(values)) throw new Error('no values');
    return values.map(v=>Number(v)).filter(v=>Number.isFinite(v));
  };
  try { return await doRequest(makeBody(true)); } catch(e) { try { return await doRequest(makeBody(false)); } catch(e2){ throw e2; } }
}

async function generateEmbedding(text) {
  const input = (text||'').trim().slice(0,8000);
  if(!input) return [];
  const models = [cfg.GEMINI_EMBEDDING_MODEL||'gemini-embedding-001','text-embedding-004','embedding-001'];
  for (const model of models) {
    try {
      let embedding = await embedWithGeminiRest(input, model);
      if (!embedding.length) continue;
      if (EMBEDDING_DIM>0) {
        if (embedding.length > EMBEDDING_DIM) embedding = embedding.slice(0, EMBEDDING_DIM);
        else if (embedding.length < EMBEDDING_DIM) embedding = [...embedding, ...Array(EMBEDDING_DIM - embedding.length).fill(0)];
      }
      return embedding;
    } catch(e) { continue; }
  }
  return [];
}

function listText(label, values) {
  const items = (Array.isArray(values) ? values : []).map((v) => String(v||"").trim()).filter(Boolean);
  if (!items.length) return "";
  return `${label}: ${items.join(", ")}`;
}
function buildResumeText(row) {
  const lines = [];
  const name = String(row?.name||"").trim();
  const currentRole = String(row?.current_role||"").trim();
  const desiredRole = String(row?.desired_role||"").trim();
  const location = String(row?.location||"").trim();
  const company = String(row?.current_company||"").trim();
  const summary = String(row?.summary||"").trim();
  const experience = String(row?.total_experience||"").trim();
  const qualification = String(row?.highest_qualification||"").trim();
  const degree = String(row?.degree||"").trim();
  const university = String(row?.university||"").trim();
  const workDuration = Array.isArray(row?.work_duration) ? row.work_duration : [];
  if (name) lines.push(`Name: ${name}`);
  if (currentRole) lines.push(`Current Role: ${currentRole}`);
  if (desiredRole) lines.push(`Desired Role: ${desiredRole}`);
  if (company) lines.push(`Company: ${company}`);
  if (location) lines.push(`Location: ${location}`);
  if (experience) lines.push(`Experience: ${experience}`);
  if (summary) lines.push(`Summary: ${summary}`);
  if (qualification || degree || university) {
    const eduParts = [qualification, degree, university].filter(Boolean).join(", ");
    lines.push(`Education: ${eduParts}`);
  }
  const skills = listText("Technical Skills", row?.technical_skills || []);
  if (skills) lines.push(skills);
  const softSkills = listText("Soft Skills", row?.soft_skills || []);
  if (softSkills) lines.push(softSkills);
  const certifications = listText("Certifications", row?.certifications || []);
  if (certifications) lines.push(certifications);
  const companies = listText("Previous Companies", row?.previous_companies || []);
  if (companies) lines.push(companies);
  const titles = listText("Job Titles", row?.job_titles || []);
  if (titles) lines.push(titles);
  const durations = listText("Work Duration", workDuration);
  if (durations) lines.push(durations);
  return lines.join("\n").trim();
}

async function run() {
  const { data: rowsNoText } = await supabaseAdmin
    .from('candidates')
    .select("id,name,current_role,desired_role,current_company,location,total_experience,summary,technical_skills,soft_skills,certifications,previous_companies,job_titles,work_duration,highest_qualification,degree,university,resume_text")
    .or("resume_text.is.null,resume_text.eq.");
  console.log('Missing resume text:', rowsNoText?.length);
  let rtUpdated = 0;
  for (const row of rowsNoText || []) {
    const resumeText = buildResumeText(row);
    if (resumeText.length < 50) continue;
    const { error } = await supabaseAdmin.from('candidates').update({ resume_text: resumeText, updated_at: new Date().toISOString() }).eq('id', row.id);
    if (!error) rtUpdated++;
  }
  console.log('Resume text updated:', rtUpdated);
  
  const { data: rowsNoEmb } = await supabaseAdmin
    .from('candidates')
    .select("id,resume_text,summary,current_role,desired_role,current_company,location")
    .is("embedding", null);
  console.log('Missing embeddings:', rowsNoEmb?.length);
  function buildEmbeddingInput(row) {
    const parts = [
      String(row?.current_role||"").trim(),
      String(row?.desired_role||"").trim(),
      String(row?.current_company||"").trim(),
      String(row?.location||"").trim(),
      String(row?.summary||"").trim(),
      String(row?.resume_text||"").trim(),
    ].filter(Boolean);
    return parts.join("\n");
  }
  let embUpdated = 0, embSkipped = 0, embFailed = 0;
  for (const row of rowsNoEmb || []) {
    const input = buildEmbeddingInput(row);
    if (input.length < 200) { embSkipped++; continue; }
    try {
      const embedding = await generateEmbedding(input);
      if (!Array.isArray(embedding) || embedding.length === 0) { embSkipped++; continue; }
      const { error } = await supabaseAdmin.from('candidates').update({ embedding, updated_at: new Date().toISOString() }).eq('id', row.id);
      if (error) { embFailed++; }
      else { embUpdated++; if (embUpdated % 25 === 0) console.log('Updated', embUpdated); }
    } catch (e) { embFailed++; }
  }
  console.log('Embeddings updated:', embUpdated, 'skipped:', embSkipped, 'failed:', embFailed);
}
run().catch(e=>{console.error(e);process.exit(1);});
