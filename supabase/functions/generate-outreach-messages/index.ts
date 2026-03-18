import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ============================================================================
// generate-outreach-messages v10
//
// COMPLETE REWRITE of the message generation engine.
//
// Key changes from v9:
// 1. System prompt rewritten with Solid Bio example as gold standard
// 2. Messages lead with SPECIFIC ASSET KNOWLEDGE, not generic recruiter talk
// 3. Connection request is a genuine compliment + why you're watching
// 4. Follow-up delivers VALUE FIRST — pipeline intel, not a sales pitch
// 5. Classification logic improved — stricter hiring manager matching
// 6. Quality control enforces specific data point usage
// ============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const OPENAI_MODEL = "gpt-4o";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function ok(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function err(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function daysAgo(dateStr: string | null): number {
  if (!dateStr) return 9999;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

function daysUntil(dateStr: string | null): number {
  if (!dateStr) return 9999;
  return Math.floor((new Date(dateStr).getTime() - Date.now()) / 86400000);
}

function extractFirstName(fullName: string): string {
  if (!fullName) return "there";
  let name = fullName.replace(/^(Dr\.|Prof\.|Mr\.|Ms\.|Mrs\.)\s*/i, "");
  name = name.replace(/,.*$/, "").trim();
  return name.split(" ")[0] || "there";
}

function computeTenureMonths(startDate: string | null): number | null {
  if (!startDate) return null;
  const start = new Date(startDate);
  const now = new Date();
  return Math.max(0, Math.round((now.getTime() - start.getTime()) / (30.44 * 86400000)));
}

type Classification = "HIRING_MANAGER" | "INFLUENCER" | "TALENT_PROSPECT";

interface MatchedJob {
  jobId: string;
  jobTitle: string;
  jobUrl: string | null;
  jobFunction: string;
  seniorityDiff: number;
  location: string | null;
  isEnriched: boolean;
  outreachHook: string | null;
}

interface RoleClassification {
  classification: Classification;
  roleCategory: string;
  reasoning: string;
  matchedJobTitle?: string;
  matchedJobFunction?: string;
  matchedJobs: MatchedJob[];
  isHiringManager: boolean;
  tenureMonths: number | null;
  tenureBand: "new" | "prime" | "established" | "unknown";
}

const SENIORITY_LEVELS: Record<string, number> = {
  "c-suite": 6, "cso": 6, "cmo": 6, "ceo": 6, "cfo": 6, "coo": 6,
  "svp": 5, "senior vice president": 5,
  "vp": 4, "vice president": 4,
  "head": 4,
  "executive director": 3.5,
  "senior director": 3,
  "director": 2.5,
  "associate director": 2,
  "senior manager": 1.5,
  "manager": 1,
};

function inferSeniority(title: string): number {
  const t = (title || "").toLowerCase();
  for (const [key, level] of Object.entries(SENIORITY_LEVELS)) {
    if (t.includes(key)) return level;
  }
  return 0;
}

function inferFunction(title: string): string {
  const t = (title || "").toLowerCase();
  if (/cmo|medical director|clinical development/i.test(t)) return "Clinical";
  if (/clinical|cro|trial|protocol/i.test(t)) return "Clinical";
  if (/cmc|manufacturing|tech.*op|drug product|drug substance|process dev|quality/i.test(t)) return "CMC";
  if (/regulat/i.test(t)) return "Regulatory";
  if (/cso|research|discovery|biology|pharmacol|translational|preclinical/i.test(t)) return "R&D";
  if (/commercial|market|sales|business dev/i.test(t)) return "Commercial";
  return "General";
}

