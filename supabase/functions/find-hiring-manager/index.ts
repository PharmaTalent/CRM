// find-hiring-manager v1 — Smart hiring manager discovery per job posting
//
// Given a job posting, this function:
// 1. Analyzes the job title with GPT-4o to determine WHO would be the hiring manager
// 2. Extracts smart LinkedIn search keywords (the boss, not the role itself)
// 3. Searches LinkedIn via RapidAPI at the same company
// 4. Enriches top profiles with full LinkedIn data
// 5. GPT-4o selects the 3-4 best hiring manager candidates
// 6. Saves to decision_makers with is_potential_hiring_manager = true

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RAPIDAPI_KEY = "f45a346ac4msh311e9852a348febp118ba0jsn626e1a8c9d09";
const RAPIDAPI_HOST = "real-time-people-company-data.p.rapidapi.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeCompanyName(name: string): string {
  return name
    .replace(
      /\b(Inc\.?|LLC|Ltd\.?|Corp\.?|Corporation|Incorporated|Company|Co\.?|Pharmaceuticals?|Therapeutics?|Biosciences?|Biopharma|Biotech(nology)?|Sciences?|Medical|Healthcare|Health|Group|Holdings?|International|Global|Plc\.?|S\.?A\.?|GmbH|AG|N\.?V\.?|SE|S\.?p\.?A\.?)\b/gi,
      ""
    )
    .replace(/[,.\-()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLinkedInUsername(profileURL?: string): string {
  if (!profileURL) return "";
  const match = profileURL.match(/linkedin\.com\/in\/([a-zA-Z0-9\-]+)/i);
  return match ? match[1] : profileURL;
}

// ============================================================================
// STAGE 1: ANALYZE JOB TITLE → EXTRACT HIRING MANAGER SEARCH KEYWORDS
// ============================================================================

interface HiringManagerKeywords {
  search_queries: string[];     // LinkedIn keywordTitle values to search
  reasoning: string;            // Why these keywords
  expected_title_patterns: string[]; // What the hiring manager's title likely looks like
  seniority_level: string;      // Expected seniority of the hiring manager
}

async function analyzeJobForHiringManager(
  jobTitle: string,
  jobDescription: string,
  companyName: string,
  seniorityLevel: string
): Promise<HiringManagerKeywords> {
  console.log(`[STAGE 1] Analyzing job title: "${jobTitle}" at ${companyName}`);

  const prompt = `You are an expert pharmaceutical recruiter. Given a job posting, determine WHO would be the HIRING MANAGER — the person's direct boss who posted this role and will make the hiring decision.

JOB TITLE: ${jobTitle}
COMPANY: ${companyName}
SENIORITY LEVEL: ${seniorityLevel || "Not specified"}
DESCRIPTION (excerpt): ${(jobDescription || "").slice(0, 1500)}

RULES:
1. The hiring manager is typically ONE LEVEL ABOVE the role being hired
2. Think about the DEPARTMENT and FUNCTION, not just seniority
3. Extract keywords that would find the BOSS on LinkedIn at this company

EXAMPLES:
- "DMD Asset Head" → search for: "Head of Neurology", "VP Neuromuscular", "Head of R&D" (the boss oversees the whole neurology/NMD program)
- "Head of Research Neurology" → search for: "VP R&D", "SVP Research", "Head of R&D", "CSO" (their boss runs all of R&D)
- "Senior Director CMC" → search for: "VP CMC", "VP Technical Operations", "Head of CMC", "SVP Manufacturing" (CMC leadership)
- "Director Clinical Operations" → search for: "VP Clinical Development", "Head of Clinical Operations", "SVP Clinical" (clinical leadership)
- "VP Neuromuscular" → search for: "CSO", "CMO", "Head of R&D", "President R&D" (C-suite oversees VPs)
- "Medical Director Neurology" → search for: "VP Medical Affairs", "Head of Medical", "VP Clinical Development" (medical leadership)
- "Associate Director Regulatory" → search for: "Director Regulatory", "VP Regulatory", "Head of Regulatory" (regulatory chain)

Return JSON:
{
  "search_queries": ["keyword1", "keyword2", "keyword3", "keyword4"],
  "reasoning": "Brief explanation of why these are the right search terms",
  "expected_title_patterns": ["VP of X", "Head of Y"],
  "seniority_level": "C-suite | SVP | VP | Senior Director | Director"
}

IMPORTANT:
- Return 3-5 search queries, from most specific to broadest
- Include disease-area keywords when relevant (e.g., "neurology", "neuromuscular", "DMD")
- For biotech roles, also search C-suite (CEO, CSO, CMO) as they often directly hire
- The queries should find the BOSS, not the role itself`;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "You are a pharmaceutical recruiting expert. Return valid JSON only." },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        max_tokens: 1000,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) throw new Error(`OpenAI returned ${response.status}`);

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(content);

    console.log(`[STAGE 1] Search queries: ${JSON.stringify(parsed.search_queries)}`);
    console.log(`[STAGE 1] Reasoning: ${parsed.reasoning}`);

    return parsed as HiringManagerKeywords;
  } catch (error) {
    console.error("[STAGE 1] AI analysis error:", error);
    // Fallback: generic boss-level searches
    return {
      search_queries: ["VP", "Head of", "SVP", "Director"],
      reasoning: "Fallback — AI analysis failed",
      expected_title_patterns: ["VP", "Head", "SVP"],
      seniority_level: "VP",
    };
  }
}

// ============================================================================
// STAGE 2: SEARCH LINKEDIN FOR POTENTIAL HIRING MANAGERS
// ============================================================================

interface LinkedInPerson {
  fullName: string;
  headline: string;
  profileURL: string;
  profilePicture?: string;
  location?: string;
  summary?: string;
  searchQuery: string;
}

async function searchLinkedIn(
  normalizedCompany: string,
  keywordTitle: string,
  start: number = 0
): Promise<{ people: LinkedInPerson[]; total: number }> {
  const url = new URL(`https://${RAPIDAPI_HOST}/search-people`);
  url.searchParams.set("company", normalizedCompany);
  if (keywordTitle) url.searchParams.set("keywordTitle", keywordTitle);
  url.searchParams.set("start", start.toString());

  console.log(`[STAGE 2] Searching: company="${normalizedCompany}", keyword="${keywordTitle}"`);

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "x-rapidapi-key": RAPIDAPI_KEY,
        "x-rapidapi-host": RAPIDAPI_HOST,
      },
    });

    if (!response.ok) {
      console.warn(`[STAGE 2] RapidAPI returned ${response.status}`);
      return { people: [], total: 0 };
    }

    const data = await response.json();
    const items = data?.data?.items || data?.items || data?.data?.data?.items || [];
    const total = data?.data?.total ?? data?.total ?? items.length;

    const parsed = items
      .filter((item: Record<string, string>) => item.fullName && item.profileURL)
      .map((item: Record<string, string>) => ({
        fullName: item.fullName,
        headline: item.headline || "",
        profileURL: item.profileURL,
        profilePicture: item.profilePicture,
        location: item.location,
        summary: item.summary,
        searchQuery: keywordTitle,
      } as LinkedInPerson));

    console.log(`[STAGE 2] Found ${parsed.length} people for "${keywordTitle}"`);
    return { people: parsed, total };
  } catch (error) {
    console.error(`[STAGE 2] Search error for "${keywordTitle}":`, error);
    return { people: [], total: 0 };
  }
}

async function searchAllQueries(
  normalizedCompany: string,
  queries: string[]
): Promise<LinkedInPerson[]> {
  const allPeople = new Map<string, LinkedInPerson>();

  // Run searches in parallel batches of 3
  const BATCH_SIZE = 3;
  for (let i = 0; i < queries.length; i += BATCH_SIZE) {
    const batch = queries.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(async (query) => {
        const { people, total } = await searchLinkedIn(normalizedCompany, query);

        // If more results, fetch page 2
        if (total > 10) {
          await delay(50);
          const { people: page2 } = await searchLinkedIn(normalizedCompany, query, 10);
          return [...people, ...page2];
        }
        return people;
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        for (const person of result.value) {
          const key = extractLinkedInUsername(person.profileURL);
          if (key && !allPeople.has(key)) {
            allPeople.set(key, person);
          }
        }
      }
    }

    if (i + BATCH_SIZE < queries.length) await delay(80);
  }

  // Also do a broad C-suite search for biotechs (they often hire directly)
  const csuiteBatch = ["CEO", "CSO", "CMO"];
  const csuiteResults = await Promise.allSettled(
    csuiteBatch.map(title => searchLinkedIn(normalizedCompany, title))
  );
  for (const result of csuiteResults) {
    if (result.status === "fulfilled") {
      for (const person of result.value.people) {
        const key = extractLinkedInUsername(person.profileURL);
        if (key && !allPeople.has(key)) {
          allPeople.set(key, person);
        }
      }
    }
  }

  console.log(`[STAGE 2] Total unique candidates: ${allPeople.size}`);
  return Array.from(allPeople.values());
}