function classifyRole(dm: any, jobs: any[]): RoleClassification {
  const title = dm.headline || dm.current_title || "";
  const tenureMonths = computeTenureMonths(dm.start_date_current_role);

  let tenureBand: "new" | "prime" | "established" | "unknown" = "unknown";
  if (tenureMonths !== null) {
    if (tenureMonths < 6) tenureBand = "new";
    else if (tenureMonths <= 24) tenureBand = "prime";
    else tenureBand = "established";
  }

  const dmSeniority = inferSeniority(title);
  const dmFunction = inferFunction(title);

  // Skip talent prospects — we only care about decision makers
  if (dmSeniority < 2) {
    return {
      classification: "TALENT_PROSPECT",
      roleCategory: "Talent Prospect",
      reasoning: `${title} — below Director level`,
      matchedJobs: [],
      isHiringManager: false,
      tenureMonths,
      tenureBand,
    };
  }

  let roleCategory = "General";
  const ROLE_PATTERNS: Record<string, RegExp[]> = {
    "R&D": [/\b(CSO|Chief Science|Chief Scientific|VP Research|Head of Research|Director.*Research|SVP.*Research|VP.*Discovery|Head of Discovery|VP.*Translational)/i],
    "Clinical": [/\b(CMO|Chief Medical|VP Clinical|Head of Clinical|Clinical.*Director|Director.*Clinical|SVP.*Clinical|Medical Director)/i],
    "CMC": [/\b(VP CMC|Head of CMC|VP.*Tech.*Op|Director.*CMC|Manufacturing|Process Development)/i],
    "Regulatory": [/\b(VP Regulatory|Head of Regulatory|Regulatory.*Director|Director.*Regulatory)/i],
  };

  for (const [cat, patterns] of Object.entries(ROLE_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(title)) { roleCategory = cat; break; }
    }
    if (roleCategory !== "General") break;
  }

  // Match against open jobs
  const nmJobs = jobs.filter((j: any) =>
    j.is_neuromuscular_related === true && daysAgo(j.posted_date || j.created_at) <= 90
  );

  const matchedJobs: MatchedJob[] = [];
  for (const job of nmJobs) {
    const jobFunction = inferFunction(job.job_title);
    const jobSeniority = inferSeniority(job.job_title);
    const seniorityDiff = dmSeniority - jobSeniority;
    const functionMatch = dmFunction === jobFunction || (dmFunction === "General" && jobFunction !== "General") === false;

    if (functionMatch && seniorityDiff >= 0.5 && seniorityDiff <= 2.5) {
      matchedJobs.push({
        jobId: job.job_id,
        jobTitle: job.job_title,
        jobUrl: job.job_url || null,
        jobFunction,
        seniorityDiff,
        location: job.location || null,
        isEnriched: job.is_enriched === true,
        outreachHook: job.outreach_hook || null,
      });
    }
  }

  if (matchedJobs.length > 0) {
    const primary = matchedJobs[0];
    return {
      classification: "HIRING_MANAGER",
      roleCategory: `Decision Maker — ${roleCategory}`,
      reasoning: `${title} is ~${primary.seniorityDiff} levels above open "${primary.jobTitle}" role in ${primary.jobFunction}. Likely hiring manager.`,
      matchedJobTitle: primary.jobTitle,
      matchedJobFunction: primary.jobFunction,
      matchedJobs,
      isHiringManager: true,
      tenureMonths,
      tenureBand,
    };
  }

  if (dmSeniority >= 2.5) {
    return {
      classification: "INFLUENCER",
      roleCategory: `Influencer — ${roleCategory}`,
      reasoning: `${title} is a senior leader (level ${dmSeniority}) at the company. No directly matching open job found — classified as Influencer.`,
      matchedJobs: [],
      isHiringManager: false,
      tenureMonths,
      tenureBand,
    };
  }

  return {
    classification: "INFLUENCER",
    roleCategory: `Influencer — ${roleCategory}`,
    reasoning: `${title} — defaulting to Influencer`,
    matchedJobs: [],
    isHiringManager: false,
    tenureMonths,
    tenureBand,
  };
}

interface Intel {
  dm: any;
  company: any;
  companyId: string | null;
  jobs: any[];
  enrichedJobs: any[];
  confirmedTAJobs: any[];
  assets: any[];
  milestones: any[];
  trials: any[];
  salesTarget: any;
  news: any[];
  roleClassification: RoleClassification;
}