// ============================================================================
// STAGE 3: ENRICH TOP CANDIDATES WITH FULL LINKEDIN PROFILE
// ============================================================================

interface EnrichedCandidate {
  person: LinkedInPerson;
  profileData: Record<string, unknown>;
  current_title: string;
  current_company: string;
  seniority_level: string;
  years_experience: number;
  therapeutic_areas: string[];
  key_skills: string[];
  ai_analysis: string;
  ai_fit_score: number;
}

async function enrichProfile(person: LinkedInPerson): Promise<Record<string, unknown> | null> {
  console.log(`[STAGE 3] Enriching: ${person.fullName}`);

  try {
    const url = new URL(`https://${RAPIDAPI_HOST}/get-profile-data-by-url`);
    url.searchParams.set("url", person.profileURL);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "x-rapidapi-key": RAPIDAPI_KEY,
        "x-rapidapi-host": RAPIDAPI_HOST,
      },
    });

    if (!response.ok) {
      console.warn(`[STAGE 3] Failed to fetch profile for ${person.fullName}: ${response.status}`);
      return null;
    }

    const data = await response.json();
    return data?.data || data;
  } catch (error) {
    console.error(`[STAGE 3] Enrichment error for ${person.fullName}:`, error);
    return null;
  }
}

// ============================================================================
// STAGE 4: AI SELECTION — PICK THE 3-4 BEST HIRING MANAGER CANDIDATES
// ============================================================================

interface HiringManagerResult {
  fullName: string;
  profileURL: string;
  headline: string;
  current_title: string;
  current_company: string;
  seniority_level: string;
  years_experience: number;
  therapeutic_areas: string[];
  key_skills: string[];
  confidence_score: number;  // 0-100
  reasoning: string;
  hiring_manager_signals: string[];
  outreach_hook: string;
  ai_analysis: string;
  ai_fit_score: number;
  role_category: string;
  neuromuscular_experience: boolean;
  neurology_experience: boolean;
  clinical_trials_experience: boolean;
  leadership_experience: boolean;
  career_highlights: string;
  education: Array<{ degree: string; field: string; school: string }>;
}