async function gatherIntel(dmId: string, taId: string): Promise<Intel> {
  const { data: dm, error: dmErr } = await supabase
    .from("decision_makers").select("*").eq("dm_id", dmId).single();
  if (dmErr || !dm) throw new Error(`DM not found: ${dmId}`);

  console.log(`[intel] DM: ${dm.full_name} | ${dm.headline} | at ${dm.company_name}`);

  let companyId: string | null = null;
  let company: any = null;
  if (dm.company_name) {
    const companyKey = dm.company_name.split(",")[0].split("/")[0].trim();
    const { data: compData } = await supabase
      .from("companies").select("*")
      .ilike("company_name", `%${companyKey.split(" ")[0]}%`)
      .eq("therapeutic_area_id", taId).limit(1);
    if (compData && compData.length > 0) {
      company = compData[0];
      companyId = company.company_id;
    }
  }

  const companySearchKey = (dm.company_name || "").split(",")[0].split("/")[0].trim().split(" ")[0];

  const [jobsRes, assetsRes, targetRes, newsRes] = await Promise.all([
    supabase.from("job_postings").select("*")
      .ilike("company_name", `%${companySearchKey}%`)
      .eq("therapeutic_area_id", taId)
      .order("is_enriched", { ascending: false })
      .order("created_at", { ascending: false }).limit(10),
    companyId
      ? supabase.from("assets").select("*").eq("company_id", companyId).eq("therapeutic_area_id", taId).limit(10)
      : Promise.resolve({ data: [] }),
    companyId
      ? supabase.from("sales_targets").select("*").eq("company_id", companyId).eq("therapeutic_area_id", taId).limit(1)
      : Promise.resolve({ data: [] }),
    supabase.from("web_intelligence").select("*")
      .eq("therapeutic_area_id", taId)
      .order("created_at", { ascending: false }).limit(5),
  ]);

  const jobs = (jobsRes as any).data ?? [];
  const assets = (assetsRes as any).data ?? [];
  const salesTarget = ((targetRes as any).data ?? [])[0] ?? null;
  const allNews = (newsRes as any).data ?? [];

  const companyLower = companySearchKey.toLowerCase();
  const news = allNews.filter((n: any) => {
    const mentioned = JSON.stringify(n.companies_mentioned || "").toLowerCase();
    const title = (n.title || "").toLowerCase();
    return mentioned.includes(companyLower) || title.includes(companyLower);
  }).slice(0, 3);

  const enrichedJobs = jobs.filter((j: any) => j.is_enriched === true);
  const confirmedTAJobs = enrichedJobs.filter((j: any) => j.confirmed_ta_match === true);

  const assetIds = assets.map((a: any) => a.asset_id);
  let milestones: any[] = [];
  let trials: any[] = [];

  if (assetIds.length > 0) {
    const [msRes, trRes] = await Promise.all([
      supabase.from("milestones").select("*").in("asset_id", assetIds).order("milestone_date", { ascending: true }).limit(8),
      supabase.from("clinical_trials").select("*").in("asset_id", assetIds).eq("therapeutic_area_id", taId).limit(8),
    ]);
    milestones = msRes.data ?? [];
    trials = trRes.data ?? [];
  }

  const roleClassification = classifyRole(dm, jobs);
  console.log(`[classify] ${roleClassification.classification} | ${roleClassification.roleCategory} | ${roleClassification.reasoning}`);

  return { dm, company, companyId, jobs, enrichedJobs, confirmedTAJobs, assets, milestones, trials, salesTarget, news, roleClassification };
}

const PHASE_RANK: Record<string, number> = {
  "Preclinical": 1, "Phase 1": 2, "Phase I": 2, "Phase 1/2": 3, "Phase I/II": 3,
  "Phase 2": 4, "Phase II": 4, "Phase 2/3": 5, "Phase II/III": 5,
  "Phase 3": 6, "Phase III": 6, "Filed": 7, "NDA/BLA Filed": 7,
  "Approved": 8, "Marketed": 8,
};

interface ValueHook {
  hook: string;
  asset?: any;
  milestone?: any;
  job?: any;
  indication?: string;
  stage?: string;
}

function selectValueHook(intel: Intel): ValueHook {
  const { roleClassification, assets, milestones, jobs, enrichedJobs } = intel;
  const cls = roleClassification.classification;

  if (cls === "HIRING_MANAGER" && roleClassification.matchedJobTitle) {
    const job = jobs.find((j: any) => j.job_title === roleClassification.matchedJobTitle) || jobs[0];
    const topAsset = assets.sort((a: any, b: any) => (PHASE_RANK[b.current_phase] ?? 0) - (PHASE_RANK[a.current_phase] ?? 0))[0];
    return {
      hook: `Hiring manager for "${job?.job_title}" — lead with asset knowledge + specialized talent pool`,
      job,
      asset: topAsset,
      indication: topAsset?.indication || undefined,
      stage: topAsset?.current_phase || undefined,
    };
  }

  if (cls === "INFLUENCER") {
    const topAsset = assets
      .sort((a: any, b: any) => (PHASE_RANK[b.current_phase] ?? 0) - (PHASE_RANK[a.current_phase] ?? 0))[0];
    const upcomingMilestone = milestones.find((m: any) => {
      const d = daysUntil(m.milestone_date);
      return d >= 0 && d <= 120;
    });

    if (topAsset) {
      return {
        hook: `Pipeline insight on ${topAsset.asset_name} (${topAsset.current_phase}) — show deep NMD knowledge`,
        asset: topAsset,
        milestone: upcomingMilestone,
        indication: topAsset.indication || undefined,
        stage: topAsset.current_phase || undefined,
      };
    }
    return { hook: "NMD talent ecosystem insight — broad value" };
  }

  return { hook: "Exclusive NMD opportunities" };
}

// ──────────────────────────────────────────────────
// Playbook Fetcher
// ──────────────────────────────────────────────────

interface PlaybookSection {
  section_key: string;
  section_title: string;
  prompt_text: string;
  message_examples: any[];
}

let _playbookCache: { data: PlaybookSection[]; ts: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchPlaybook(): Promise<PlaybookSection[]> {
  if (_playbookCache && (Date.now() - _playbookCache.ts) < CACHE_TTL_MS) {
    return _playbookCache.data;
  }
  const { data, error } = await supabase
    .from("outreach_playbook").select("section_key, section_title, prompt_text, message_examples")
    .eq("active", true).order("sort_order", { ascending: true });
  if (error) { console.error(`[playbook] Failed: ${error.message}`); return []; }
  const sections = data ?? [];
  _playbookCache = { data: sections, ts: Date.now() };
  return sections;
}

function buildPlaybookPromptSupplement(sections: PlaybookSection[]): string {
  if (sections.length === 0) return "";
  return "\n\n# ═══ OUTREACH PLAYBOOK (from database) ═══\n\n" +
    sections.map(s => s.prompt_text).join("\n\n") +
    "\n\n# ═══ END PLAYBOOK ═══";
}

// ──────────────────────────────────────────────────
// SYSTEM PROMPT — complete rewrite based on Solid Bio gold standard
// ──────────────────────────────────────────────────

const BASE_SYSTEM_PROMPT = `You are the outreach intelligence engine for PharmaTalent, a specialized executive search firm focused exclusively on neuromuscular disease (NMD). You write as Julien, co-founder, working closely with Dr. Khan Ozol, PhD (Founder & CEO — a neuroscientist by training).

## YOUR TASK
Generate 4 hyper-personalized outreach messages using REAL DATA from our intelligence platform.

## GOLD STANDARD EXAMPLE
This is what GREAT outreach looks like. Study the STRUCTURE, TONE, and DATA USAGE:

CONNECTION REQUEST (for Bo Cumbo, CEO, Solid Biosciences — asset SGT-212):
"Dear Bo, Super impressed with the early success of Solid Bio under your leadership with critical assets going through early development (SGT-212). I've been keeping a close eye because our work is specialized within the neuromuscular niche. I'd be honored to connect with you on LinkedIn."

FOLLOW-UP 1:
"Bo — thanks for connecting.
I'm reaching out on behalf of Khan Ozol, PhD, Founder & CEO of PharmaTalent (a neuroscientist by training).
We noticed Solid Bio is building out the VP / Head of R&D role, which is obviously a pivotal hire for the company.
Our firm specializes in MD / MD-PhD leadership searches within the neuromuscular development space. We've built a proprietary AI-powered executive intelligence platform that maps the physicians behind the most advanced neuromuscular programs globally.
Combined with 25+ years of executive search experience in life sciences, this allows us to quickly identify the small set of leaders who have actually navigated programs like SGT-212 through critical stages.
If useful, I'd be happy to share a brief perspective on the leadership landscape around this role.
Best regards,
Julien"

## WHAT MAKES THIS GREAT (follow these rules):
1. CONNECTION REQUEST: Leads with a SPECIFIC observation about their company/asset — not generic flattery
2. Shows you're ALREADY watching their space — "I've been keeping a close eye"
3. References a REAL ASSET NAME and its STAGE (SGT-212, early development)
4. FOLLOW-UP: Opens with the matched job title — shows you know what they need
5. Introduces Khan Ozol as the authority figure (neuroscientist by training)
6. Describes what PharmaTalent actually does — "maps the physicians behind the most advanced NMD programs"
7. Connects the asset name back to the value prop — "leaders who have navigated programs like SGT-212"
8. Ends with a VALUE OFFER, not a meeting request — "share a brief perspective"

## MESSAGE SPECIFICATIONS

### Message 1 — Connection Request (STRICT max 280 characters)
- Open with "Dear [FirstName],"
- One SPECIFIC observation about their company + asset/pipeline
- Show you're specialized in NMD — not a generic recruiter
- End with genuine connection intent

### Message 2 — Follow-Up 1 (Day 3-5, 4-6 short paragraphs)
- Open with "[FirstName] — thanks for connecting."
- If HIRING_MANAGER: reference the specific open role by title
- If INFLUENCER: reference their most advanced asset/program
- Introduce "Khan Ozol, PhD, Founder & CEO of PharmaTalent (a neuroscientist by training)"
- Describe our specialization: "MD / MD-PhD leadership searches within the neuromuscular development space"
- Mention our "proprietary AI-powered executive intelligence platform"
- Connect a specific asset name to our value: "leaders who have navigated programs like [ASSET_NAME]"
- End with value offer: "share a brief perspective on the leadership landscape"
- Sign: "Best regards,\\nJulien"

### Message 3 — Follow-Up 2 (Day 7-10, 2-3 paragraphs)
- NEW angle — do NOT repeat Message 2
- Share a specific market data point (pipeline advancement, competitor milestone, regulatory timeline)
- Keep it genuinely useful — something they'd actually want to know
- Mention Dr. Khan Ozol
- Sign: "Best regards,\\nJulien"

### Message 4 — Email (fresh, 5-7 paragraphs)
- Subject line with specific asset or role reference (< 60 chars)
- Full PharmaTalent positioning with Dr. Khan Ozol + LinkedIn (https://www.linkedin.com/in/khanozol/)
- Include differentiators: "18 days average to shortlist", "passive candidates not on LinkedIn job boards", "scientific fit assessment by our neuroscience team"
- Sign: "Best regards,\\nJulien\\nPharmaTalent | NMD Specialist Recruiting\\njulien.k@pharmatalent.com"

## CRITICAL RULES
- EVERY message MUST contain at least ONE specific, verifiable fact from the input (asset name, phase, indication, trial data, job title)
- NEVER start a message with "I" — always lead with the prospect or their company
- NEVER use: "synergy", "leverage", "touch base", "circle back", "I came across your profile", "reaching out because", "hope this finds you well"
- NEVER fabricate data. If a field is null, omit gracefully.
- Dr. Khan Ozol MUST appear in messages 2, 3, and 4
- If NOT a hiring manager: NEVER reference job postings or open roles. Focus on pipeline/expertise.

## CLASSIFICATION-SPECIFIC APPROACH
- HIRING_MANAGER: Lead with the OPEN ROLE by title + your specialized candidate pool for that exact function. Reference the asset their company is developing.
- INFLUENCER: Lead with ASSET KNOWLEDGE — show you understand their pipeline deeply. Position as a thought partner on talent in their space.
- TALENT_PROSPECT: Lead with exclusive confidential opportunities in NMD. Show market intelligence.

## OUTPUT FORMAT (strict JSON, no markdown fences)
{
  "message_invite": "text ≤ 280 chars",
  "message_invite_char_count": integer,
  "message_follow_1": "full DM text",
  "message_follow_2": "full DM text",
  "message_email_subject": "subject line < 60 chars",
  "message_email": "full email body",
  "classification_reasoning": "brief explanation",
  "value_hook": "main angle",
  "data_points_used": ["list of specific facts from input used"],
  "context_summary": "one sentence personalization strategy"
}`;

function buildUserPrompt(intel: Intel, valueHook: ValueHook): string {
  const { dm, company, jobs, enrichedJobs, assets, milestones, trials, salesTarget, news, roleClassification } = intel;
  const companyName = company?.company_name || dm.company_name || "the company";
  const fName = extractFirstName(dm.full_name);

  let p = `Generate 4 personalized outreach messages for this prospect.\n\n`;

  p += `=== PROSPECT PROFILE ===\n`;
  p += `Full name: ${dm.full_name}\nFirst name: ${fName}\n`;
  p += `Title/Headline: ${dm.headline || dm.current_title || "N/A"}\n`;
  p += `Company: ${companyName}\n`;
  if (dm.role_category) p += `Role category: ${dm.role_category}\n`;
  if (dm.location) p += `Location: ${dm.location}\n`;
  if (dm.summary) p += `Background: ${dm.summary.substring(0, 500)}\n`;
  if (dm.profile_category) p += `Degree: ${dm.profile_category}\n`;
  if (dm.indication_specialty) p += `Indication specialty: ${dm.indication_specialty}\n`;
  if (dm.neuromuscular_experience) p += `NMD experience: Yes\n`;
  if (dm.neurology_experience) p += `Neurology experience: Yes\n`;
  if (dm.therapeutic_areas) p += `Therapeutic areas: ${JSON.stringify(dm.therapeutic_areas)}\n`;
  if (dm.years_experience) p += `Years experience: ${dm.years_experience}\n`;
  if (dm.ai_analysis) p += `AI analysis: ${dm.ai_analysis.substring(0, 300)}\n`;
  p += `\n`;

  p += `=== CLASSIFICATION ===\n`;
  p += `Classification: ${roleClassification.classification}\n`;
  p += `Role category: ${roleClassification.roleCategory}\n`;
  p += `Reasoning: ${roleClassification.reasoning}\n`;
  if (roleClassification.tenureMonths !== null) {
    p += `Tenure: ${roleClassification.tenureMonths} months (${roleClassification.tenureBand})\n`;
  }
  if (roleClassification.matchedJobTitle) {
    p += `Matched job posting: "${roleClassification.matchedJobTitle}"\n`;
  }
  p += `\n`;

  p += `=== VALUE HOOK ===\n${valueHook.hook}\n`;
  if (valueHook.indication) p += `Target indication: ${valueHook.indication}\n`;
  if (valueHook.stage) p += `Pipeline stage: ${valueHook.stage}\n`;
  p += `\n`;

  // Job data — only for hiring managers
  if (roleClassification.isHiringManager && (valueHook.job || jobs.length > 0)) {
    p += `=== OPEN ROLES (this person is a HIRING MANAGER) ===\n`;
    if (roleClassification.matchedJobs.length > 0) {
      p += `Matched roles they likely manage:\n`;
      roleClassification.matchedJobs.forEach((mj, i) => {
        p += `  ${i + 1}. ${mj.jobTitle} (${mj.jobFunction}, seniority gap: ${mj.seniorityDiff})`;
        if (mj.location) p += ` — ${mj.location}`;
        if (mj.outreachHook) p += `\n     Hook: ${mj.outreachHook}`;
        p += `\n`;
      });
    }
    const primaryJob = valueHook.job || jobs[0];
    if (primaryJob) {
      p += `Primary role: ${primaryJob.job_title}\n`;
      if (primaryJob.location) p += `Location: ${primaryJob.location}\n`;
      if (primaryJob.posted_date) p += `Posted: ${primaryJob.posted_date} (${daysAgo(primaryJob.posted_date)} days ago)\n`;
      if (primaryJob.is_enriched) {
        if (primaryJob.required_qualifications) p += `Qualifications: ${primaryJob.required_qualifications}\n`;
        if (primaryJob.enrichment_summary) p += `Role context: ${primaryJob.enrichment_summary}\n`;
        if (primaryJob.outreach_hook) p += `Outreach hook: ${primaryJob.outreach_hook}\n`;
      }
    }
    p += `\n`;
  } else {
    p += `=== NOTE: NOT a hiring manager. Do NOT reference any job postings. Focus on pipeline/expertise. ===\n\n`;
  }

  // Pipeline data
  if (assets.length > 0) {
    p += `=== COMPANY PIPELINE (${companyName}) ===\n`;
    assets.slice(0, 6).forEach((a: any) => {
      p += `  - ${a.asset_name || a.generic_name}: ${a.current_phase}, indication: ${a.indication || "NMD"}, modality: ${a.modality || "N/A"}\n`;
    });
    p += `\n`;
  }

  if (milestones.length > 0) {
    p += `=== MILESTONES ===\n`;
    milestones.slice(0, 4).forEach((m: any) => {
      p += `  - ${m.milestone_type || m.description}: ${m.milestone_date}\n`;
    });
    p += `\n`;
  }

  if (trials.length > 0) {
    p += `=== CLINICAL TRIALS ===\n`;
    trials.slice(0, 4).forEach((t: any) => {
      p += `  - ${t.nct_id}: ${t.trial_phase}, ${t.trial_status}, enrollment: ${t.enrollment || "N/A"}\n`;
    });
    p += `\n`;
  }

  if (salesTarget) {
    p += `=== HIRING INTELLIGENCE ===\n`;
    p += `Hiring urgency: ${salesTarget.hiring_urgency_score}/10\n`;
    if (salesTarget.target_roles) p += `Target roles: ${JSON.stringify(salesTarget.target_roles)}\n`;
    if (salesTarget.outreach_angle) p += `Recommended angle: ${salesTarget.outreach_angle}\n`;
    p += `\n`;
  }

  if (news.length > 0) {
    p += `=== RECENT NEWS ===\n`;
    news.slice(0, 2).forEach((n: any) => { p += `  - ${n.title}\n`; });
    p += `\n`;
  }

  return p;
}

async function callOpenAI(systemPrompt: string, userPrompt: string): Promise<any> {
  console.log(`[openai] Calling ${OPENAI_MODEL}, system: ${systemPrompt.length} chars, user: ${userPrompt.length} chars`);
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 4000,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  let content = data.choices?.[0]?.message?.content || "";
  const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) content = fenceMatch[1].trim();
  return JSON.parse(content);
}