async function selectHiringManagers(
  jobTitle: string,
  jobDescription: string,
  companyName: string,
  seniorityLevel: string,
  keywords: HiringManagerKeywords,
  candidates: Array<{ person: LinkedInPerson; profile: Record<string, unknown> }>
): Promise<HiringManagerResult[]> {
  console.log(`[STAGE 4] AI selecting hiring managers from ${candidates.length} enriched candidates`);

  const candidateProfiles = candidates.map((c, idx) => `
[CANDIDATE-${idx}]
  Name: ${c.person.fullName}
  Headline: ${c.person.headline}
  LinkedIn: ${c.person.profileURL}
  Location: ${c.person.location || "Unknown"}
  Found via search: "${c.person.searchQuery}"
  Profile data: ${JSON.stringify(c.profile, null, 1).slice(0, 2000)}
`).join("\n");

  const prompt = `You are a senior pharmaceutical recruiting analyst. Given a job posting, select the 3-4 people most likely to be the HIRING MANAGER for this role.

JOB POSTING:
- Title: ${jobTitle}
- Company: ${companyName}
- Seniority: ${seniorityLevel || "Not specified"}
- Description: ${(jobDescription || "").slice(0, 1000)}

ANALYSIS (from Stage 1):
- Expected hiring manager profile: ${keywords.reasoning}
- Expected title patterns: ${keywords.expected_title_patterns.join(", ")}
- Expected seniority: ${keywords.seniority_level}

CANDIDATES:
${candidateProfiles}

SELECT the 3-4 best hiring manager candidates. For EACH, return:
{
  "fullName": "exact name",
  "profileURL": "exact LinkedIn URL",
  "headline": "their headline",
  "current_title": "their current title",
  "current_company": "their current company",
  "seniority_level": "C-suite | SVP | VP | Senior Director | Director | Associate Director",
  "years_experience": integer,
  "therapeutic_areas": ["area1", "area2"],
  "key_skills": ["skill1", "skill2"],
  "confidence_score": 0-100,
  "reasoning": "2-3 sentences on WHY this person is likely the hiring manager for this specific role",
  "hiring_manager_signals": ["signal1", "signal2"],
  "outreach_hook": "One sentence connecting their role to PharmaTalent's NMD talent expertise",
  "ai_analysis": "3-4 sentences analyzing their profile in the context of neuromuscular disease recruitment",
  "ai_fit_score": 1-10,
  "role_category": "c_suite | vp_leadership | director | associate_director | other",
  "neuromuscular_experience": boolean,
  "neurology_experience": boolean,
  "clinical_trials_experience": boolean,
  "leadership_experience": boolean,
  "career_highlights": "2-3 sentences on their relevant career achievements",
  "education": [{"degree": "...", "field": "...", "school": "..."}]
}

SCORING:
- 90-100: Almost certainly THE hiring manager (right department, one level up, same company)
- 75-89: Very likely involved in hiring decision (same function, senior enough)
- 60-74: Probably influences this hire (adjacent function, C-suite at biotech)
- Below 60: Don't include

IMPORTANT:
- The hiring manager is the BOSS of the person being hired, not a peer
- At biotechs (<100 people), C-suite often directly hires VPs/Directors
- At big pharma, hiring managers are typically 1 level up in the same function
- If the role is "Head of X", look for "VP of X" or "SVP" or C-suite
- If the role is "Director of X", look for "VP of X" or "Head of X"

Return a JSON object: { "hiring_managers": [...] }`;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "You are a pharmaceutical recruiting expert selecting hiring managers. Return valid JSON only." },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 4000,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) throw new Error(`OpenAI returned ${response.status}`);

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(content);
    const managers = parsed.hiring_managers || parsed.results || [];

    console.log(`[STAGE 4] Selected ${managers.length} hiring managers`);
    return managers.filter((m: HiringManagerResult) => m.confidence_score >= 60);
  } catch (error) {
    console.error("[STAGE 4] AI selection error:", error);
    return [];
  }
}

// ============================================================================
// STAGE 5: SAVE TO DATABASE
// ============================================================================