interface QCResult {
  passed: boolean;
  issues: string[];
  fixes: string[];
}

function qualityControl(messages: any, classification: Classification): QCResult {
  const issues: string[] = [];
  const fixes: string[] = [];

  // Invite length check
  if (messages.message_invite && messages.message_invite.length > 280) {
    issues.push(`Invite is ${messages.message_invite.length} chars (max 280)`);
    messages.message_invite = messages.message_invite.substring(0, 277) + "...";
    fixes.push("Truncated invite to 280 chars");
  }

  const allText = [
    messages.message_invite, messages.message_follow_1,
    messages.message_follow_2, messages.message_email, messages.message_email_subject
  ].join(" ");

  // Placeholder check
  const placeholderMatch = allText.match(/\[([A-Z_]+)\]/g);
  if (placeholderMatch) {
    issues.push(`Unfilled placeholders: ${placeholderMatch.join(", ")}`);
  }

  // Banned words
  const bannedWords = ["synergy", "leverage", "touch base", "circle back", "hope this finds you"];
  for (const word of bannedWords) {
    if (allText.toLowerCase().includes(word)) {
      issues.push(`Banned phrase found: "${word}"`);
    }
  }

  // Khan Ozol check in follow-ups and email
  const khanFields = ["message_follow_1", "message_follow_2", "message_email"];
  for (const field of khanFields) {
    if (messages[field] && !messages[field].toLowerCase().includes("khan")) {
      issues.push(`Dr. Khan Ozol missing from ${field}`);
    }
  }

  // Email subject length
  if (messages.message_email_subject && messages.message_email_subject.length > 60) {
    issues.push(`Email subject is ${messages.message_email_subject.length} chars (max 60)`);
    messages.message_email_subject = messages.message_email_subject.substring(0, 57) + "...";
    fixes.push("Truncated email subject");
  }

  // Data points check — must have at least 1 real fact
  const dataPoints = messages.data_points_used || [];
  if (dataPoints.length === 0) {
    issues.push("No specific data points referenced in messages");
  }

  return { passed: issues.length === 0, issues, fixes };
}

async function saveOutreach(
  dm: any, taId: string, companyId: string | null,
  messages: any, roleClassification: RoleClassification, valueHook: ValueHook, qc: QCResult
) {
  const { data: existing } = await supabase
    .from("outreach_campaigns").select("campaign_id")
    .eq("dm_id", dm.dm_id).eq("therapeutic_area_id", taId).limit(1);

  const record: any = {
    dm_id: dm.dm_id,
    therapeutic_area_id: taId,
    dm_name: dm.full_name,
    dm_headline: dm.headline,
    dm_company: dm.company_name,
    dm_linkedin_url: dm.profile_url,
    message_invite: messages.message_invite,
    message_follow_1: messages.message_follow_1,
    message_follow_2: messages.message_follow_2,
    message_email: messages.message_email,
    message_email_subject: messages.message_email_subject,
    classification: roleClassification.classification,
    classification_reasoning: messages.classification_reasoning || roleClassification.reasoning,
    value_hook: messages.value_hook || valueHook.hook,
    data_points_used: messages.data_points_used || [],
    priority_tier: roleClassification.classification === "HIRING_MANAGER" ? 1 :
                   roleClassification.classification === "INFLUENCER" ? 2 : 3,
    personalization_strategy: messages.context_summary || roleClassification.reasoning,
    khan_signal_used_in: "follow_1,follow_2,email",
    context_summary: messages.context_summary,
    context_asset_names: valueHook.asset ? [valueHook.asset.asset_name || valueHook.asset.generic_name] : null,
    context_job_titles: roleClassification.matchedJobTitle ? [roleClassification.matchedJobTitle] : null,
    current_stage: "draft",
    is_potential_hiring_manager: roleClassification.isHiringManager,
    matched_job_ids: roleClassification.matchedJobs.length > 0
      ? roleClassification.matchedJobs.map(j => j.jobId) : null,
    matched_job_titles: roleClassification.matchedJobs.length > 0
      ? roleClassification.matchedJobs.map(j => j.jobTitle) : null,
    matched_job_urls: roleClassification.matchedJobs.length > 0
      ? roleClassification.matchedJobs.map(j => j.jobUrl).filter(Boolean) : null,
    job_match_reasoning: roleClassification.isHiringManager ? roleClassification.reasoning : null,
  };

  await supabase.from("decision_makers").update({
    is_potential_hiring_manager: roleClassification.isHiringManager,
    matched_job_id: roleClassification.matchedJobs.length > 0 ? roleClassification.matchedJobs[0].jobId : null,
  }).eq("dm_id", dm.dm_id);

  if (existing && existing.length > 0) {
    const { data, error } = await supabase
      .from("outreach_campaigns").update(record)
      .eq("campaign_id", existing[0].campaign_id).select().single();
    if (error) throw new Error(`Update failed: ${error.message}`);
    return data;
  } else {
    const { data, error } = await supabase
      .from("outreach_campaigns").insert(record).select().single();
    if (error) throw new Error(`Insert failed: ${error.message}`);
    return data;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    let dmId = ""; let taId = "";
    if (req.method === "GET") {
      const url = new URL(req.url);
      dmId = url.searchParams.get("dm_id") || "";
      taId = url.searchParams.get("ta_id") || "";
    } else {
      const body = await req.json();
      dmId = body.dm_id || ""; taId = body.ta_id || "";
    }

    if (!dmId) return err("Missing dm_id");
    if (!taId) return err("Missing ta_id");
    if (!OPENAI_API_KEY) return err("OPENAI_API_KEY not configured", 500);

    console.log(`\n========================================`);
    console.log(`[generate-outreach v10] START dm_id=${dmId}`);
    console.log(`========================================`);

    const [playbookSections, intel] = await Promise.all([
      fetchPlaybook(),
      gatherIntel(dmId, taId),
    ]);

    const valueHook = selectValueHook(intel);
    console.log(`[value] Hook: ${valueHook.hook}`);

    const playbookSupplement = buildPlaybookPromptSupplement(playbookSections);
    const systemPrompt = BASE_SYSTEM_PROMPT + playbookSupplement;
    const userPrompt = buildUserPrompt(intel, valueHook);
    console.log(`[prompt] System: ${systemPrompt.length} chars, User: ${userPrompt.length} chars`);

    const messages = await callOpenAI(systemPrompt, userPrompt);

    const qc = qualityControl(messages, intel.roleClassification.classification);
    if (qc.issues.length > 0) {
      console.warn(`[qc] Issues: ${qc.issues.join("; ")}`);
    }

    const campaign = await saveOutreach(
      intel.dm, taId, intel.companyId, messages,
      intel.roleClassification, valueHook, qc
    );

    console.log(`[generate-outreach v10] DONE campaign=${campaign.campaign_id}`);

    return ok({
      success: true,
      campaign_id: campaign.campaign_id,
      version: 10,
      playbook_sections_loaded: playbookSections.length,
      classification: intel.roleClassification.classification,
      role_category: intel.roleClassification.roleCategory,
      classification_reasoning: intel.roleClassification.reasoning,
      tenure_months: intel.roleClassification.tenureMonths,
      tenure_band: intel.roleClassification.tenureBand,
      is_hiring_manager: intel.roleClassification.isHiringManager,
      matched_jobs: intel.roleClassification.matchedJobs,
      value_hook: valueHook.hook,
      messages: {
        invite: messages.message_invite,
        invite_chars: messages.message_invite?.length || 0,
        follow_1: messages.message_follow_1,
        follow_2: messages.message_follow_2,
        email_subject: messages.message_email_subject,
        email: messages.message_email,
      },
      qc: { passed: qc.passed, issues: qc.issues, fixes: qc.fixes },
      personalization: messages.context_summary,
      data_points_used: messages.data_points_used,
      intel_summary: {
        jobs_found: intel.jobs.length,
        enriched_jobs: intel.enrichedJobs.length,
        confirmed_ta_jobs: intel.confirmedTAJobs.length,
        assets_found: intel.assets.length,
        milestones_found: intel.milestones.length,
        trials_found: intel.trials.length,
        has_sales_target: !!intel.salesTarget,
        news_found: intel.news.length,
      },
    });
  } catch (error) {
    console.error(`[generate-outreach v10] ERROR: ${(error as Error).message}`);
    return err((error as Error).message || "Internal server error", 500);
  }
});