async function saveHiringManagers(
  supabase: ReturnType<typeof createClient>,
  companyName: string,
  taId: string,
  jobId: string,
  managers: HiringManagerResult[]
): Promise<{ saved: number; errors: number }> {
  console.log(`[STAGE 5] Saving ${managers.length} hiring managers to database`);

  let saved = 0;
  let errors = 0;

  const records = managers.map(m => ({
    dm_id: crypto.randomUUID(),
    company_name: companyName,
    therapeutic_area_id: taId,
    full_name: m.fullName,
    headline: m.headline,
    profile_url: m.profileURL,
    username: extractLinkedInUsername(m.profileURL),
    relevance_score: Math.max(1, Math.min(10, Math.round(m.confidence_score / 10))),
    role_category: m.role_category || "vp_leadership",
    search_round: "hiring_manager_search",
    source_query: `hiring_manager_for_job_${jobId}`,
    is_enriched: true,
    enriched_at: new Date().toISOString(),
    current_title: m.current_title,
    current_company: m.current_company,
    seniority_level: m.seniority_level,
    years_experience: m.years_experience,
    education: m.education || [],
    clinical_trials_experience: m.clinical_trials_experience || false,
    leadership_experience: m.leadership_experience || true,
    neuromuscular_experience: m.neuromuscular_experience || false,
    neurology_experience: m.neurology_experience || false,
    therapeutic_areas: m.therapeutic_areas || [],
    key_skills: m.key_skills || [],
    career_highlights: m.career_highlights || "",
    ai_analysis: m.ai_analysis || m.reasoning,
    ai_fit_score: Math.max(1, Math.min(10, m.ai_fit_score || Math.round(m.confidence_score / 10))),
    outreach_hook: m.outreach_hook || "",
    is_potential_hiring_manager: true,
    matched_job_id: jobId,
  }));

  try {
    const { error } = await supabase
      .from("decision_makers")
      .upsert(records, { onConflict: "profile_url" });

    if (error) {
      console.error(`[STAGE 5] Upsert error:`, JSON.stringify(error));
      errors = records.length;
    } else {
      saved = records.length;
      console.log(`[STAGE 5] Saved ${saved} hiring managers`);
    }
  } catch (error) {
    console.error(`[STAGE 5] Exception:`, error);
    errors = records.length;
  }

  return { saved, errors };
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body = await req.json();
    const {
      job_id,
      therapeutic_area_id,
      max_candidates = 4,   // how many hiring managers to return
      enrich_top = 15,      // how many LinkedIn profiles to enrich before AI selection
      dry_run = false,
    } = body;

    if (!job_id || !therapeutic_area_id) {
      return new Response(JSON.stringify({ error: "job_id and therapeutic_area_id are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[MAIN] find-hiring-manager v1 — job_id=${job_id}, ta_id=${therapeutic_area_id}`);

    // ── Fetch the job posting ────────────────────────────────────────
    const { data: job, error: jobErr } = await supabase
      .from("job_postings")
      .select("*")
      .eq("job_id", job_id)
      .single();

    if (jobErr || !job) {
      return new Response(JSON.stringify({ error: `Job not found: ${jobErr?.message || "unknown"}` }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[MAIN] Job: "${job.job_title}" at ${job.company_name}`);

    const normalizedCompany = normalizeCompanyName(job.company_name);

    // ── Stage 1: Analyze job → extract search keywords ───────────────
    const keywords = await analyzeJobForHiringManager(
      job.job_title,
      job.full_description || job.enrichment_summary || "",
      job.company_name,
      job.seniority_level || ""
    );

    // ── Stage 2: Search LinkedIn ─────────────────────────────────────
    const allCandidates = await searchAllQueries(normalizedCompany, keywords.search_queries);

    if (allCandidates.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        version: 1,
        message: "No candidates found on LinkedIn",
        job_title: job.job_title,
        company: job.company_name,
        search_queries: keywords.search_queries,
        hiring_managers: [],
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Stage 3: Pre-filter with GPT + Enrich top candidates ─────────
    // Quick AI pre-filter to pick best candidates for enrichment
    const preFilterPrompt = `Given these LinkedIn profiles found at ${job.company_name}, which ones are most likely to be the HIRING MANAGER for "${job.job_title}" (${job.seniority_level || "unknown seniority"})?

We expect the hiring manager to have a title like: ${keywords.expected_title_patterns.join(", ")}
Expected seniority: ${keywords.seniority_level}

Candidates:
${allCandidates.map((c, i) => `${i}. ${c.fullName} — ${c.headline} (found via: "${c.searchQuery}")`).join("\n")}

Return JSON: { "selected_indices": [0, 3, 5, ...] } — select up to ${enrich_top} candidates most likely to be the hiring manager. Prioritize:
1. People at the SAME company (${job.company_name})
2. People ONE LEVEL ABOVE the role "${job.job_title}"
3. People in the same department/function`;

    let selectedIndices: number[] = [];
    try {
      const pfResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [
            { role: "system", content: "You select the best hiring manager candidates. Return valid JSON only." },
            { role: "user", content: preFilterPrompt },
          ],
          temperature: 0,
          max_tokens: 500,
          response_format: { type: "json_object" },
        }),
      });

      if (pfResponse.ok) {
        const pfData = await pfResponse.json();
        const pfContent = pfData.choices?.[0]?.message?.content || "{}";
        const pfParsed = JSON.parse(pfContent);
        selectedIndices = (pfParsed.selected_indices || [])
          .filter((i: number) => i >= 0 && i < allCandidates.length)
          .slice(0, enrich_top);
      }
    } catch (e) {
      console.warn("[STAGE 3] Pre-filter failed, using all candidates");
    }

    // Fallback: take first N candidates
    if (selectedIndices.length === 0) {
      selectedIndices = allCandidates.map((_, i) => i).slice(0, enrich_top);
    }

    const toEnrich = selectedIndices.map(i => allCandidates[i]);
    console.log(`[STAGE 3] Enriching ${toEnrich.length} candidates`);

    // Enrich in parallel batches of 3
    const enrichedCandidates: Array<{ person: LinkedInPerson; profile: Record<string, unknown> }> = [];
    const ENRICH_BATCH = 3;
    for (let i = 0; i < toEnrich.length; i += ENRICH_BATCH) {
      const batch = toEnrich.slice(i, i + ENRICH_BATCH);
      const results = await Promise.allSettled(batch.map(p => enrichProfile(p)));

      for (let j = 0; j < results.length; j++) {
        if (results[j].status === "fulfilled" && (results[j] as PromiseFulfilledResult<Record<string, unknown> | null>).value) {
          enrichedCandidates.push({
            person: batch[j],
            profile: (results[j] as PromiseFulfilledResult<Record<string, unknown>>).value,
          });
        }
      }

      if (i + ENRICH_BATCH < toEnrich.length) await delay(100);
    }

    console.log(`[STAGE 3] Successfully enriched ${enrichedCandidates.length} candidates`);

    if (enrichedCandidates.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        version: 1,
        message: "Found candidates but enrichment failed",
        job_title: job.job_title,
        company: job.company_name,
        candidates_found: allCandidates.length,
        hiring_managers: [],
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Stage 4: AI selection of best hiring managers ─────────────────
    const hiringManagers = await selectHiringManagers(
      job.job_title,
      job.full_description || job.enrichment_summary || "",
      job.company_name,
      job.seniority_level || "",
      keywords,
      enrichedCandidates
    );

    // Limit to max_candidates
    const topManagers = hiringManagers.slice(0, max_candidates);

    // ── Stage 5: Save to database ────────────────────────────────────
    let saveResult = { saved: 0, errors: 0 };
    if (!dry_run && topManagers.length > 0) {
      saveResult = await saveHiringManagers(
        supabase,
        job.company_name,
        therapeutic_area_id,
        job_id,
        topManagers
      );
    }

    // ── Diagnostics ──────────────────────────────────────────────────
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    try {
      await supabase.from("edge_function_diagnostics").insert({
        function_name: "find-hiring-manager",
        version: 1,
        company_name: job.company_name,
        diagnostics: {
          job_id,
          job_title: job.job_title,
          search_queries: keywords.search_queries,
          reasoning: keywords.reasoning,
          candidates_found: allCandidates.length,
          candidates_enriched: enrichedCandidates.length,
          hiring_managers_selected: topManagers.length,
          saved: saveResult,
          duration_seconds: parseFloat(duration),
        },
      });
    } catch (e) {
      console.error("[DIAG] Failed to save diagnostics:", e);
    }

    console.log(`[MAIN] Complete. Found ${topManagers.length} hiring managers in ${duration}s`);

    return new Response(JSON.stringify({
      success: true,
      version: 1,
      dry_run,
      job: {
        job_id: job.job_id,
        job_title: job.job_title,
        company: job.company_name,
        seniority: job.seniority_level,
      },
      analysis: {
        search_queries: keywords.search_queries,
        reasoning: keywords.reasoning,
        expected_titles: keywords.expected_title_patterns,
        expected_seniority: keywords.seniority_level,
      },
      pipeline: {
        candidates_found: allCandidates.length,
        candidates_enriched: enrichedCandidates.length,
        hiring_managers_selected: topManagers.length,
        saved: saveResult,
      },
      hiring_managers: topManagers.map(m => ({
        name: m.fullName,
        title: m.current_title || m.headline,
        company: m.current_company,
        confidence: m.confidence_score,
        reasoning: m.reasoning,
        signals: m.hiring_manager_signals,
        seniority: m.seniority_level,
        profile_url: m.profileURL,
      })),
      duration_seconds: parseFloat(duration),
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[MAIN] Fatal error:", err);
    return new Response(JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
      version: 1,
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
